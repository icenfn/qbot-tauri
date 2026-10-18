//! 策略层。
//!
//! 设计原则：
//! - 策略只负责「根据 K 线给出目标仓位意图」，不关心资金、费用、撮合；
//!   这些交给回测引擎统一处理，保证不同策略之间可比。
//! - 每个策略都声明参数规格（`ParamSpec`），前端据此自动渲染表单，
//!   参数范围与默认值集中在 Rust 一处定义，避免前后端各写一套。
//! - 预热期不足时一律返回 `Hold`，绝不在指标未成形时下单。

use crate::indicators as ind;
use crate::types::{param_float, param_int, Bar, ParamKind, ParamSpec, Params, Signal, StrategyMeta};

/// 策略统一接口。
pub trait Strategy {
    /// 策略标识、名称、说明与参数规格。
    fn meta(&self) -> StrategyMeta;

    /// 生成信号序列，长度与 `bars` 相同。
    fn signals(&self, bars: &[Bar], params: &Params) -> Vec<Signal>;
}

fn spec(
    key: &str,
    label: &str,
    kind: ParamKind,
    default_value: f64,
    min: f64,
    max: f64,
    step: f64,
    hint: &str,
) -> ParamSpec {
    ParamSpec {
        key: key.to_string(),
        label: label.to_string(),
        kind,
        default_value,
        min: Some(min),
        max: Some(max),
        step: Some(step),
        hint: hint.to_string(),
    }
}

fn closes(bars: &[Bar]) -> Vec<f64> {
    bars.iter().map(|b| b.close).collect()
}
fn highs(bars: &[Bar]) -> Vec<f64> {
    bars.iter().map(|b| b.high).collect()
}
fn lows(bars: &[Bar]) -> Vec<f64> {
    bars.iter().map(|b| b.low).collect()
}
fn volumes(bars: &[Bar]) -> Vec<f64> {
    bars.iter().map(|b| b.volume).collect()
}

// ---------------------------------------------------------------------------
// 1. 双均线
// ---------------------------------------------------------------------------

pub struct DualMa;

impl Strategy for DualMa {
    fn meta(&self) -> StrategyMeta {
        StrategyMeta {
            id: "dual_ma".into(),
            name: "双均线".into(),
            description: "快线上穿慢线（金叉）买入，下穿（死叉）清仓。趋势跟踪的基准策略。".into(),
            params: vec![
                spec("fast", "快线周期", ParamKind::Int, 5.0, 2.0, 60.0, 1.0, "短周期均线，越小越灵敏"),
                spec("slow", "慢线周期", ParamKind::Int, 20.0, 3.0, 250.0, 1.0, "长周期均线，判定趋势方向"),
            ],
        }
    }

    fn signals(&self, bars: &[Bar], params: &Params) -> Vec<Signal> {
        let n = bars.len();
        let mut out = vec![Signal::Hold; n];
        let close = closes(bars);
        let fast = param_int(params, "fast", 5, 1);
        let slow = param_int(params, "slow", 20, 2);
        if fast >= slow || n < slow {
            return out;
        }
        let ma_fast = ind::sma(&close, fast);
        let ma_slow = ind::sma(&close, slow);
        let mut holding = false;
        for i in 0..n {
            if ind::crossover(&ma_fast, &ma_slow, i) && !holding {
                out[i] = Signal::TargetPosition(1.0);
                holding = true;
            } else if ind::crossunder(&ma_fast, &ma_slow, i) && holding {
                out[i] = Signal::Exit;
                holding = false;
            }
        }
        out
    }
}

// ---------------------------------------------------------------------------
// 2. MACD
// ---------------------------------------------------------------------------

pub struct MacdStrategy;

impl Strategy for MacdStrategy {
    fn meta(&self) -> StrategyMeta {
        StrategyMeta {
            id: "macd".into(),
            name: "MACD".into(),
            description: "DIF 上穿 DEA 且柱状值为正时买入，下穿时清仓。可选只在零轴上方做多。".into(),
            params: vec![
                spec("fast", "快线 EMA", ParamKind::Int, 12.0, 2.0, 60.0, 1.0, "常用 12"),
                spec("slow", "慢线 EMA", ParamKind::Int, 26.0, 3.0, 120.0, 1.0, "常用 26"),
                spec("signal", "信号线", ParamKind::Int, 9.0, 2.0, 60.0, 1.0, "常用 9"),
                spec("above_zero", "仅零轴上方", ParamKind::Int, 0.0, 0.0, 1.0, 1.0, "1 = 只在 DIF>0 时买入"),
            ],
        }
    }

    fn signals(&self, bars: &[Bar], params: &Params) -> Vec<Signal> {
        let n = bars.len();
        let mut out = vec![Signal::Hold; n];
        let close = closes(bars);
        let fast = param_int(params, "fast", 12, 2);
        let slow = param_int(params, "slow", 26, 3);
        let signal = param_int(params, "signal", 9, 2);
        let above_zero = param_float(params, "above_zero", 0.0) > 0.5;
        if fast >= slow || n < slow + signal {
            return out;
        }
        let (dif, dea, _hist) = ind::macd(&close, fast, slow, signal);
        let mut holding = false;
        for i in 0..n {
            if ind::crossover(&dif, &dea, i) {
                let ok = !above_zero || dif[i].map(|v| v > 0.0).unwrap_or(false);
                if ok && !holding {
                    out[i] = Signal::TargetPosition(1.0);
                    holding = true;
                }
            } else if ind::crossunder(&dif, &dea, i) && holding {
                out[i] = Signal::Exit;
                holding = false;
            }
        }
        out
    }
}

// ---------------------------------------------------------------------------
// 3. KDJ
// ---------------------------------------------------------------------------

pub struct KdjStrategy;

impl Strategy for KdjStrategy {
    fn meta(&self) -> StrategyMeta {
        StrategyMeta {
            id: "kdj".into(),
            name: "KDJ".into(),
            description: "K 在超卖区上穿 D 买入，在超买区下穿 D 清仓。适合震荡市。".into(),
            params: vec![
                spec("n", "RSV 周期", ParamKind::Int, 9.0, 3.0, 60.0, 1.0, "常用 9"),
                spec("oversold", "超卖阈值", ParamKind::Float, 25.0, 5.0, 50.0, 1.0, "K 低于此值视为超卖"),
                spec("overbought", "超买阈值", ParamKind::Float, 75.0, 50.0, 95.0, 1.0, "K 高于此值视为超买"),
            ],
        }
    }

    fn signals(&self, bars: &[Bar], params: &Params) -> Vec<Signal> {
        let n = bars.len();
        let mut out = vec![Signal::Hold; n];
        let n_period = param_int(params, "n", 9, 3);
        let oversold = param_float(params, "oversold", 25.0);
        let overbought = param_float(params, "overbought", 75.0);
        if n < n_period {
            return out;
        }
        let (k, d, _j) = ind::kdj(&highs(bars), &lows(bars), &closes(bars), n_period, 3.0, 3.0);
        let mut holding = false;
        for i in 0..n {
            let kv = k[i];
            if ind::crossover(&k, &d, i) {
                if kv.map(|v| v < oversold).unwrap_or(false) && !holding {
                    out[i] = Signal::TargetPosition(1.0);
                    holding = true;
                }
            } else if ind::crossunder(&k, &d, i) && holding {
                if kv.map(|v| v > overbought).unwrap_or(false) {
                    out[i] = Signal::Exit;
                    holding = false;
                }
            }
        }
        out
    }
}

// ---------------------------------------------------------------------------
// 4. 布林带
// ---------------------------------------------------------------------------

pub struct BollStrategy;

impl Strategy for BollStrategy {
    fn meta(&self) -> StrategyMeta {
        StrategyMeta {
            id: "boll".into(),
            name: "布林带".into(),
            description: "收盘跌破下轨买入（均值回归），突破上轨或回到中轨清仓。".into(),
            params: vec![
                spec("period", "均线周期", ParamKind::Int, 20.0, 5.0, 120.0, 1.0, "常用 20"),
                spec("mult", "标准差倍数", ParamKind::Float, 2.0, 1.0, 4.0, 0.1, "常用 2.0"),
                spec("exit_at_mid", "中轨离场", ParamKind::Int, 1.0, 0.0, 1.0, 1.0, "1 = 回到中轨即卖出"),
            ],
        }
    }

    fn signals(&self, bars: &[Bar], params: &Params) -> Vec<Signal> {
        let n = bars.len();
        let mut out = vec![Signal::Hold; n];
        let period = param_int(params, "period", 20, 5);
        let mult = param_float(params, "mult", 2.0);
        let exit_at_mid = param_float(params, "exit_at_mid", 1.0) > 0.5;
        if n < period {
            return out;
        }
        let close = closes(bars);
        let (mid, upper, lower) = ind::boll(&close, period, mult);
        let mut holding = false;
        for i in 0..n {
            let (lo, up, md) = (lower[i], upper[i], mid[i]);
            if let (Some(lo), Some(up), Some(md)) = (lo, up, md) {
                if !holding && close[i] < lo {
                    out[i] = Signal::TargetPosition(1.0);
                    holding = true;
                } else if holding {
                    let hit_upper = close[i] > up;
                    let back_to_mid = exit_at_mid && close[i] >= md;
                    if hit_upper || back_to_mid {
                        out[i] = Signal::Exit;
                        holding = false;
                    }
                }
            }
        }
        out
    }
}

// ---------------------------------------------------------------------------
// 5. 海龟交易法则
// ---------------------------------------------------------------------------

pub struct Turtle;

impl Strategy for Turtle {
    fn meta(&self) -> StrategyMeta {
        StrategyMeta {
            id: "turtle".into(),
            name: "海龟交易".into(),
            description: "收盘突破 N 日唐奇安通道上轨买入，跌破 M 日下轨清仓（经典趋势跟随）。".into(),
            params: vec![
                spec("entry", "入场通道", ParamKind::Int, 20.0, 5.0, 120.0, 1.0, "突破 N 日最高价入场"),
                spec("exit", "离场通道", ParamKind::Int, 10.0, 3.0, 60.0, 1.0, "跌破 M 日最低价离场"),
                spec("atr_period", "ATR 周期", ParamKind::Int, 14.0, 5.0, 60.0, 1.0, "仅用于风险提示展示"),
            ],
        }
    }

    fn signals(&self, bars: &[Bar], params: &Params) -> Vec<Signal> {
        let n = bars.len();
        let mut out = vec![Signal::Hold; n];
        let entry = param_int(params, "entry", 20, 5);
        let exit_p = param_int(params, "exit", 10, 3);
        if n <= entry.max(exit_p) {
            return out;
        }
        let high = highs(bars);
        let low = lows(bars);
        let (up, _mid, _dn) = ind::donchian(&high, &low, entry);
        let (_up2, dn2, _mid2) = ind::donchian(&high, &low, exit_p);
        let close = closes(bars);
        let mut holding = false;
        for i in 0..n {
            if let Some(u) = up[i] {
                if !holding && close[i] > u {
                    out[i] = Signal::TargetPosition(1.0);
                    holding = true;
                    continue;
                }
            }
            if holding {
                if let Some(d) = dn2[i] {
                    if close[i] < d {
                        out[i] = Signal::Exit;
                        holding = false;
                    }
                }
            }
        }
        out
    }
}

// ---------------------------------------------------------------------------
// 6. 网格交易
// ---------------------------------------------------------------------------

pub struct Grid;

impl Strategy for Grid {
    fn meta(&self) -> StrategyMeta {
        StrategyMeta {
            id: "grid".into(),
            name: "网格交易".into(),
            description: "以首个有效价格为中枢，每下跌一格加仓、每上涨一格减仓，适合区间震荡。".into(),
            params: vec![
                spec("step_pct", "网格间距(%)", ParamKind::Float, 3.0, 0.5, 20.0, 0.5, "相邻网格的价格差"),
                spec("max_levels", "最大加仓层数", ParamKind::Int, 5.0, 1.0, 20.0, 1.0, "控制最大暴露"),
                spec("warmup", "预热天数", ParamKind::Int, 5.0, 1.0, 60.0, 1.0, "前 N 日只观察不交易"),
            ],
        }
    }

    fn signals(&self, bars: &[Bar], params: &Params) -> Vec<Signal> {
        let n = bars.len();
        let mut out = vec![Signal::Hold; n];
        let step = param_float(params, "step_pct", 3.0).max(0.1) / 100.0;
        let max_levels = param_int(params, "max_levels", 5, 1);
        let warmup = param_int(params, "warmup", 5, 1);
        if n <= warmup {
            return out;
        }

        let mut anchor = bars[warmup - 1].close;
        let mut level: i32 = 0; // 当前持有层数（0 ~ max_levels）
        for i in warmup..n {
            let price = bars[i].close;
            if anchor <= 0.0 {
                anchor = price;
                continue;
            }
            let ratio = price / anchor - 1.0;
            let want_level = if ratio <= 0.0 {
                // 下跌：每跌一格加一层
                ((-ratio / step).floor() as i32).min(max_levels as i32)
            } else {
                // 上涨：每涨一格减一层，最低 0
                -((-ratio / step).floor() as i32).max(0)
            };
            let target_level = (level - if ratio > 0.0 { (-want_level).max(0) } else { 0 } + if ratio <= 0.0 { want_level } else { 0 })
                .clamp(0, max_levels as i32);

            if target_level > level {
                let pct = target_level as f64 / max_levels as f64;
                out[i] = Signal::TargetPosition(pct);
                level = target_level;
            } else if target_level < level {
                if target_level == 0 {
                    out[i] = Signal::Exit;
                } else {
                    out[i] = Signal::TargetPosition(target_level as f64 / max_levels as f64);
                }
                level = target_level;
            }

            // 价格上涨到中枢上方一格以上时，把中枢上移，避免长期空仓失去锚
            if ratio > step * 2.0 {
                anchor = price;
                level = 0;
            }
        }
        out
    }
}

// ---------------------------------------------------------------------------
// 7. RSI 超买超卖
// ---------------------------------------------------------------------------

pub struct RsiStrategy;

impl Strategy for RsiStrategy {
    fn meta(&self) -> StrategyMeta {
        StrategyMeta {
            id: "rsi".into(),
            name: "RSI 反转".into(),
            description: "RSI 从超卖区上穿阈值买入，进入超买区卖出。经典均值回归策略。".into(),
            params: vec![
                spec("period", "RSI 周期", ParamKind::Int, 14.0, 3.0, 60.0, 1.0, "常用 14"),
                spec("oversold", "超卖阈值", ParamKind::Float, 30.0, 5.0, 45.0, 1.0, "低于此值视为超卖"),
                spec("overbought", "超买阈值", ParamKind::Float, 70.0, 55.0, 95.0, 1.0, "高于此值视为超买"),
            ],
        }
    }

    fn signals(&self, bars: &[Bar], params: &Params) -> Vec<Signal> {
        let n = bars.len();
        let mut out = vec![Signal::Hold; n];
        let period = param_int(params, "period", 14, 3);
        let oversold = param_float(params, "oversold", 30.0);
        let overbought = param_float(params, "overbought", 70.0);
        if n < period + 2 {
            return out;
        }
        let rsi = ind::rsi(&closes(bars), period);
        let mut holding = false;
        for i in 1..n {
            let (prev, cur) = (rsi[i - 1], rsi[i]);
            if let (Some(p), Some(c)) = (prev, cur) {
                if !holding && p <= oversold && c > oversold {
                    out[i] = Signal::TargetPosition(1.0);
                    holding = true;
                } else if holding && c >= overbought {
                    out[i] = Signal::Exit;
                    holding = false;
                }
            }
        }
        out
    }
}

// ---------------------------------------------------------------------------
// 8. 量价突破（成交量确认）
// ---------------------------------------------------------------------------

pub struct VolumeBreakout;

impl Strategy for VolumeBreakout {
    fn meta(&self) -> StrategyMeta {
        StrategyMeta {
            id: "volume_breakout".into(),
            name: "量价突破".into(),
            description: "收盘创 N 日新高且成交量放大到均量 M 倍时买入，跌破跟踪止损离场。".into(),
            params: vec![
                spec("breakout", "突破周期", ParamKind::Int, 20.0, 5.0, 120.0, 1.0, "N 日最高价"),
                spec("vol_mult", "放量倍数", ParamKind::Float, 1.5, 0.5, 5.0, 0.1, "相对 N 日均量"),
                spec("trail", "跟踪止损(%)", ParamKind::Float, 8.0, 1.0, 30.0, 0.5, "从最高点回撤离场"),
            ],
        }
    }

    fn signals(&self, bars: &[Bar], params: &Params) -> Vec<Signal> {
        let n = bars.len();
        let mut out = vec![Signal::Hold; n];
        let breakout = param_int(params, "breakout", 20, 5);
        let vol_mult = param_float(params, "vol_mult", 1.5);
        let trail = param_float(params, "trail", 8.0) / 100.0;
        if n <= breakout {
            return out;
        }
        let high = highs(bars);
        let vol = volumes(bars);
        let close = closes(bars);
        let (up, _m, _d) = ind::donchian(&high, &high, breakout);
        let vol_ma = ind::sma(&vol, breakout);

        let mut holding = false;
        let mut peak = 0.0f64;
        for i in 0..n {
            if !holding {
                if let (Some(u), Some(vma)) = (up[i], vol_ma[i]) {
                    if close[i] > u && vma > 0.0 && vol[i] >= vma * vol_mult {
                        out[i] = Signal::TargetPosition(1.0);
                        holding = true;
                        peak = close[i];
                        continue;
                    }
                }
            } else {
                if close[i] > peak {
                    peak = close[i];
                }
                if peak > 0.0 && close[i] <= peak * (1.0 - trail) {
                    out[i] = Signal::Exit;
                    holding = false;
                    peak = 0.0;
                }
            }
        }
        out
    }
}

/// 全部策略实例。
pub fn all() -> Vec<Box<dyn Strategy>> {
    vec![
        Box::new(DualMa),
        Box::new(MacdStrategy),
        Box::new(KdjStrategy),
        Box::new(BollStrategy),
        Box::new(Turtle),
        Box::new(Grid),
        Box::new(RsiStrategy),
        Box::new(VolumeBreakout),
    ]
}

/// 所有策略的元信息，供前端渲染策略列表与参数表单。
pub fn registry() -> Vec<StrategyMeta> {
    all().iter().map(|s| s.meta()).collect()
}

/// 按 id 查找策略。
pub fn find(id: &str) -> Option<Box<dyn Strategy>> {
    all().into_iter().find(|s| s.meta().id == id)
}

/// 生成信号；id 不存在时返回错误说明。
pub fn signals_for(id: &str, bars: &[Bar], params: &Params) -> Result<Vec<Signal>, String> {
    let strategy = find(id).ok_or_else(|| format!("未知策略：{id}"))?;
    Ok(strategy.signals(bars, params))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_bars(prices: &[f64]) -> Vec<Bar> {
        prices
            .iter()
            .enumerate()
            .map(|(i, p)| Bar {
                date: format!("2026-{:02}-{:02}", (i / 28) + 1, (i % 28) + 1),
                open: *p,
                high: p * 1.01,
                low: p * 0.99,
                close: *p,
                volume: 1_000.0 + i as f64 * 10.0,
                amount: p * 1000.0,
            })
            .collect()
    }

    #[test]
    fn registry_has_unique_ids_and_params() {
        let metas = registry();
        assert!(metas.len() >= 6, "策略数量 = {}", metas.len());
        let mut ids: Vec<&str> = metas.iter().map(|m| m.id.as_str()).collect();
        ids.sort_unstable();
        let before = ids.len();
        ids.dedup();
        assert_eq!(before, ids.len(), "策略 id 必须唯一");
        for meta in metas {
            assert!(!meta.params.is_empty(), "策略 {} 未声明参数", meta.id);
            for p in meta.params {
                assert!(p.min.is_some() && p.max.is_some());
                let (min, max) = (p.min.unwrap(), p.max.unwrap());
                assert!(p.default_value >= min && p.default_value <= max,
                    "参数 {}.{} 默认值越界", meta.id, p.key);
            }
        }
    }

    #[test]
    fn all_strategies_return_full_length_signals() {
        let bars = make_bars(&(0..200).map(|i| 10.0 + (i as f64 * 0.1).sin()).collect::<Vec<_>>());
        let params = Params::new();
        for meta in registry() {
            let signals = signals_for(&meta.id, &bars, &params)
                .unwrap_or_else(|e| panic!("策略 {} 失败: {e}", meta.id));
            assert_eq!(signals.len(), bars.len(), "策略 {} 信号长度不匹配", meta.id);
        }
    }

    #[test]
    fn dual_ma_buys_on_uptrend() {
        // 先跌后持续上涨，应产生至少一次买入
        let mut prices: Vec<f64> = (0..40).map(|i| 20.0 - i as f64 * 0.1).collect();
        prices.extend((0..60).map(|i| 16.0 + i as f64 * 0.3));
        let bars = make_bars(&prices);
        let signals = signals_for("dual_ma", &bars, &Params::new()).unwrap();
        assert!(signals.iter().any(|s| matches!(s, Signal::TargetPosition(_))));
    }

    #[test]
    fn signals_are_hold_during_warmup() {
        let bars = make_bars(&[10.0; 10]);
        let signals = signals_for("dual_ma", &bars, &Params::new()).unwrap();
        assert!(matches!(signals[0], Signal::Hold));
        assert!(matches!(signals[5], Signal::Hold));
    }

    #[test]
    fn unknown_strategy_errors() {
        let bars = make_bars(&[10.0; 5]);
        assert!(signals_for("nope", &bars, &Params::new()).is_err());
    }

    #[test]
    fn macd_respects_zero_axis_filter() {
        let prices: Vec<f64> = (0..150).map(|i| 10.0 + (i as f64 / 15.0).sin() * 3.0).collect();
        let bars = make_bars(&prices);
        let mut with_filter = Params::new();
        with_filter.insert("above_zero".into(), 1.0);
        let a = signals_for("macd", &bars, &Params::new()).unwrap();
        let b = signals_for("macd", &bars, &with_filter).unwrap();
        let count_a = a.iter().filter(|s| matches!(s, Signal::TargetPosition(_))).count();
        let count_b = b.iter().filter(|s| matches!(s, Signal::TargetPosition(_))).count();
        assert!(count_b <= count_a, "零轴过滤后买入次数应不增加");
    }

    #[test]
    fn grid_produces_scaled_positions() {
        let prices: Vec<f64> = (0..120).map(|i| 20.0 + (i as f64 / 8.0).sin() * 3.0).collect();
        let bars = make_bars(&prices);
        let signals = signals_for("grid", &bars, &Params::new()).unwrap();
        // 网格会产生部分仓位（介于 0 和 1 之间）
        let has_partial = signals.iter().any(|s| match s {
            Signal::TargetPosition(r) => *r > 0.0 && *r < 1.0,
            _ => false,
        });
        assert!(has_partial, "网格应产生分批仓位");
    }
}
