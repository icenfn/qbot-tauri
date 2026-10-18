//! 绩效分析。
//!
//! 口径说明（避免「同一个词不同算法」的常见坑）：
//! - 收益率一律用小数表示（0.23 = 23%），只有明确标注 `_pct` 的才用百分数；
//! - 年化按 252 个交易日折算，不足 1 年时按实际交易日数折算，**不做强行外推放大**；
//! - 夏普 / 索提诺的无风险利率默认年化 2%，按日折算；
//! - 最大回撤基于每日权益曲线的历史最高点（含当日在内的 running max）。

use crate::types::{ClosedTrade, EquityPoint, Metrics, Trade};

/// 年化无风险利率（默认 2%）。
pub const RISK_FREE_RATE: f64 = 0.02;
/// A 股年均交易日。
pub const TRADING_DAYS: f64 = 252.0;

/// 由权益曲线计算日收益率序列。
pub fn daily_returns(curve: &[EquityPoint]) -> Vec<f64> {
    if curve.len() < 2 {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(curve.len() - 1);
    for i in 1..curve.len() {
        let prev = curve[i - 1].equity;
        if prev.abs() > f64::EPSILON {
            out.push(curve[i].equity / prev - 1.0);
        } else {
            out.push(0.0);
        }
    }
    out
}

fn mean(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.iter().sum::<f64>() / values.len() as f64
}

/// 样本标准差。
fn std_dev(values: &[f64]) -> f64 {
    if values.len() < 2 {
        return 0.0;
    }
    let m = mean(values);
    let var = values.iter().map(|v| (v - m).powi(2)).sum::<f64>() / (values.len() as f64 - 1.0);
    var.sqrt()
}

/// 下行标准差：只统计低于目标收益（默认 0）的部分。
fn downside_dev(values: &[f64], target: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut acc = 0.0;
    let mut count = 0usize;
    for v in values {
        if *v < target {
            acc += (v - target).powi(2);
        }
        count += 1;
    }
    if count == 0 {
        return 0.0;
    }
    (acc / count as f64).sqrt()
}

/// 最大回撤：返回 (最大回撤比例, 峰值日期, 谷值日期)。
pub fn max_drawdown(curve: &[EquityPoint]) -> (f64, Option<String>, Option<String>) {
    if curve.is_empty() {
        return (0.0, None, None);
    }
    let mut peak = curve[0].equity;
    let mut peak_date = curve[0].date.clone();
    let mut max_dd = 0.0f64;
    let mut dd_start: Option<String> = None;
    let mut dd_end: Option<String> = None;

    for point in curve {
        if point.equity > peak {
            peak = point.equity;
            peak_date = point.date.clone();
        }
        if peak > f64::EPSILON {
            let dd = (peak - point.equity) / peak;
            if dd > max_dd {
                max_dd = dd;
                dd_start = Some(peak_date.clone());
                dd_end = Some(point.date.clone());
            }
        }
    }
    (max_dd, dd_start, dd_end)
}

/// 年化收益率（按交易日折算，用几何年化）。
pub fn annualize(total_return: f64, trading_days: usize) -> f64 {
    if trading_days == 0 {
        return 0.0;
    }
    let years = trading_days as f64 / TRADING_DAYS;
    if years <= 0.0 {
        return 0.0;
    }
    let growth = 1.0 + total_return;
    if growth <= 0.0 {
        // 本金亏光，年化按 -100% 处理，避免 NaN
        return -1.0;
    }
    growth.powf(1.0 / years) - 1.0
}

/// 汇总所有绩效指标。
///
/// `benchmark_close` 是同期标的收盘价序列（用于买入持有基准），
/// 长度与权益曲线不一致时只按重叠部分计算。
pub fn compute_metrics(
    curve: &[EquityPoint],
    trades: &[Trade],
    closed: &[ClosedTrade],
    benchmark_close: &[f64],
) -> Metrics {
    let mut metrics = Metrics::default();
    if curve.is_empty() {
        return metrics;
    }

    let initial = curve[0].equity;
    let final_equity = curve[curve.len() - 1].equity;
    metrics.total_return = if initial.abs() > f64::EPSILON {
        final_equity / initial - 1.0
    } else {
        0.0
    };

    let trading_days = curve.len().saturating_sub(1);
    metrics.annual_return = annualize(metrics.total_return, trading_days);

    let rets = daily_returns(curve);
    metrics.annual_volatility = std_dev(&rets) * TRADING_DAYS.sqrt();

    let (dd, dd_start, dd_end) = max_drawdown(curve);
    metrics.max_drawdown = dd;
    metrics.max_drawdown_start = dd_start;
    metrics.max_drawdown_end = dd_end;

    // 夏普：日超额收益均值 / 日收益标准差 × √252
    let daily_rf = RISK_FREE_RATE / TRADING_DAYS;
    let excess: Vec<f64> = rets.iter().map(|r| r - daily_rf).collect();
    let sd = std_dev(&rets);
    metrics.sharpe = if sd > f64::EPSILON {
        mean(&excess) / sd * TRADING_DAYS.sqrt()
    } else {
        0.0
    };

    // 索提诺：分母换成下行标准差
    let dsd = downside_dev(&rets, daily_rf);
    metrics.sortino = if dsd > f64::EPSILON {
        mean(&excess) / dsd * TRADING_DAYS.sqrt()
    } else {
        0.0
    };

    metrics.calmar = if dd > f64::EPSILON {
        metrics.annual_return / dd
    } else {
        0.0
    };

    // 交易统计
    metrics.trade_count = trades.iter().filter(|t| t.side == crate::types::Side::Buy).count();
    metrics.total_fees = trades.iter().map(|t| t.fee).sum();

    if !closed.is_empty() {
        let wins: Vec<&ClosedTrade> = closed.iter().filter(|t| t.pnl > 0.0).collect();
        let losses: Vec<&ClosedTrade> = closed.iter().filter(|t| t.pnl <= 0.0).collect();
        metrics.win_rate = wins.len() as f64 / closed.len() as f64;

        let avg_win = if wins.is_empty() {
            0.0
        } else {
            wins.iter().map(|t| t.pnl).sum::<f64>() / wins.len() as f64
        };
        let avg_loss = if losses.is_empty() {
            0.0
        } else {
            losses.iter().map(|t| t.pnl.abs()).sum::<f64>() / losses.len() as f64
        };
        metrics.profit_factor = if avg_loss > f64::EPSILON {
            avg_win / avg_loss
        } else if avg_win > 0.0 {
            f64::INFINITY
        } else {
            0.0
        };

        let total_days: i64 = closed.iter().map(|t| t.holding_days).sum();
        metrics.avg_holding_days = total_days as f64 / closed.len() as f64;
    }

    // 基准：买入并持有
    if benchmark_close.len() >= 2 {
        let first = benchmark_close[0];
        let last = benchmark_close[benchmark_close.len() - 1];
        metrics.benchmark_return = if first.abs() > f64::EPSILON {
            last / first - 1.0
        } else {
            0.0
        };
        metrics.excess_return = metrics.total_return - metrics.benchmark_return;
    }

    metrics
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point(date: &str, equity: f64) -> EquityPoint {
        EquityPoint {
            date: date.to_string(),
            equity,
            cash: equity,
            position_value: 0.0,
            close: 1.0,
            drawdown: 0.0,
        }
    }

    fn curve_from(values: &[f64]) -> Vec<EquityPoint> {
        values
            .iter()
            .enumerate()
            .map(|(i, v)| point(&format!("2026-01-{:02}", i + 1), *v))
            .collect()
    }

    #[test]
    fn total_return_basic() {
        let curve = curve_from(&[100.0, 150.0]);
        let m = compute_metrics(&curve, &[], &[], &[]);
        assert!((m.total_return - 0.5).abs() < 1e-9);
    }

    #[test]
    fn max_drawdown_known_shape() {
        // 100 -> 120 -> 90 -> 110：最大回撤 = (120-90)/120 = 0.25
        let curve = curve_from(&[100.0, 120.0, 90.0, 110.0]);
        let (dd, start, end) = max_drawdown(&curve);
        assert!((dd - 0.25).abs() < 1e-9, "dd = {dd}");
        assert_eq!(start.as_deref(), Some("2026-01-02"));
        assert_eq!(end.as_deref(), Some("2026-01-03"));
    }

    #[test]
    fn max_drawdown_monotonic_up_is_zero() {
        let curve = curve_from(&[100.0, 110.0, 130.0]);
        let (dd, _, _) = max_drawdown(&curve);
        assert!(dd < 1e-12);
    }

    #[test]
    fn annualize_one_year() {
        // 252 个交易日，收益 20% -> 年化恰好 20%
        let r = annualize(0.2, 252);
        assert!((r - 0.2).abs() < 1e-9, "r = {r}");
    }

    #[test]
    fn annualize_half_year_is_not_naive_doubling() {
        // 126 个交易日（半年）涨 10%，几何年化 = 1.1^2 - 1 = 0.21，而不是 20%
        let r = annualize(0.1, 126);
        assert!((r - 0.21).abs() < 1e-9, "r = {r}");
    }

    #[test]
    fn annualize_total_loss_is_minus_one() {
        assert!((annualize(-1.0, 100) + 1.0).abs() < 1e-9);
        assert!((annualize(-1.5, 100) + 1.0).abs() < 1e-9);
    }

    #[test]
    fn sharpe_zero_when_no_volatility() {
        // 每日恒定增长时没有任何波动 -> 标准差为 0
        let curve = curve_from(&[100.0, 100.0, 100.0]);
        let m = compute_metrics(&curve, &[], &[], &[]);
        assert!(m.sharpe.abs() < 1e-12);
        assert!(m.annual_volatility.abs() < 1e-12);
    }

    #[test]
    fn volatility_annualized() {
        // 构造交替 +1% / -1% 的日收益
        let mut equity = 100.0;
        let mut values = vec![equity];
        for i in 0..100 {
            equity *= if i % 2 == 0 { 1.01 } else { 0.99 };
            values.push(equity);
        }
        let curve = curve_from(&values);
        let m = compute_metrics(&curve, &[], &[], &[]);
        // 日标准差约 0.01，年化约 0.1587
        assert!(m.annual_volatility > 0.15 && m.annual_volatility < 0.17, "vol = {}", m.annual_volatility);
    }

    #[test]
    fn downside_dev_only_negative() {
        let values = [0.01, -0.02, 0.03, -0.01];
        let d = downside_dev(&values, 0.0);
        let expected = ((0.02f64.powi(2) + 0.01f64.powi(2)) / 4.0).sqrt();
        assert!((d - expected).abs() < 1e-12);
    }

    #[test]
    fn benchmark_and_excess() {
        // 策略 100 -> 120 = +20%；基准 10 -> 15 = +50%
        let curve = curve_from(&[100.0, 120.0]);
        let m = compute_metrics(&curve, &[], &[], &[10.0, 15.0]);
        assert!((m.total_return - 0.2).abs() < 1e-9, "total = {}", m.total_return);
        assert!((m.benchmark_return - 0.5).abs() < 1e-9);
        assert!((m.excess_return + 0.3).abs() < 1e-9, "excess = {}", m.excess_return);
    }

    #[test]
    fn empty_inputs_are_safe() {
        let m = compute_metrics(&[], &[], &[], &[]);
        assert_eq!(m.total_return, 0.0);
        assert_eq!(m.max_drawdown, 0.0);
        assert_eq!(m.trade_count, 0);
    }
}
