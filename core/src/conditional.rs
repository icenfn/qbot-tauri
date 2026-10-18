//! 条件单引擎。
//!
//! 交易网关通常只接受「立刻生效」的委托，而实务中大量需求是「到达某个条件再下单」：
//! 跌破 9 元止损、突破 12 元追涨、日内涨幅超过 5% 减仓、14:50 收盘前平掉短线仓位。
//! 这些规则放在本地评估有两点好处：
//! 1. **三端一致**：不依赖券商是否支持条件单（各家差异极大）；
//! 2. **可回放校验**：评估函数是纯函数，给定「上一价 → 当前价」即可稳定复现是否触发，
//!    便于单元测试与事后复盘。
//!
//! 触发判定用「跨越」语义（crossing）而不是「状态」语义（state）：
//! 只有当上一根价格在阈值一侧、当前价到另一侧时才触发，避免价格长期高于阈值时反复下单。

use crate::types::Side;

/// 条件类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TriggerKind {
    /// 价格上穿阈值（上一价 <= 阈值 < 当前价）
    PriceAbove,
    /// 价格下穿阈值（上一价 >= 阈值 > 当前价）
    PriceBelow,
    /// 相对参考价的涨幅达到阈值（+5% 表示 reference × 1.05）
    ChangeUp,
    /// 相对参考价的跌幅达到阈值（-5% 表示 reference × 0.95）
    ChangeDown,
    /// 到达指定时刻（距零点分钟数 >= 指定值，且当日只触发一次）
    TimeReached,
}

impl TriggerKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            TriggerKind::PriceAbove => "price_above",
            TriggerKind::PriceBelow => "price_below",
            TriggerKind::ChangeUp => "change_up",
            TriggerKind::ChangeDown => "change_down",
            TriggerKind::TimeReached => "time_reached",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "price_above" => Some(TriggerKind::PriceAbove),
            "price_below" => Some(TriggerKind::PriceBelow),
            "change_up" => Some(TriggerKind::ChangeUp),
            "change_down" => Some(TriggerKind::ChangeDown),
            "time_reached" => Some(TriggerKind::TimeReached),
            _ => None,
        }
    }

    /// 时间条件不需要价格数据。
    pub fn needs_price(&self) -> bool {
        *self != TriggerKind::TimeReached
    }
}

/// 条件单状态机：
/// `Armed` --触发--> `Triggered` --下单成功--> `Filled` / --失败--> `Failed`
/// 任意状态（除 Filled/Failed）可 `Cancelled`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConditionalState {
    Armed,
    Triggered,
    Filled,
    Failed,
    Cancelled,
}

impl ConditionalState {
    pub fn as_str(&self) -> &'static str {
        match self {
            ConditionalState::Armed => "armed",
            ConditionalState::Triggered => "triggered",
            ConditionalState::Filled => "filled",
            ConditionalState::Failed => "failed",
            ConditionalState::Cancelled => "cancelled",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "armed" => Some(ConditionalState::Armed),
            "triggered" => Some(ConditionalState::Triggered),
            "filled" => Some(ConditionalState::Filled),
            "failed" => Some(ConditionalState::Failed),
            "cancelled" => Some(ConditionalState::Cancelled),
            _ => None,
        }
    }

    /// 是否已进入终态（不再参与轮询）。
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            ConditionalState::Filled | ConditionalState::Failed | ConditionalState::Cancelled
        )
    }
}

/// 条件单定义。
#[derive(Debug, Clone, PartialEq)]
pub struct ConditionalOrder {
    pub id: String,
    pub symbol: String,
    pub kind: TriggerKind,
    /// 阈值：价格类为价格，涨跌幅类为比例（0.05），时间类为距零点分钟数
    pub threshold: f64,
    /// 参考价：涨跌幅类必填（通常是下单时的现价或成本价）
    pub reference_price: f64,
    /// 触发后要下的单
    pub side: Side,
    pub volume: f64,
    /// 触发后使用的价格；`None` 表示市价
    pub limit_price: Option<f64>,
    pub state: ConditionalState,
    /// 作用日（YYYY-MM-DD），跨日后自动失效，避免隔夜条件单意外成交
    pub trade_date: String,
    /// 当日是否已触发过（配合 TimeReached 的「每天一次」语义）
    pub fired_today: bool,
    pub note: String,
}

impl ConditionalOrder {
    /// 构造一张价格类条件单。
    pub fn price_trigger(
        id: impl Into<String>,
        symbol: impl Into<String>,
        kind: TriggerKind,
        threshold: f64,
        side: Side,
        volume: f64,
        trade_date: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            symbol: symbol.into(),
            kind,
            threshold,
            reference_price: 0.0,
            side,
            volume,
            limit_price: None,
            state: ConditionalState::Armed,
            trade_date: trade_date.into(),
            fired_today: false,
            note: String::new(),
        }
    }

    pub fn with_reference(mut self, price: f64) -> Self {
        self.reference_price = price;
        self
    }

    pub fn with_limit_price(mut self, price: f64) -> Self {
        self.limit_price = Some(price);
        self
    }

    /// 配置是否自洽：涨跌幅类必须有正参考价，数量与阈值必须为正。
    pub fn validate(&self) -> Result<(), String> {
        if self.symbol.trim().is_empty() {
            return Err("缺少标的代码".into());
        }
        if !(self.volume > 0.0) || !self.volume.is_finite() {
            return Err("数量必须为正数".into());
        }
        if self.kind.needs_price() {
            if !(self.threshold > 0.0) || !self.threshold.is_finite() {
                return Err("价格/涨跌幅阈值必须为正数".into());
            }
        } else if !(self.threshold >= 0.0) || !(self.threshold < 24.0 * 60.0) {
            return Err("时间阈值必须是 0-1439 之间的分钟数".into());
        }
        if matches!(self.kind, TriggerKind::ChangeUp | TriggerKind::ChangeDown) {
            if !(self.reference_price > 0.0) || !self.reference_price.is_finite() {
                return Err("涨跌幅条件单必须提供有效的参考价".into());
            }
        }
        if let Some(lp) = self.limit_price {
            if !(lp > 0.0) || !lp.is_finite() {
                return Err("委托价必须为正数".into());
            }
        }
        Ok(())
    }

    /// 计算涨跌幅类条件单对应的绝对价格阈值。
    pub fn effective_price_threshold(&self) -> Option<f64> {
        match self.kind {
            TriggerKind::ChangeUp => Some(self.reference_price * (1.0 + self.threshold)),
            TriggerKind::ChangeDown => Some(self.reference_price * (1.0 - self.threshold)),
            TriggerKind::PriceAbove | TriggerKind::PriceBelow => Some(self.threshold),
            TriggerKind::TimeReached => None,
        }
    }
}

/// 一轮评估所需的市场快照。
#[derive(Debug, Clone, PartialEq)]
pub struct Tick {
    /// 上一笔价格（用于跨越判定）
    pub prev_price: f64,
    /// 最新价
    pub last_price: f64,
    /// 当前时间（距零点分钟数）
    pub current_minute: u32,
    /// 当前交易日（YYYY-MM-DD）
    pub trade_date: String,
}

/// 评估结果。
#[derive(Debug, Clone, PartialEq)]
pub enum TriggerOutcome {
    /// 未触发；附原因便于前端展示「还差多少」
    NotTriggered { reason: String },
    /// 已触发，应下单
    Triggered { reason: String },
    /// 跳过（已终态、非本交易日等）
    Skipped { reason: String },
}

impl TriggerOutcome {
    pub fn is_triggered(&self) -> bool {
        matches!(self, TriggerOutcome::Triggered { .. })
    }
}

/// 评估单张条件单。
///
/// 判定顺序：终态/日期 → 状态非 Armed → 数据合法性 → 时间类 → 价格类。
pub fn evaluate(order: &ConditionalOrder, tick: &Tick) -> TriggerOutcome {
    if order.state.is_terminal() {
        return TriggerOutcome::Skipped {
            reason: format!("条件单状态为 {}，不再评估", order.state.as_str()),
        };
    }
    // 跨日失效：昨日挂出的条件单不在今天生效，需要用户重新确认
    if !order.trade_date.is_empty() && order.trade_date != tick.trade_date {
        return TriggerOutcome::Skipped {
            reason: format!(
                "条件单只对 {} 生效，当前交易日为 {}",
                order.trade_date, tick.trade_date
            ),
        };
    }
    if order.state != ConditionalState::Armed && order.state != ConditionalState::Triggered {
        return TriggerOutcome::Skipped {
            reason: "条件单当前状态不允许触发".into(),
        };
    }

    if let Err(e) = order.validate() {
        return TriggerOutcome::Skipped { reason: e };
    }

    match order.kind {
        TriggerKind::TimeReached => {
            if order.fired_today {
                return TriggerOutcome::NotTriggered {
                    reason: "今日已按时间触发过".into(),
                };
            }
            let target = order.threshold as u32;
            if tick.current_minute >= target {
                TriggerOutcome::Triggered {
                    reason: format!(
                        "已到时间 {:02}:{:02}（当前 {:02}:{:02}）",
                        target / 60,
                        target % 60,
                        tick.current_minute / 60,
                        tick.current_minute % 60
                    ),
                }
            } else {
                TriggerOutcome::NotTriggered {
                    reason: format!("距目标时间还有 {} 分钟", target - tick.current_minute),
                }
            }
        }
        TriggerKind::PriceAbove => {
            if !valid_price(tick.prev_price) || !valid_price(tick.last_price) {
                return TriggerOutcome::Skipped {
                    reason: "缺少有效价格".into(),
                };
            }
            // 上穿：上一价在阈值下方（含等于），当前价严格上方
            if tick.prev_price <= order.threshold && tick.last_price > order.threshold {
                TriggerOutcome::Triggered {
                    reason: format!(
                        "价格上穿 {:.3}（{:.3} → {:.3}）",
                        order.threshold, tick.prev_price, tick.last_price
                    ),
                }
            } else {
                not_reached(tick.last_price, order.threshold, "上穿")
            }
        }
        TriggerKind::PriceBelow => {
            if !valid_price(tick.prev_price) || !valid_price(tick.last_price) {
                return TriggerOutcome::Skipped {
                    reason: "缺少有效价格".into(),
                };
            }
            if tick.prev_price >= order.threshold && tick.last_price < order.threshold {
                TriggerOutcome::Triggered {
                    reason: format!(
                        "价格下穿 {:.3}（{:.3} → {:.3}）",
                        order.threshold, tick.prev_price, tick.last_price
                    ),
                }
            } else {
                not_reached(tick.last_price, order.threshold, "下穿")
            }
        }
        TriggerKind::ChangeUp | TriggerKind::ChangeDown => {
            if !valid_price(tick.prev_price) || !valid_price(tick.last_price) {
                return TriggerOutcome::Skipped {
                    reason: "缺少有效价格".into(),
                };
            }
            let target = match order.effective_price_threshold() {
                Some(t) => t,
                None => {
                    return TriggerOutcome::Skipped {
                        reason: "无法计算目标价".into(),
                    }
                }
            };
            let change = tick.last_price / order.reference_price - 1.0;
            if order.kind == TriggerKind::ChangeUp {
                if tick.prev_price <= target && tick.last_price > target {
                    TriggerOutcome::Triggered {
                        reason: format!(
                            "涨幅达 {:.2}%（现价 {:.3}，参考价 {:.3}）",
                            change * 100.0,
                            tick.last_price,
                            order.reference_price
                        ),
                    }
                } else {
                    not_reached(tick.last_price, target, "上穿")
                }
            } else if tick.prev_price >= target && tick.last_price < target {
                TriggerOutcome::Triggered {
                    reason: format!(
                        "跌幅达 {:.2}%（现价 {:.3}，参考价 {:.3}）",
                        change * 100.0,
                        tick.last_price,
                        order.reference_price
                    ),
                }
            } else {
                not_reached(tick.last_price, target, "下穿")
            }
        }
    }
}

fn valid_price(p: f64) -> bool {
    p.is_finite() && p > 0.0
}

fn not_reached(last: f64, target: f64, direction: &str) -> TriggerOutcome {
    let diff = target - last;
    TriggerOutcome::NotTriggered {
        reason: format!(
            "尚未{direction} {:.3}，当前 {:.3}，相差 {:.3}",
            target, last, diff
        ),
    }
}

/// 状态迁移：触发后置为 `Triggered`，并记录当日已触发。
pub fn mark_triggered(order: &mut ConditionalOrder) {
    order.state = ConditionalState::Triggered;
    order.fired_today = true;
}

/// 下单结果回写。
pub fn settle(order: &mut ConditionalOrder, success: bool) {
    order.state = if success {
        ConditionalState::Filled
    } else {
        ConditionalState::Failed
    };
}

/// 撤单：只有未进入终态的条件单可以撤销。
pub fn cancel(order: &mut ConditionalOrder) -> Result<(), String> {
    if order.state.is_terminal() {
        return Err(format!(
            "条件单已是 {} 状态，无法撤销",
            order.state.as_str()
        ));
    }
    order.state = ConditionalState::Cancelled;
    Ok(())
}

/// 跨日重置：把仍处于 Armed 的条件单推进到新交易日。
/// 返回被自动作废的数量（跨日条件单不再生效，需用户重新确认）。
pub fn rollover(orders: &mut [ConditionalOrder], new_date: &str) -> usize {
    let mut expired = 0;
    for o in orders.iter_mut() {
        if o.trade_date != new_date && !o.state.is_terminal() {
            o.state = ConditionalState::Cancelled;
            o.note = format!("跨日失效：原定 {} 生效", o.trade_date);
            expired += 1;
        } else if o.trade_date == new_date {
            o.fired_today = false;
        }
    }
    expired
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tick(prev: f64, last: f64, minute: u32) -> Tick {
        Tick {
            prev_price: prev,
            last_price: last,
            current_minute: minute,
            trade_date: "2026-10-19".into(),
        }
    }

    fn price_order(kind: TriggerKind, threshold: f64) -> ConditionalOrder {
        ConditionalOrder::price_trigger(
            "c1",
            "600519",
            kind,
            threshold,
            Side::Sell,
            100.0,
            "2026-10-19",
        )
    }

    #[test]
    fn kind_roundtrip() {
        for k in [
            TriggerKind::PriceAbove,
            TriggerKind::PriceBelow,
            TriggerKind::ChangeUp,
            TriggerKind::ChangeDown,
            TriggerKind::TimeReached,
        ] {
            assert_eq!(TriggerKind::from_str(k.as_str()), Some(k));
        }
        assert_eq!(TriggerKind::from_str("nope"), None);
    }

    #[test]
    fn state_roundtrip_and_terminal() {
        for s in [
            ConditionalState::Armed,
            ConditionalState::Triggered,
            ConditionalState::Filled,
            ConditionalState::Failed,
            ConditionalState::Cancelled,
        ] {
            assert_eq!(ConditionalState::from_str(s.as_str()), Some(s));
        }
        assert!(!ConditionalState::Armed.is_terminal());
        assert!(!ConditionalState::Triggered.is_terminal());
        assert!(ConditionalState::Filled.is_terminal());
        assert!(ConditionalState::Failed.is_terminal());
        assert!(ConditionalState::Cancelled.is_terminal());
    }

    #[test]
    fn validate_basics() {
        assert!(price_order(TriggerKind::PriceAbove, 10.0)
            .validate()
            .is_ok());

        let mut o = price_order(TriggerKind::PriceAbove, 10.0);
        o.volume = 0.0;
        assert!(o.validate().is_err());

        let mut o = price_order(TriggerKind::PriceAbove, 0.0);
        o.volume = 100.0;
        assert!(o.validate().is_err());

        // 涨跌幅必须有参考价
        let mut o = price_order(TriggerKind::ChangeUp, 0.05);
        assert!(o.validate().is_err());
        o.reference_price = 10.0;
        assert!(o.validate().is_ok());

        // 时间类阈值范围
        let mut o = price_order(TriggerKind::TimeReached, 1500.0);
        o.volume = 100.0;
        assert!(o.validate().is_err());
        o.threshold = 870.0; // 14:30
        assert!(o.validate().is_ok());
    }

    #[test]
    fn price_above_crosses_only_once() {
        let o = price_order(TriggerKind::PriceAbove, 10.0);
        // 9.9 → 10.1 上穿
        assert!(evaluate(&o, &tick(9.9, 10.1, 600)).is_triggered());
        // 已在阈值上方，继续上涨不再触发
        assert!(!evaluate(&o, &tick(10.1, 10.5, 601)).is_triggered());
        // 恰好等于阈值不算穿越
        assert!(!evaluate(&o, &tick(10.0, 10.0, 602)).is_triggered());
        // 从下方接近未到
        assert!(!evaluate(&o, &tick(9.8, 9.9, 603)).is_triggered());
    }

    #[test]
    fn price_below_crosses() {
        let o = price_order(TriggerKind::PriceBelow, 9.0);
        assert!(evaluate(&o, &tick(9.1, 8.9, 600)).is_triggered());
        assert!(!evaluate(&o, &tick(8.9, 8.5, 601)).is_triggered());
        assert!(!evaluate(&o, &tick(9.0, 9.0, 602)).is_triggered());
    }

    #[test]
    fn change_up_uses_reference() {
        let mut o = price_order(TriggerKind::ChangeUp, 0.05);
        o.reference_price = 10.0; // 目标 10.5
        assert!(evaluate(&o, &tick(10.4, 10.6, 600)).is_triggered());
        assert!(!evaluate(&o, &tick(10.6, 10.8, 601)).is_triggered());
    }

    #[test]
    fn change_down_uses_reference() {
        let mut o = price_order(TriggerKind::ChangeDown, 0.05);
        o.reference_price = 10.0; // 目标 9.5
        assert!(evaluate(&o, &tick(9.6, 9.4, 600)).is_triggered());
        assert!(!evaluate(&o, &tick(9.4, 9.2, 601)).is_triggered());
    }

    #[test]
    fn time_reached_fires_once() {
        let mut o = price_order(TriggerKind::TimeReached, 870.0); // 14:30
        assert!(!evaluate(&o, &tick(0.0, 0.0, 869)).is_triggered());
        assert!(evaluate(&o, &tick(0.0, 0.0, 870)).is_triggered());
        // 已触发过不再重复
        mark_triggered(&mut o);
        assert!(!evaluate(&o, &tick(0.0, 0.0, 880)).is_triggered());
        // 直接跨过目标时间也应触发
        let mut o2 = price_order(TriggerKind::TimeReached, 870.0);
        assert!(evaluate(&o2, &tick(0.0, 0.0, 895)).is_triggered());
        mark_triggered(&mut o2);
        assert!(!evaluate(&o2, &tick(0.0, 0.0, 899)).is_triggered());
    }

    #[test]
    fn terminal_state_skipped() {
        let mut o = price_order(TriggerKind::PriceAbove, 10.0);
        o.state = ConditionalState::Cancelled;
        let out = evaluate(&o, &tick(9.9, 10.5, 600));
        assert!(matches!(out, TriggerOutcome::Skipped { .. }));
    }

    #[test]
    fn other_trade_date_skipped() {
        let o = price_order(TriggerKind::PriceAbove, 10.0);
        let mut t = tick(9.9, 10.5, 600);
        t.trade_date = "2026-10-20".into();
        assert!(matches!(evaluate(&o, &t), TriggerOutcome::Skipped { .. }));
    }

    #[test]
    fn invalid_price_skipped() {
        let o = price_order(TriggerKind::PriceAbove, 10.0);
        assert!(matches!(
            evaluate(&o, &tick(0.0, 10.5, 600)),
            TriggerOutcome::Skipped { .. }
        ));
    }

    #[test]
    fn state_machine_flow() {
        let mut o = price_order(TriggerKind::PriceAbove, 10.0);
        assert_eq!(o.state, ConditionalState::Armed);
        mark_triggered(&mut o);
        assert_eq!(o.state, ConditionalState::Triggered);
        assert!(o.fired_today);
        settle(&mut o, true);
        assert_eq!(o.state, ConditionalState::Filled);
        // 终态不可撤销
        assert!(cancel(&mut o).is_err());
    }

    #[test]
    fn cancel_armed_ok() {
        let mut o = price_order(TriggerKind::PriceAbove, 10.0);
        assert!(cancel(&mut o).is_ok());
        assert_eq!(o.state, ConditionalState::Cancelled);
    }

    #[test]
    fn rollover_expires_old_and_resets_today() {
        let mut a = price_order(TriggerKind::PriceAbove, 10.0); // 2026-10-19
        let mut b = price_order(TriggerKind::PriceAbove, 10.0);
        b.trade_date = "2026-10-20".into();
        b.fired_today = true;
        let expired = rollover(&mut [a.clone(), b.clone()], "2026-10-20");
        assert_eq!(expired, 1);
        // 跨日的被作废
        let mut orders = vec![a.clone(), b.clone()];
        rollover(&mut orders, "2026-10-20");
        assert_eq!(orders[0].state, ConditionalState::Cancelled);
        assert!(orders[0].note.contains("跨日"));
        // 当日的复位 fired_today
        assert!(!orders[1].fired_today);
    }

    #[test]
    fn effective_price_threshold_values() {
        let mut o = price_order(TriggerKind::ChangeUp, 0.1);
        o.reference_price = 10.0;
        assert!((o.effective_price_threshold().unwrap() - 11.0).abs() < 1e-9);

        let mut o = price_order(TriggerKind::ChangeDown, 0.1);
        o.reference_price = 10.0;
        assert!((o.effective_price_threshold().unwrap() - 9.0).abs() < 1e-9);

        let o = price_order(TriggerKind::PriceAbove, 12.0);
        assert_eq!(o.effective_price_threshold(), Some(12.0));

        let o = price_order(TriggerKind::TimeReached, 870.0);
        assert_eq!(o.effective_price_threshold(), None);
    }

    #[test]
    fn limit_price_validation() {
        let mut o = price_order(TriggerKind::PriceAbove, 10.0);
        o.limit_price = Some(0.0);
        assert!(o.validate().is_err());
        o.limit_price = Some(10.5);
        assert!(o.validate().is_ok());
    }
}
