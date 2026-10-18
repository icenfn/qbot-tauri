//! 事件驱动回测引擎。
//!
//! 撮合规则（尽量贴近 A 股真实约束，不做「理想化」回测）：
//! 1. **信号与成交分离**：策略在第 `i` 根 Bar 的收盘价上产生信号，引擎在第 `i+1` 根 Bar
//!    的**开盘价**成交。这样避免了「用当日收盘信号在当日收盘成交」的前视偏差。
//! 2. **T+1**：`allow_t0 = false` 时，当日买入的股票当日不可卖出。
//! 3. **整手交易**：按 `lot_size`（A 股 100 股）向下取整，不足一手的零头不买。
//! 4. **费用**：买入收佣金（有最低额）+ 过户费；卖出再加印花税。滑点通过成交价体现
//!    （买入上浮、卖出下调），不计入 `fee` 字段以免重复计算。
//! 5. **止损 / 止盈**：盘中止损按 `low` 触发、止盈按 `high` 触发，成交价取触发价
//!    （跳空时取开盘价，避免用不存在的价格成交）。
//! 6. **资金约束**：买入按可用现金与 `max_position_pct` 双重限制，绝不透支。

use crate::metrics;
use crate::types::{
    BacktestConfig, BacktestResult, Bar, ClosedTrade, EquityPoint, Metrics, Signal, Side, Trade,
};

/// 回测错误。
#[derive(Debug, Clone, PartialEq)]
pub enum BacktestError {
    NotEnoughBars,
    InvalidConfig(String),
    SignalLengthMismatch { bars: usize, signals: usize },
    Strategy(String),
}

impl std::fmt::Display for BacktestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BacktestError::NotEnoughBars => write!(f, "K 线数据不足，至少需要 2 根"),
            BacktestError::InvalidConfig(msg) => write!(f, "回测配置非法：{msg}"),
            BacktestError::SignalLengthMismatch { bars, signals } => {
                write!(f, "信号数量（{signals}）与 K 线数量（{bars}）不一致")
            }
            BacktestError::Strategy(msg) => write!(f, "策略执行失败：{msg}"),
        }
    }
}

impl std::error::Error for BacktestError {}

/// 回测运行器。
pub struct Runner<'a> {
    pub bars: &'a [Bar],
    pub config: &'a BacktestConfig,
    pub symbol: &'a str,
    pub strategy_id: &'a str,
    pub strategy_name: &'a str,
}

#[derive(Debug, Clone)]
struct OpenPosition {
    entry_date: String,
    entry_price: f64,
    /// 买入总成本（含费用），用于计算净盈亏
    cost: f64,
    shares: f64,
    entry_fee: f64,
}

impl<'a> Runner<'a> {
    pub fn new(
        bars: &'a [Bar],
        config: &'a BacktestConfig,
        symbol: &'a str,
        strategy_id: &'a str,
        strategy_name: &'a str,
    ) -> Self {
        Self {
            bars,
            config,
            symbol,
            strategy_id,
            strategy_name,
        }
    }

    /// 执行回测。`signals[i]` 对应第 `i` 根 Bar 收盘后的意图。
    pub fn run(&self, signals: &[Signal]) -> Result<BacktestResult, BacktestError> {
        let cfg = self.config;
        cfg.validate().map_err(BacktestError::InvalidConfig)?;

        let bars = self.bars;
        if bars.len() < 2 {
            return Err(BacktestError::NotEnoughBars);
        }
        if signals.len() != bars.len() {
            return Err(BacktestError::SignalLengthMismatch {
                bars: bars.len(),
                signals: signals.len(),
            });
        }

        let mut cash = cfg.initial_cash;
        let mut shares = 0.0f64;
        let mut position: Option<OpenPosition> = None;
        let mut last_buy_date: Option<String> = None;

        let mut trades: Vec<Trade> = Vec::new();
        let mut closed_trades: Vec<ClosedTrade> = Vec::new();
        let mut curve: Vec<EquityPoint> = Vec::with_capacity(bars.len());
        let mut peak = cfg.initial_cash;
        // 尚未执行的意图（来自上一根 Bar 收盘）
        let mut pending: Signal = Signal::Hold;

        for i in 0..bars.len() {
            let bar = &bars[i];

            // ---- 1) 用今日开盘价执行上一根 Bar 产生的信号 ----
            match pending.clone() {
                Signal::TargetPosition(ratio) => {
                    let exec_price = bar.open * (1.0 + cfg.slippage_rate);
                    if exec_price > 0.0 {
                        let target_equity = (cash + shares * bar.open) * ratio.min(cfg.max_position_pct);
                        let target_shares = target_equity / exec_price;
                        let mut want = target_shares - shares;
                        // 整手取整
                        want = (want / cfg.lot_size).floor() * cfg.lot_size;

                        if want >= cfg.lot_size {
                            // 受现金约束
                            let affordable = affordable_shares(cash, exec_price, cfg);
                            let buy_shares = want.min(affordable);
                            if buy_shares >= cfg.lot_size {
                                let amount = buy_shares * exec_price;
                                let fee = buy_fee(amount, cfg);
                                if amount + fee <= cash {
                                    cash -= amount + fee;
                                    if let Some(pos) = position.as_mut() {
                                        // 加仓：更新加权成本
                                        let total_cost = pos.cost + amount + fee;
                                        pos.shares += buy_shares;
                                        pos.entry_price = total_cost / pos.shares;
                                        pos.cost = total_cost;
                                        pos.entry_fee += fee;
                                    } else {
                                        position = Some(OpenPosition {
                                            entry_date: bar.date.clone(),
                                            entry_price: (amount + fee) / buy_shares,
                                            cost: amount + fee,
                                            shares: buy_shares,
                                            entry_fee: fee,
                                        });
                                    }
                                    shares += buy_shares;
                                    last_buy_date = Some(bar.date.clone());
                                    trades.push(Trade {
                                        date: bar.date.clone(),
                                        side: Side::Buy,
                                        price: exec_price,
                                        shares: buy_shares,
                                        amount,
                                        fee,
                                        realized_pnl: None,
                                        reason: format!("目标仓位 {:.0}%", ratio * 100.0),
                                        position_after: shares,
                                    });
                                }
                            }
                        } else if want <= -cfg.lot_size {
                            // 减仓：T+1 约束
                            let can_sell = cfg.allow_t0
                                || last_buy_date.as_deref() != Some(bar.date.as_str());
                            if can_sell && shares > 0.0 {
                                let mut sell_shares = (-want).min(shares);
                                sell_shares = (sell_shares / cfg.lot_size).floor() * cfg.lot_size;
                                if sell_shares >= cfg.lot_size || (shares - sell_shares).abs() < 1e-9 {
                                    let exec = bar.open * (1.0 - cfg.slippage_rate);
                                    sell(
                                        bar,
                                        exec,
                                        sell_shares,
                                        &mut cash,
                                        &mut shares,
                                        &mut position,
                                        &mut trades,
                                        &mut closed_trades,
                                        cfg,
                                        "调仓减仓".to_string(),
                                    );
                                }
                            }
                        }
                    }
                }
                Signal::Exit => {
                    let can_sell =
                        cfg.allow_t0 || last_buy_date.as_deref() != Some(bar.date.as_str());
                    if can_sell && shares > 0.0 {
                        let exec = bar.open * (1.0 - cfg.slippage_rate);
                        sell(
                            bar,
                            exec,
                            shares,
                            &mut cash,
                            &mut shares,
                            &mut position,
                            &mut trades,
                            &mut closed_trades,
                            cfg,
                            "策略清仓".to_string(),
                        );
                    }
                }
                Signal::Hold => {}
            }

            // ---- 2) 盘中止损 / 止盈（仅对已有持仓）----
            if shares > 0.0 {
                if let Some(pos) = position.as_ref() {
                    let cost = pos.entry_price;
                    let can_sell =
                        cfg.allow_t0 || last_buy_date.as_deref() != Some(bar.date.as_str());
                    if can_sell {
                        if let Some(sl) = cfg.stop_loss {
                            let trigger = cost * (1.0 - sl);
                            if bar.low <= trigger {
                                // 若开盘已跌破，按开盘价成交（跳空）
                                let exec = if bar.open <= trigger { bar.open } else { trigger };
                                let exec = exec * (1.0 - cfg.slippage_rate);
                                sell(
                                    bar,
                                    exec,
                                    shares,
                                    &mut cash,
                                    &mut shares,
                                    &mut position,
                                    &mut trades,
                                    &mut closed_trades,
                                    cfg,
                                    format!("止损 -{:.1}%", sl * 100.0),
                                );
                            }
                        }
                    }
                }
            }
            if shares > 0.0 {
                if let Some(pos) = position.as_ref() {
                    let cost = pos.entry_price;
                    let can_sell =
                        cfg.allow_t0 || last_buy_date.as_deref() != Some(bar.date.as_str());
                    if can_sell {
                        if let Some(tp) = cfg.take_profit {
                            let trigger = cost * (1.0 + tp);
                            if bar.high >= trigger {
                                let exec = if bar.open >= trigger { bar.open } else { trigger };
                                let exec = exec * (1.0 - cfg.slippage_rate);
                                sell(
                                    bar,
                                    exec,
                                    shares,
                                    &mut cash,
                                    &mut shares,
                                    &mut position,
                                    &mut trades,
                                    &mut closed_trades,
                                    cfg,
                                    format!("止盈 +{:.1}%", tp * 100.0),
                                );
                            }
                        }
                    }
                }
            }

            // ---- 3) 收盘结算 ----
            let position_value = shares * bar.close;
            let equity = cash + position_value;
            if equity > peak {
                peak = equity;
            }
            let drawdown = if peak > f64::EPSILON {
                equity / peak - 1.0
            } else {
                0.0
            };
            curve.push(EquityPoint {
                date: bar.date.clone(),
                equity,
                cash,
                position_value,
                close: bar.close,
                drawdown,
            });

            // ---- 4) 记录本根 Bar 的信号，待下一根开盘执行 ----
            pending = signals[i].clone();
        }

        let final_equity = curve.last().map(|p| p.equity).unwrap_or(cfg.initial_cash);
        let benchmark: Vec<f64> = bars.iter().map(|b| b.close).collect();
        let metrics: Metrics =
            metrics::compute_metrics(&curve, &trades, &closed_trades, &benchmark);

        Ok(BacktestResult {
            symbol: self.symbol.to_string(),
            strategy_id: self.strategy_id.to_string(),
            strategy_name: self.strategy_name.to_string(),
            start_date: bars.first().map(|b| b.date.clone()).unwrap_or_default(),
            end_date: bars.last().map(|b| b.date.clone()).unwrap_or_default(),
            bars: bars.len(),
            initial_cash: cfg.initial_cash,
            final_equity,
            trades,
            closed_trades,
            equity_curve: curve,
            metrics,
        })
    }
}

/// 买入费用：佣金（有最低额）+ 过户费。
fn buy_fee(amount: f64, cfg: &BacktestConfig) -> f64 {
    let commission = (amount * cfg.commission_rate).max(cfg.min_commission);
    let transfer = amount * cfg.transfer_fee_rate;
    commission + transfer
}

/// 卖出费用：佣金（有最低额）+ 过户费 + 印花税。
fn sell_fee(amount: f64, cfg: &BacktestConfig) -> f64 {
    let commission = (amount * cfg.commission_rate).max(cfg.min_commission);
    let transfer = amount * cfg.transfer_fee_rate;
    let stamp = amount * cfg.stamp_duty_rate;
    commission + transfer + stamp
}

/// 按可用现金能买多少股（含费用预留），并做整手取整。
fn affordable_shares(cash: f64, price: f64, cfg: &BacktestConfig) -> f64 {
    if price <= 0.0 || cash <= 0.0 {
        return 0.0;
    }
    // 先用不含费用的上限估算，再迭代收敛一次（费用依赖成交额）
    let mut guess = (cash / price / cfg.lot_size).floor() * cfg.lot_size;
    for _ in 0..4 {
        let amount = guess * price;
        let fee = buy_fee(amount, cfg);
        if amount + fee <= cash {
            break;
        }
        guess -= cfg.lot_size;
        if guess <= 0.0 {
            return 0.0;
        }
    }
    guess.max(0.0)
}

/// 卖出成交并结算已平仓交易。
#[allow(clippy::too_many_arguments)]
fn sell(
    bar: &Bar,
    exec_price: f64,
    sell_shares: f64,
    cash: &mut f64,
    shares: &mut f64,
    position: &mut Option<OpenPosition>,
    trades: &mut Vec<Trade>,
    closed: &mut Vec<ClosedTrade>,
    cfg: &BacktestConfig,
    reason: String,
) {
    if sell_shares <= 0.0 || *shares <= 0.0 {
        return;
    }
    let sell_shares = sell_shares.min(*shares);
    let amount = sell_shares * exec_price;
    let fee = sell_fee(amount, cfg);
    let net = amount - fee;

    let pos = match position.as_ref() {
        Some(p) => p.clone(),
        None => return,
    };

    // 成本按比例分摊，支持部分卖出
    let ratio = sell_shares / pos.shares;
    let cost_part = pos.cost * ratio;
    let realized = net - cost_part;
    let return_pct = if cost_part.abs() > f64::EPSILON {
        realized / cost_part
    } else {
        0.0
    };

    *cash += net;
    *shares -= sell_shares;

    let entry_price = pos.entry_price;
    if *shares <= 1e-9 {
        *shares = 0.0;
        *position = None;
    } else {
        if let Some(p) = position.as_mut() {
            p.shares -= sell_shares;
            p.cost -= cost_part;
        }
    }

    closed.push(ClosedTrade {
        entry_date: pos.entry_date.clone(),
        exit_date: bar.date.clone(),
        entry_price,
        exit_price: exec_price,
        shares: sell_shares,
        pnl: realized,
        return_pct,
        holding_days: days_between(&pos.entry_date, &bar.date),
    });

    trades.push(Trade {
        date: bar.date.clone(),
        side: Side::Sell,
        price: exec_price,
        shares: sell_shares,
        amount,
        fee,
        realized_pnl: Some(realized),
        reason,
        position_after: *shares,
    });
}

/// 计算两个 `YYYY-MM-DD` 之间的自然日差；解析失败时返回 0（不 panic）。
fn days_between(a: &str, b: &str) -> i64 {
    fn parse(s: &str) -> Option<(i64, i64, i64)> {
        let mut it = s.split('-');
        let y = it.next()?.parse::<i64>().ok()?;
        let m = it.next()?.parse::<i64>().ok()?;
        let d = it.next()?.parse::<i64>().ok()?;
        Some((y, m, d))
    }
    fn to_days(y: i64, m: i64, d: i64) -> i64 {
        // 简化儒略日：仅用于日差，不追求天文精度
        let a = (14 - m) / 12;
        let y2 = y + 4800 - a;
        let m2 = m + 12 * a - 3;
        d + (153 * m2 + 2) / 5 + 365 * y2 + y2 / 4 - y2 / 100 + y2 / 400 - 32045
    }
    match (parse(a), parse(b)) {
        (Some((y1, m1, d1)), Some((y2, m2, d2))) => to_days(y2, m2, d2) - to_days(y1, m1, d1),
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bar(date: &str, open: f64, high: f64, low: f64, close: f64) -> Bar {
        Bar {
            date: date.to_string(),
            open,
            high,
            low,
            close,
            volume: 1000.0,
            amount: 1000.0 * close,
        }
    }

    fn flat_config() -> BacktestConfig {
        BacktestConfig {
            initial_cash: 100_000.0,
            // 测试里把费用归零，便于精确断言
            commission_rate: 0.0,
            min_commission: 0.0,
            stamp_duty_rate: 0.0,
            transfer_fee_rate: 0.0,
            slippage_rate: 0.0,
            lot_size: 100.0,
            stop_loss: None,
            take_profit: None,
            allow_t0: false,
            max_position_pct: 1.0,
        }
    }

    #[test]
    fn no_signal_keeps_cash() {
        let bars = vec![
            bar("2026-01-05", 10.0, 10.5, 9.8, 10.0),
            bar("2026-01-06", 10.0, 10.5, 9.8, 10.2),
            bar("2026-01-07", 10.2, 10.8, 10.0, 10.5),
        ];
        let cfg = flat_config();
        let signals = vec![Signal::Hold; bars.len()];
        let result = Runner::new(&bars, &cfg, "600519", "hold", "空仓").run(&signals).unwrap();
        assert_eq!(result.final_equity, 100_000.0);
        assert!(result.trades.is_empty());
        assert!((result.metrics.total_return).abs() < 1e-12);
    }

    #[test]
    fn buy_then_hold_earns_price_gain() {
        // 第 0 根发信号 -> 第 1 根开盘 10 元买满仓
        // 末根收盘 12 元
        let bars = vec![
            bar("2026-01-05", 10.0, 10.0, 10.0, 10.0),
            bar("2026-01-06", 10.0, 11.0, 10.0, 11.0),
            bar("2026-01-07", 11.0, 12.0, 11.0, 12.0),
        ];
        let cfg = flat_config();
        let signals = vec![Signal::TargetPosition(1.0), Signal::Hold, Signal::Hold];
        let r = Runner::new(&bars, &cfg, "600519", "buy", "买入持有").run(&signals).unwrap();
        assert_eq!(r.trades.len(), 1);
        let t = &r.trades[0];
        assert_eq!(t.side, Side::Buy);
        assert_eq!(t.shares, 10_000.0); // 100000 / 10
        assert_eq!(t.price, 10.0);
        // 收盘 12 元：10000 * 12 = 120000
        assert!((r.final_equity - 120_000.0).abs() < 1e-6, "equity = {}", r.final_equity);
        assert!((r.metrics.total_return - 0.2).abs() < 1e-9);
    }

    #[test]
    fn signal_executes_next_bar_not_same_bar() {
        // 若在当根成交（前视偏差），第 0 根以 10 元买入后第 0 根收盘 20 元会立刻获利
        let bars = vec![
            bar("2026-01-05", 10.0, 20.0, 10.0, 20.0),
            bar("2026-01-06", 20.0, 20.0, 20.0, 20.0),
        ];
        let cfg = flat_config();
        let signals = vec![Signal::TargetPosition(1.0), Signal::Hold];
        let r = Runner::new(&bars, &cfg, "x", "s", "s").run(&signals).unwrap();
        // 买入发生在第 1 根开盘 20 元，因此总资产仍为 100000（不因第 0 根暴涨而获利）
        assert!((r.final_equity - 100_000.0).abs() < 1e-6, "equity = {}", r.final_equity);
        assert_eq!(r.trades[0].price, 20.0);
    }

    #[test]
    fn lot_size_rounding() {
        // 100000 元 / 33 元 = 3030.3 股 -> 整手后 3000 股
        let bars = vec![
            bar("2026-01-05", 33.0, 33.0, 33.0, 33.0),
            bar("2026-01-06", 33.0, 33.0, 33.0, 33.0),
        ];
        let cfg = flat_config();
        let signals = vec![Signal::TargetPosition(1.0), Signal::Hold];
        let r = Runner::new(&bars, &cfg, "x", "s", "s").run(&signals).unwrap();
        assert_eq!(r.trades[0].shares, 3000.0);
        assert!(r.trades[0].shares % 100.0 == 0.0);
    }

    #[test]
    fn fees_reduce_final_equity() {
        let bars = vec![
            bar("2026-01-05", 10.0, 10.0, 10.0, 10.0),
            bar("2026-01-06", 10.0, 10.0, 10.0, 10.0),
            bar("2026-01-07", 10.0, 10.0, 10.0, 10.0),
        ];
        let mut cfg = flat_config();
        cfg.commission_rate = 0.0003;
        cfg.min_commission = 5.0;
        cfg.stamp_duty_rate = 0.0005;
        cfg.transfer_fee_rate = 0.00001;
        let signals = vec![Signal::TargetPosition(1.0), Signal::Hold, Signal::Hold];
        let r = Runner::new(&bars, &cfg, "x", "s", "s").run(&signals).unwrap();
        assert!(r.metrics.total_fees > 0.0);
        assert!(r.final_equity < 100_000.0);

        // 关键行为：满仓买入时费用会占掉一部分现金，引擎必须自动减一手
        // 10000 股 -> 费用 31 元超出资金 -> 退到 9900 股
        assert_eq!(r.trades[0].shares, 9900.0, "应自动减一手以容纳费用");
        let amount = 9900.0 * 10.0; // 99000
        let expected = 99000.0 * 0.0003 + amount * 0.00001; // 29.7 + 0.99
        assert!((r.metrics.total_fees - expected).abs() < 1e-6, "fees = {}", r.metrics.total_fees);
        // 成交后现金不应为负
        assert!(r.equity_curve[1].cash >= 0.0);
    }

    #[test]
    fn min_commission_applies_on_small_orders() {
        // 小额买入时佣金按最低 5 元收取
        let bars = vec![
            bar("2026-01-05", 10.0, 10.0, 10.0, 10.0),
            bar("2026-01-06", 10.0, 10.0, 10.0, 10.0),
        ];
        let mut cfg = flat_config();
        cfg.initial_cash = 10_000.0;
        cfg.commission_rate = 0.0003;
        cfg.min_commission = 5.0;
        let signals = vec![Signal::TargetPosition(0.5), Signal::Hold];
        let r = Runner::new(&bars, &cfg, "x", "s", "s").run(&signals).unwrap();
        // 5000 元按万三只有 1.5 元，应被抬到 5 元
        assert!(r.metrics.total_fees >= 5.0, "fees = {}", r.metrics.total_fees);
    }

    #[test]
    fn stop_loss_triggers_on_low() {
        let bars = vec![
            bar("2026-01-05", 10.0, 10.0, 10.0, 10.0),
            bar("2026-01-06", 10.0, 10.2, 10.0, 10.0),
            // 成本 10 元，止损 10% -> 触发价 9.0，本根最低 8.5
            bar("2026-01-07", 10.0, 10.1, 8.5, 9.0),
        ];
        let mut cfg = flat_config();
        cfg.stop_loss = Some(0.10);
        let signals = vec![Signal::TargetPosition(1.0), Signal::Hold, Signal::Hold];
        let r = Runner::new(&bars, &cfg, "x", "s", "s").run(&signals).unwrap();
        let sells: Vec<&Trade> = r.trades.iter().filter(|t| t.side == Side::Sell).collect();
        assert_eq!(sells.len(), 1);
        assert!((sells[0].price - 9.0).abs() < 1e-9, "price = {}", sells[0].price);
        assert!(sells[0].reason.contains("止损"));
        assert!(!r.closed_trades.is_empty());
        assert!(r.closed_trades[0].pnl < 0.0);
    }

    #[test]
    fn take_profit_triggers_on_high() {
        let bars = vec![
            bar("2026-01-05", 10.0, 10.0, 10.0, 10.0),
            bar("2026-01-06", 10.0, 10.2, 10.0, 10.0),
            bar("2026-01-07", 10.0, 13.0, 9.9, 12.0),
        ];
        let mut cfg = flat_config();
        cfg.take_profit = Some(0.20); // 触发价 12.0
        let signals = vec![Signal::TargetPosition(1.0), Signal::Hold, Signal::Hold];
        let r = Runner::new(&bars, &cfg, "x", "s", "s").run(&signals).unwrap();
        let sells: Vec<&Trade> = r.trades.iter().filter(|t| t.side == Side::Sell).collect();
        assert_eq!(sells.len(), 1);
        assert!((sells[0].price - 12.0).abs() < 1e-9, "price = {}", sells[0].price);
        assert!(r.closed_trades[0].pnl > 0.0);
    }

    #[test]
    fn t_plus_one_blocks_same_day_sell() {
        // 第 0 根信号 -> 第 1 根开盘买入；同一根 Bar 内出现 Exit 信号也不应同日卖出
        let bars = vec![
            bar("2026-01-05", 10.0, 10.0, 10.0, 10.0),
            bar("2026-01-06", 10.0, 10.5, 9.9, 10.0),
            bar("2026-01-07", 10.0, 10.5, 9.9, 10.0),
        ];
        let cfg = flat_config();
        // 第 1 根收盘产生 Exit，只能在第 2 根开盘执行
        let signals = vec![Signal::TargetPosition(1.0), Signal::Exit, Signal::Hold];
        let r = Runner::new(&bars, &cfg, "x", "s", "s").run(&signals).unwrap();
        let sells: Vec<&Trade> = r.trades.iter().filter(|t| t.side == Side::Sell).collect();
        assert_eq!(sells.len(), 1);
        assert_eq!(sells[0].date, "2026-01-07");
    }

    #[test]
    fn max_position_pct_limits_exposure() {
        let bars = vec![
            bar("2026-01-05", 10.0, 10.0, 10.0, 10.0),
            bar("2026-01-06", 10.0, 10.0, 10.0, 10.0),
        ];
        let mut cfg = flat_config();
        cfg.max_position_pct = 0.5;
        let signals = vec![Signal::TargetPosition(1.0), Signal::Hold];
        let r = Runner::new(&bars, &cfg, "x", "s", "s").run(&signals).unwrap();
        // 5 万元 / 10 元 = 5000 股
        assert_eq!(r.trades[0].shares, 5000.0);
        assert!((r.equity_curve[1].cash - 50_000.0).abs() < 1e-6);
    }

    #[test]
    fn insufficient_cash_buys_nothing() {
        let bars = vec![
            bar("2026-01-05", 1_000_000.0, 1_000_000.0, 1_000_000.0, 1_000_000.0),
            bar("2026-01-06", 1_000_000.0, 1_000_000.0, 1_000_000.0, 1_000_000.0),
        ];
        let cfg = flat_config();
        let signals = vec![Signal::TargetPosition(1.0), Signal::Hold];
        let r = Runner::new(&bars, &cfg, "x", "s", "s").run(&signals).unwrap();
        assert!(r.trades.is_empty());
        assert_eq!(r.final_equity, cfg.initial_cash);
    }

    #[test]
    fn rejects_short_or_mismatched_input() {
        let bars = vec![bar("2026-01-05", 1.0, 1.0, 1.0, 1.0)];
        let cfg = flat_config();
        assert_eq!(
            Runner::new(&bars, &cfg, "x", "s", "s").run(&[Signal::Hold]),
            Err(BacktestError::NotEnoughBars)
        );

        let bars2 = vec![
            bar("2026-01-05", 1.0, 1.0, 1.0, 1.0),
            bar("2026-01-06", 1.0, 1.0, 1.0, 1.0),
        ];
        assert!(matches!(
            Runner::new(&bars2, &cfg, "x", "s", "s").run(&[Signal::Hold]),
            Err(BacktestError::SignalLengthMismatch { .. })
        ));
    }

    #[test]
    fn invalid_config_rejected() {
        let bars = vec![
            bar("2026-01-05", 1.0, 1.0, 1.0, 1.0),
            bar("2026-01-06", 1.0, 1.0, 1.0, 1.0),
        ];
        let mut cfg = flat_config();
        cfg.initial_cash = -1.0;
        assert!(matches!(
            Runner::new(&bars, &cfg, "x", "s", "s").run(&[Signal::Hold, Signal::Hold]),
            Err(BacktestError::InvalidConfig(_))
        ));
    }

    #[test]
    fn equity_curve_length_matches_bars() {
        let bars: Vec<Bar> = (0..20)
            .map(|i| bar(&format!("2026-01-{:02}", i + 1), 10.0, 10.0, 10.0, 10.0))
            .collect();
        let cfg = flat_config();
        let signals = vec![Signal::Hold; bars.len()];
        let r = Runner::new(&bars, &cfg, "x", "s", "s").run(&signals).unwrap();
        assert_eq!(r.equity_curve.len(), bars.len());
        assert_eq!(r.bars, bars.len());
    }

    #[test]
    fn days_between_works() {
        assert_eq!(days_between("2026-01-05", "2026-01-06"), 1);
        assert_eq!(days_between("2026-01-05", "2026-02-05"), 31);
        assert_eq!(days_between("bad", "2026-01-06"), 0);
    }

    #[test]
    fn win_rate_counts_profitable_round_trips() {
        // 两轮交易：第一轮赚，第二轮亏
        let bars = vec![
            bar("2026-01-05", 10.0, 10.0, 10.0, 10.0),
            bar("2026-01-06", 10.0, 10.0, 10.0, 10.0), // 买入 10
            bar("2026-01-07", 12.0, 12.0, 12.0, 12.0), // 卖出 12 -> 赚
            bar("2026-01-08", 12.0, 12.0, 12.0, 12.0),
            bar("2026-01-09", 12.0, 12.0, 12.0, 12.0), // 再买入 12
            bar("2026-01-12", 9.0, 9.0, 9.0, 9.0),     // 卖出 9 -> 亏
        ];
        let cfg = flat_config();
        let signals = vec![
            Signal::TargetPosition(1.0),
            Signal::Exit,
            Signal::TargetPosition(1.0),
            Signal::Exit,
            Signal::Hold,
            Signal::Hold,
        ];
        let r = Runner::new(&bars, &cfg, "x", "s", "s").run(&signals).unwrap();
        assert_eq!(r.closed_trades.len(), 2, "closed = {:?}", r.closed_trades);
        assert!((r.metrics.win_rate - 0.5).abs() < 1e-9);
        assert!(r.metrics.profit_factor > 0.0);
    }
}
