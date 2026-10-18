//! 参数优化：网格搜索。
//!
//! 设计取舍：
//! - 只做**网格搜索**，不做贝叶斯/遗传算法。理由：网格结果可复现、可解释，
//!   且回测本身很快（纯内存计算），对个人投资者足够；
//! - 每个候选参数组合都跑一遍完整回测（含费用、T+1），保证结果与单次回测口径一致；
//! - 组合数上限 `MAX_COMBOS`，防止前端误传超大空间把手机端卡死；
//! - 目标函数支持多种口径，默认夏普。会同时返回「过拟合提示」：
//!   若最优参数位于搜索边界，说明真实最优可能在区间之外。

use crate::backtest::Runner;
use crate::strategies;
use crate::types::{BacktestConfig, Bar, Metrics, Params};

/// 单次优化允许的最大参数组合数。
pub const MAX_COMBOS: usize = 500;

/// 优化目标。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Objective {
    /// 夏普比率
    Sharpe,
    /// 累计收益率
    TotalReturn,
    /// 卡玛比率（收益 / 最大回撤）
    Calmar,
    /// 索提诺比率
    Sortino,
}

impl Objective {
    pub fn from_str(s: &str) -> Self {
        match s {
            "total_return" => Objective::TotalReturn,
            "calmar" => Objective::Calmar,
            "sortino" => Objective::Sortino,
            _ => Objective::Sharpe,
        }
    }

    /// 从指标中取值。非有限值（如无穷大盈亏比）一律按极低分处理，
    /// 避免 `NaN` 参与比较导致排序错乱。
    pub fn score(&self, m: &Metrics) -> f64 {
        let raw = match self {
            Objective::Sharpe => m.sharpe,
            Objective::TotalReturn => m.total_return,
            Objective::Calmar => m.calmar,
            Objective::Sortino => m.sortino,
        };
        if raw.is_finite() {
            raw
        } else {
            f64::NEG_INFINITY
        }
    }
}

/// 一个待搜索的参数：名称 + 候选值列表。
#[derive(Debug, Clone, PartialEq)]
pub struct ParamGrid {
    pub key: String,
    pub values: Vec<f64>,
}

/// 优化结果中的一个候选。
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub params: Params,
    pub score: f64,
    pub total_return: f64,
    pub max_drawdown: f64,
    pub sharpe: f64,
    pub trade_count: usize,
    pub win_rate: f64,
}

/// 优化报告。
#[derive(Debug, Clone, PartialEq)]
pub struct OptimizeReport {
    pub strategy_id: String,
    pub objective: String,
    pub evaluated: usize,
    /// 全部候选，按得分降序，最多保留 `keep` 个
    pub candidates: Vec<Candidate>,
    /// 边界警告：最优值落在搜索区间端点
    pub boundary_warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum OptimizeError {
    EmptyGrid,
    TooManyCombos(usize),
    InvalidParams(String),
    Backtest(String),
}

impl std::fmt::Display for OptimizeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OptimizeError::EmptyGrid => write!(f, "参数搜索空间为空"),
            OptimizeError::TooManyCombos(n) => {
                write!(f, "参数组合数 {n} 超过上限 {MAX_COMBOS}，请减少候选值")
            }
            OptimizeError::InvalidParams(msg) => write!(f, "参数非法：{msg}"),
            OptimizeError::Backtest(msg) => write!(f, "回测失败：{msg}"),
        }
    }
}

impl std::error::Error for OptimizeError {}

/// 笛卡尔积展开。组合数超过上限时立刻返回错误，不做无意义的展开。
fn expand(grid: &[ParamGrid], limit: usize) -> Result<Vec<Params>, OptimizeError> {
    if grid.is_empty() {
        return Err(OptimizeError::EmptyGrid);
    }
    let mut total = 1usize;
    for g in grid {
        if g.values.is_empty() {
            return Err(OptimizeError::InvalidParams(format!("参数 {} 没有候选值", g.key)));
        }
        total = total.saturating_mul(g.values.len());
        if total > limit {
            return Err(OptimizeError::TooManyCombos(total));
        }
    }

    let mut result: Vec<Params> = vec![Params::new()];
    for g in grid {
        let mut next = Vec::with_capacity(result.len() * g.values.len());
        for base in &result {
            for v in &g.values {
                let mut p = base.clone();
                p.insert(g.key.clone(), *v);
                next.push(p);
            }
        }
        result = next;
    }
    Ok(result)
}

/// 执行网格搜索。
pub fn optimize(
    strategy_id: &str,
    bars: &[Bar],
    base_params: &Params,
    grid: &[ParamGrid],
    config: &BacktestConfig,
    objective: Objective,
    keep: usize,
) -> Result<OptimizeReport, OptimizeError> {
    let strategy = strategies::find(strategy_id)
        .ok_or_else(|| OptimizeError::InvalidParams(format!("未知策略：{strategy_id}")))?;
    let meta = strategy.meta();

    let combos = expand(grid, MAX_COMBOS)?;
    let mut candidates: Vec<Candidate> = Vec::with_capacity(combos.len());

    for combo in combos {
        // 合并默认参数 -> 基础参数 -> 本次候选
        let mut params = Params::new();
        for p in &meta.params {
            params.insert(p.key.clone(), p.default_value);
        }
        for (k, v) in base_params {
            params.insert(k.clone(), *v);
        }
        for (k, v) in &combo {
            params.insert(k.clone(), *v);
        }

        let signals = strategy.signals(bars, &params);
        let runner = Runner::new(bars, config, "optimize", &meta.id, &meta.name);
        let result = runner
            .run(&signals)
            .map_err(|e| OptimizeError::Backtest(e.to_string()))?;

        candidates.push(Candidate {
            params: combo,
            score: objective.score(&result.metrics),
            total_return: result.metrics.total_return,
            max_drawdown: result.metrics.max_drawdown,
            sharpe: result.metrics.sharpe,
            trade_count: result.metrics.trade_count,
            win_rate: result.metrics.win_rate,
        });
    }

    let evaluated = candidates.len();
    candidates.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let keep = keep.max(1).min(candidates.len());
    let top = candidates[..keep].to_vec();

    // 边界检查：最优参数是否正好落在候选列表的两端
    let mut warnings = Vec::new();
    if let Some(best) = top.first() {
        for g in grid {
            if let Some(v) = best.params.get(&g.key) {
                let min = g.values.iter().cloned().fold(f64::INFINITY, f64::min);
                let max = g.values.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                if (*v - min).abs() < 1e-12 {
                    warnings.push(format!("参数 {} 最优值落在搜索下界 {min}，建议扩大区间", g.key));
                } else if (*v - max).abs() < 1e-12 {
                    warnings.push(format!("参数 {} 最优值落在搜索上界 {max}，建议扩大区间", g.key));
                }
            }
        }
    }

    Ok(OptimizeReport {
        strategy_id: strategy_id.to_string(),
        objective: match objective {
            Objective::Sharpe => "sharpe".into(),
            Objective::TotalReturn => "total_return".into(),
            Objective::Calmar => "calmar".into(),
            Objective::Sortino => "sortino".into(),
        },
        evaluated,
        candidates: top,
        boundary_warnings: warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bars(closes: &[f64]) -> Vec<Bar> {
        closes
            .iter()
            .enumerate()
            .map(|(i, c)| Bar {
                date: format!("2026-{:02}-{:02}", (i / 28) + 1, (i % 28) + 1),
                open: *c,
                high: c * 1.01,
                low: c * 0.99,
                close: *c,
                volume: 1000.0,
                amount: c * 1000.0,
            })
            .collect()
    }

    #[test]
    fn expand_cartesian_product() {
        let grid = vec![
            ParamGrid { key: "a".into(), values: vec![1.0, 2.0] },
            ParamGrid { key: "b".into(), values: vec![10.0, 20.0, 30.0] },
        ];
        let combos = expand(&grid, 100).unwrap();
        assert_eq!(combos.len(), 6);
        assert!(combos.iter().any(|p| p["a"] == 2.0 && p["b"] == 30.0));
    }

    #[test]
    fn expand_rejects_too_many() {
        let grid = vec![
            ParamGrid { key: "a".into(), values: (0..30).map(|i| i as f64).collect() },
            ParamGrid { key: "b".into(), values: (0..30).map(|i| i as f64).collect() },
        ];
        assert!(matches!(expand(&grid, MAX_COMBOS), Err(OptimizeError::TooManyCombos(_))));
    }

    #[test]
    fn expand_rejects_empty() {
        assert_eq!(expand(&[], 10), Err(OptimizeError::EmptyGrid));
        let grid = vec![ParamGrid { key: "a".into(), values: vec![] }];
        assert!(matches!(expand(&grid, 10), Err(OptimizeError::InvalidParams(_))));
    }

    #[test]
    fn optimize_returns_sorted_candidates() {
        let closes: Vec<f64> = (0..180).map(|i| 20.0 + (i as f64 / 12.0).sin() * 5.0).collect();
        let b = bars(&closes);
        let cfg = BacktestConfig {
            initial_cash: 100_000.0,
            commission_rate: 0.0,
            min_commission: 0.0,
            stamp_duty_rate: 0.0,
            transfer_fee_rate: 0.0,
            slippage_rate: 0.0,
            ..Default::default()
        };
        let grid = vec![
            ParamGrid { key: "fast".into(), values: vec![3.0, 5.0, 8.0] },
            ParamGrid { key: "slow".into(), values: vec![15.0, 20.0, 30.0] },
        ];
        let report = optimize("dual_ma", &b, &Params::new(), &grid, &cfg, Objective::Sharpe, 5)
            .expect("optimize ok");
        assert_eq!(report.evaluated, 9);
        assert_eq!(report.candidates.len(), 5);
        // 降序
        for w in report.candidates.windows(2) {
            assert!(w[0].score >= w[1].score, "candidates 未按得分降序");
        }
    }

    #[test]
    fn optimize_unknown_strategy_errors() {
        let b = bars(&[10.0; 30]);
        let cfg = BacktestConfig::default();
        let grid = vec![ParamGrid { key: "x".into(), values: vec![1.0] }];
        assert!(matches!(
            optimize("nope", &b, &Params::new(), &grid, &cfg, Objective::Sharpe, 3),
            Err(OptimizeError::InvalidParams(_))
        ));
    }

    #[test]
    fn boundary_warning_flags_edge_values() {
        let closes: Vec<f64> = (0..200).map(|i| 20.0 + (i as f64 / 9.0).sin() * 4.0).collect();
        let b = bars(&closes);
        let cfg = BacktestConfig {
            commission_rate: 0.0,
            min_commission: 0.0,
            stamp_duty_rate: 0.0,
            transfer_fee_rate: 0.0,
            slippage_rate: 0.0,
            ..Default::default()
        };
        let grid = vec![ParamGrid { key: "fast".into(), values: vec![3.0, 4.0, 5.0] }];
        let report = optimize("dual_ma", &b, &Params::new(), &grid, &cfg, Objective::TotalReturn, 3)
            .expect("ok");
        // 单参数网格：最优必然落在边界，应产生警告
        assert!(!report.boundary_warnings.is_empty());
    }

    #[test]
    fn score_handles_non_finite() {
        let mut m = Metrics::default();
        m.sharpe = f64::NAN;
        assert_eq!(Objective::Sharpe.score(&m), f64::NEG_INFINITY);
        m.sharpe = 1.5;
        assert!((Objective::Sharpe.score(&m) - 1.5).abs() < 1e-12);
    }
}
