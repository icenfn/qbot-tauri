//! 量化相关的 Tauri 命令。
//!
//! 分成两层的原因：
//! - `quant/mod.rs` 只做「JSON <-> 核心类型」的边界转换，不依赖 Tauri，方便单测；
//! - 本文件负责命令注册与线程调度。回测与参数优化是纯 CPU 紧循环，统一走
//!   `spawn_blocking`，避免长时间占用异步运行时导致 UI 卡顿（Android 上尤其明显）。

use std::collections::BTreeMap;

use qbot_core::backtest::Runner;
use qbot_core::optimizer::{self, Objective, ParamGrid};
use qbot_core::strategies;
use qbot_core::types::{BacktestConfig, Bar, Params, Signal};

use crate::quant::{
    metrics_to_dto, point_to_dto, trade_to_dto, BarInput, ConfigInput, GridInput,
    OptimizeReportDto, CandidateDto, BacktestResultDto, StrategyMetaDto,
};
use crate::quant::{closed_to_dto, meta_to_dto};

/// 列出全部策略及其参数规格，供前端渲染策略选择与参数表单。
#[tauri::command]
pub fn list_strategies() -> Vec<StrategyMetaDto> {
    strategies::registry().into_iter().map(meta_to_dto).collect()
}

/// 只计算策略信号，用于在 K 线图上叠加买卖点。
///
/// 返回与 K 线等长的字符串数组：
/// - `"hold"` 空仓观望
/// - `"exit"` 清仓
/// - `"target:0.5000"` 目标仓位 50%
#[tauri::command]
pub fn strategy_signals(
    strategy_id: String,
    bars: Vec<BarInput>,
    params: BTreeMap<String, f64>,
) -> Result<Vec<String>, String> {
    let core_bars: Vec<Bar> = bars.into_iter().map(Bar::from).collect();
    let core_params: Params = params.into_iter().collect();
    let signals = strategies::signals_for(&strategy_id, &core_bars, &core_params)?;
    Ok(signals
        .into_iter()
        .map(|s| match s {
            Signal::Hold => "hold".to_string(),
            Signal::Exit => "exit".to_string(),
            Signal::TargetPosition(r) => format!("target:{r:.4}"),
        })
        .collect())
}

/// 把用户参数与策略默认值合并，避免前端漏传字段时策略拿到 0（例如周期 0）。
fn merge_params(strategy_id: &str, params: &Params) -> Result<Params, String> {
    let meta = strategies::find(strategy_id)
        .ok_or_else(|| format!("未知策略：{strategy_id}"))?
        .meta();
    let mut merged = Params::new();
    for p in &meta.params {
        merged.insert(p.key.clone(), p.default_value);
    }
    for (k, v) in params {
        merged.insert(k.clone(), *v);
    }
    Ok(merged)
}

fn to_dto(
    symbol: &str,
    strategy_id: &str,
    bars: &[Bar],
    params: &Params,
    config: &BacktestConfig,
) -> Result<BacktestResultDto, String> {
    let meta = strategies::find(strategy_id)
        .ok_or_else(|| format!("未知策略：{strategy_id}"))?
        .meta();
    let merged = merge_params(strategy_id, params)?;
    let signals = strategies::signals_for(strategy_id, bars, &merged)?;
    let runner = Runner::new(bars, config, symbol, &meta.id, &meta.name);
    let result = runner.run(&signals).map_err(|e| e.to_string())?;

    Ok(BacktestResultDto {
        symbol: result.symbol,
        strategy_id: result.strategy_id,
        strategy_name: result.strategy_name,
        start_date: result.start_date,
        end_date: result.end_date,
        bars: result.bars,
        initial_cash: result.initial_cash,
        final_equity: result.final_equity,
        trades: result.trades.into_iter().map(trade_to_dto).collect(),
        closed_trades: result.closed_trades.into_iter().map(closed_to_dto).collect(),
        equityCurve: result.equity_curve.into_iter().map(point_to_dto).collect(),
        metrics: metrics_to_dto(result.metrics),
    })
}

/// 执行一次回测。
#[tauri::command]
pub async fn run_backtest(
    symbol: String,
    strategy_id: String,
    bars: Vec<BarInput>,
    params: BTreeMap<String, f64>,
    config: ConfigInput,
) -> Result<BacktestResultDto, String> {
    let core_bars: Vec<Bar> = bars.into_iter().map(Bar::from).collect();
    let core_params: Params = params.into_iter().collect();
    let core_config = config.merge(BacktestConfig::default());

    tauri::async_runtime::spawn_blocking(move || {
        to_dto(&symbol, &strategy_id, &core_bars, &core_params, &core_config)
    })
    .await
    .map_err(|e| format!("回测任务执行失败：{e}"))?
}

/// 网格参数优化。
#[tauri::command]
pub async fn optimize_params(
    strategy_id: String,
    bars: Vec<BarInput>,
    base_params: BTreeMap<String, f64>,
    grid: Vec<GridInput>,
    config: ConfigInput,
    objective: String,
    keep: Option<usize>,
) -> Result<OptimizeReportDto, String> {
    let core_bars: Vec<Bar> = bars.into_iter().map(Bar::from).collect();
    let core_params: Params = base_params.into_iter().collect();
    let core_config = config.merge(BacktestConfig::default());
    let core_grid: Vec<ParamGrid> = grid
        .into_iter()
        .map(|g| ParamGrid { key: g.key, values: g.values })
        .collect();
    let obj = Objective::from_str(&objective);
    let keep = keep.unwrap_or(10).clamp(1, 50);

    tauri::async_runtime::spawn_blocking(move || {
        optimizer::optimize(
            &strategy_id,
            &core_bars,
            &core_params,
            &core_grid,
            &core_config,
            obj,
            keep,
        )
        .map(|r| OptimizeReportDto {
            strategy_id: r.strategy_id,
            objective: r.objective,
            evaluated: r.evaluated,
            candidates: r
                .candidates
                .into_iter()
                .map(|c| CandidateDto {
                    params: c.params.into_iter().collect(),
                    score: c.score,
                    total_return: c.total_return,
                    max_drawdown: c.max_drawdown,
                    sharpe: c.sharpe,
                    trade_count: c.trade_count,
                    win_rate: c.win_rate,
                })
                .collect(),
            boundary_warnings: r.boundary_warnings,
        })
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("优化任务执行失败：{e}"))?
}

/// 计算单个技术指标序列，供图表叠加。
///
/// `None` 在 JSON 中变成 `null`，前端画图时跳过即可（对应预热期）。
#[tauri::command]
pub fn compute_indicator(
    name: String,
    bars: Vec<BarInput>,
    period: Option<usize>,
    mult: Option<f64>,
) -> Result<Vec<Option<f64>>, String> {
    use qbot_core::indicators as ind;

    let b: Vec<Bar> = bars.into_iter().map(Bar::from).collect();
    let close: Vec<f64> = b.iter().map(|x| x.close).collect();
    let high: Vec<f64> = b.iter().map(|x| x.high).collect();
    let low: Vec<f64> = b.iter().map(|x| x.low).collect();
    let volume: Vec<f64> = b.iter().map(|x| x.volume).collect();
    let p = period.unwrap_or(20).max(1);
    let m = mult.unwrap_or(2.0);

    let result = match name.as_str() {
        "sma" => ind::sma(&close, p),
        "ema" => ind::ema(&close, p),
        "wma" => ind::wma(&close, p),
        "rsi" => ind::rsi(&close, p),
        "atr" => ind::atr(&high, &low, &close, p),
        "obv" => ind::obv(&close, &volume),
        "roc" => ind::roc(&close, p),
        "bias" => ind::bias(&close, p),
        "cci" => ind::cci(&high, &low, &close, p),
        "momentum" => ind::momentum(&close, p),
        "williams_r" => ind::williams_r(&high, &low, &close, p),
        "volatility" => ind::rolling_volatility(&close, p),
        "boll_upper" => ind::boll(&close, p, m).1,
        "boll_lower" => ind::boll(&close, p, m).2,
        "boll_mid" => ind::boll(&close, p, m).0,
        "macd_dif" => ind::macd(&close, 12, 26, 9).0,
        "macd_dea" => ind::macd(&close, 12, 26, 9).1,
        "kdj_k" => ind::kdj(&high, &low, &close, p, 3.0, 3.0).0,
        other => return Err(format!("不支持的指标：{other}")),
    };
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bars(n: usize) -> Vec<Bar> {
        (0..n)
            .map(|i| Bar {
                date: format!("2026-{:02}-{:02}", (i / 28) + 1, (i % 28) + 1),
                open: 10.0 + (i as f64 * 0.3).sin(),
                high: 10.5 + (i as f64 * 0.3).sin(),
                low: 9.5 + (i as f64 * 0.3).sin(),
                close: 10.0 + (i as f64 * 0.3).sin(),
                volume: 1_000.0 + i as f64,
                amount: 10_000.0,
            })
            .collect()
    }

    #[test]
    fn merge_params_fills_defaults() {
        let merged = merge_params("dual_ma", &Params::new()).unwrap();
        assert_eq!(merged.get("fast"), Some(&5.0));
        assert_eq!(merged.get("slow"), Some(&20.0));
    }

    #[test]
    fn merge_params_rejects_unknown() {
        assert!(merge_params("nope", &Params::new()).is_err());
    }

    #[test]
    fn to_dto_curve_aligned() {
        let b = bars(150);
        let out = to_dto("600519", "dual_ma", &b, &Params::new(), &BacktestConfig::default()).unwrap();
        assert_eq!(out.equityCurve.len(), 150);
        assert_eq!(out.bars, 150);
    }

    #[test]
    fn list_strategies_non_empty() {
        assert!(!list_strategies().is_empty());
    }
}
