//! 交易风控核心。
//!
//! 设计原则：
//! - **风控前置**：所有下单请求必须先过 [`check_order`]，只有 `Approved` 才允许发往网关。
//!   把风控放在本地而不是托管在网关，是因为券商网关的校验口径各不相同，本地一套统一规则
//!   才能保证「三端行为一致」。
//! - **纯函数**：输入是「当前账户快照 + 限制配置 + 订单」，输出是决策，不读时钟、不读文件。
//!   当前时间由调用方以「距零点分钟数」传入，便于测试各种边界（如 11:30 最后一秒）。
//! - **拒绝原因可机读**：返回 [`RejectCode`] 枚举而不是纯字符串，
//!   前端据此决定文案与是否提示用户改单。

use crate::types::Side;

/// 交易时段（按当日分钟数表示，含首尾）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Session {
    pub start_minute: u32,
    pub end_minute: u32,
}

impl Session {
    /// 用 `HH:MM` 构造，格式非法时返回 `None`。
    pub fn from_hm(start: &str, end: &str) -> Option<Self> {
        Some(Self {
            start_minute: parse_hm(start)?,
            end_minute: parse_hm(end)?,
        })
    }

    pub fn contains(&self, minute: u32) -> bool {
        minute >= self.start_minute && minute <= self.end_minute
    }
}

/// 把 `HH:MM` 解析成距零点分钟数。
pub fn parse_hm(text: &str) -> Option<u32> {
    let (h, m) = text.split_once(':')?;
    let hour: u32 = h.trim().parse().ok()?;
    let minute: u32 = m.trim().parse().ok()?;
    if hour > 23 || minute > 59 {
        return None;
    }
    Some(hour * 60 + minute)
}

/// A 股连续竞价时段：09:30–11:30、13:00–15:00。
pub fn a_share_sessions() -> Vec<Session> {
    vec![
        Session {
            start_minute: 9 * 60 + 30,
            end_minute: 11 * 60 + 30,
        },
        Session {
            start_minute: 13 * 60,
            end_minute: 15 * 60,
        },
    ]
}

/// 风控限制配置。
#[derive(Debug, Clone, PartialEq)]
pub struct RiskLimits {
    /// 单只标的持仓市值占净值上限（0.3 = 30%）
    pub max_position_pct: f64,
    /// 单笔委托金额上限（元）
    pub max_single_order_amount: f64,
    /// 单笔委托金额下限（元），过滤「碎单」
    pub min_single_order_amount: f64,
    /// 每日最大下单笔数
    pub max_daily_orders: usize,
    /// 每日最大成交金额（元）
    pub max_daily_turnover: f64,
    /// 净值回撤熔断阈值（0.15 = 回撤 15% 后禁止开新仓）
    pub max_drawdown_pct: f64,
    /// 黑名单（不允许交易的标的）
    pub blacklist: Vec<String>,
    /// 是否强制校验交易时段
    pub enforce_session: bool,
    /// 允许的交易时段
    pub sessions: Vec<Session>,
    /// 买入是否必须是整手（A 股 100 股）
    pub lot_size: f64,
    /// 是否允许在回撤熔断时卖出（默认允许，止损不该被熔断挡住）
    pub allow_sell_when_halted: bool,
}

impl Default for RiskLimits {
    fn default() -> Self {
        Self {
            max_position_pct: 0.3,
            max_single_order_amount: 50_000.0,
            min_single_order_amount: 0.0,
            max_daily_orders: 50,
            max_daily_turnover: 500_000.0,
            max_drawdown_pct: 0.2,
            blacklist: Vec::new(),
            enforce_session: true,
            sessions: a_share_sessions(),
            lot_size: 100.0,
            allow_sell_when_halted: true,
        }
    }
}

impl RiskLimits {
    /// 校验配置合法性，避免用户填出「负数上限」这类无效规则。
    pub fn validate(&self) -> Result<(), String> {
        let pct_fields = [
            ("单标的仓位上限", self.max_position_pct, 0.0, 1.0),
            ("回撤熔断阈值", self.max_drawdown_pct, 0.0, 1.0),
        ];
        for (name, value, lo, hi) in pct_fields {
            if !value.is_finite() || value < lo || value > hi {
                return Err(format!("{name}应在 [{lo}, {hi}] 之间"));
            }
        }
        let amount_fields = [
            ("单笔金额上限", self.max_single_order_amount),
            ("单笔金额下限", self.min_single_order_amount),
            ("每日成交额上限", self.max_daily_turnover),
        ];
        for (name, value) in amount_fields {
            if !value.is_finite() || value < 0.0 {
                return Err(format!("{name}不能为负数"));
            }
        }
        if self.min_single_order_amount > self.max_single_order_amount {
            return Err("单笔金额下限不能大于上限".into());
        }
        if self.lot_size < 1.0 {
            return Err("整手股数至少为 1".into());
        }
        if self.enforce_session && self.sessions.is_empty() {
            return Err("启用交易时段校验时至少要配置一个时段".into());
        }
        for s in &self.sessions {
            if s.start_minute > s.end_minute {
                return Err("交易时段的开始时间不能晚于结束时间".into());
            }
        }
        Ok(())
    }
}

/// 账户与市场快照，由调用方在每次下单前刷新。
#[derive(Debug, Clone, PartialEq)]
pub struct RiskContext {
    /// 账户总净值（现金 + 持仓市值）
    pub total_equity: f64,
    /// 可用现金
    pub available_cash: f64,
    /// 该标的当前持仓市值
    pub position_value: f64,
    /// 该标的当前持仓股数
    pub position_volume: f64,
    /// 今日已下单笔数
    pub today_order_count: usize,
    /// 今日已成交金额
    pub today_turnover: f64,
    /// 历史净值峰值（用于回撤熔断）
    pub peak_equity: f64,
    /// 当前时间（距零点分钟数），由调用方按交易所时区换算
    pub current_minute: u32,
    /// 今天是否为交易日
    pub is_trading_day: bool,
}

/// 待校验的委托。
#[derive(Debug, Clone, PartialEq)]
pub struct OrderRequest {
    pub symbol: String,
    pub side: Side,
    pub price: f64,
    pub volume: f64,
}

impl OrderRequest {
    /// 委托金额（价格 × 数量）。价格或数量非法时返回 0。
    pub fn amount(&self) -> f64 {
        if self.price.is_finite()
            && self.volume.is_finite()
            && self.price > 0.0
            && self.volume > 0.0
        {
            self.price * self.volume
        } else {
            0.0
        }
    }
}

/// 拒绝原因（可机读）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RejectCode {
    InvalidOrder,
    Blacklisted,
    NotTradingDay,
    SessionClosed,
    ExceedsSingleOrderLimit,
    BelowMinOrderAmount,
    ExceedsPositionLimit,
    ExceedsDailyOrderCount,
    ExceedsDailyTurnover,
    DrawdownHalted,
    InsufficientCash,
    LotSizeViolation,
}

impl RejectCode {
    /// 稳定的字符串标识，前端据此映射文案。
    pub fn as_str(&self) -> &'static str {
        match self {
            RejectCode::InvalidOrder => "invalid_order",
            RejectCode::Blacklisted => "blacklisted",
            RejectCode::NotTradingDay => "not_trading_day",
            RejectCode::SessionClosed => "session_closed",
            RejectCode::ExceedsSingleOrderLimit => "exceeds_single_order_limit",
            RejectCode::BelowMinOrderAmount => "below_min_order_amount",
            RejectCode::ExceedsPositionLimit => "exceeds_position_limit",
            RejectCode::ExceedsDailyOrderCount => "exceeds_daily_order_count",
            RejectCode::ExceedsDailyTurnover => "exceeds_daily_turnover",
            RejectCode::DrawdownHalted => "drawdown_halted",
            RejectCode::InsufficientCash => "insufficient_cash",
            RejectCode::LotSizeViolation => "lot_size_violation",
        }
    }
}

/// 风控决策。
#[derive(Debug, Clone, PartialEq)]
pub enum RiskDecision {
    /// 通过；`warnings` 是不阻断但应提示用户的情况（如接近仓位上限）
    Approved {
        warnings: Vec<String>,
    },
    Rejected {
        code: RejectCode,
        reason: String,
    },
}

impl RiskDecision {
    pub fn is_approved(&self) -> bool {
        matches!(self, RiskDecision::Approved { .. })
    }

    pub fn reject_code(&self) -> Option<RejectCode> {
        match self {
            RiskDecision::Rejected { code, .. } => Some(*code),
            _ => None,
        }
    }

    pub fn warnings(&self) -> &[String] {
        match self {
            RiskDecision::Approved { warnings } => warnings,
            _ => &[],
        }
    }
}

fn reject(code: RejectCode, reason: impl Into<String>) -> RiskDecision {
    RiskDecision::Rejected {
        code,
        reason: reason.into(),
    }
}

/// 当前净值相对峰值的回撤（正数，0.15 = 回撤 15%）。
pub fn current_drawdown(total_equity: f64, peak_equity: f64) -> f64 {
    if peak_equity <= f64::EPSILON || !peak_equity.is_finite() {
        return 0.0;
    }
    ((peak_equity - total_equity) / peak_equity).max(0.0)
}

/// 风控主校验。返回 `Approved` 才允许下单。
///
/// 检查顺序刻意从「最便宜、最不可能误判」的规则开始：
/// 参数合法性 → 黑名单 → 交易时段 → 笔数/金额上限 → 仓位与现金 → 整手。
pub fn check_order(limits: &RiskLimits, ctx: &RiskContext, order: &OrderRequest) -> RiskDecision {
    let amount = order.amount();

    // 1) 参数合法性
    if amount <= 0.0 {
        return reject(RejectCode::InvalidOrder, "委托价格或数量无效");
    }
    if !order.price.is_finite() || !order.volume.is_finite() {
        return reject(RejectCode::InvalidOrder, "委托价格或数量不是有效数字");
    }

    // 2) 黑名单（大小写与前后空格不敏感）
    let symbol = order.symbol.trim().to_uppercase();
    if limits
        .blacklist
        .iter()
        .any(|b| b.trim().to_uppercase() == symbol)
    {
        return reject(RejectCode::Blacklisted, format!("{symbol} 在风控黑名单中"));
    }

    // 3) 交易时段（卖出在熔断时可选放行，但时段限制对买卖都生效）
    if limits.enforce_session {
        if !ctx.is_trading_day {
            return reject(RejectCode::NotTradingDay, "今天不是交易日");
        }
        if !limits
            .sessions
            .iter()
            .any(|s| s.contains(ctx.current_minute))
        {
            return reject(
                RejectCode::SessionClosed,
                "当前不在交易时段（A 股 09:30-11:30 / 13:00-15:00）",
            );
        }
    }

    // 4) 回撤熔断：只拦买入，卖出/止损放行
    let drawdown = current_drawdown(ctx.total_equity, ctx.peak_equity);
    if drawdown >= limits.max_drawdown_pct && limits.max_drawdown_pct > 0.0 {
        let is_buy = order.side == Side::Buy;
        if is_buy || !limits.allow_sell_when_halted {
            return reject(
                RejectCode::DrawdownHalted,
                format!(
                    "净值回撤 {:.1}% 已触发熔断（阈值 {:.1}%），禁止开新仓",
                    drawdown * 100.0,
                    limits.max_drawdown_pct * 100.0
                ),
            );
        }
    }

    // 5) 单笔金额上下限
    if limits.max_single_order_amount > 0.0 && amount > limits.max_single_order_amount {
        return reject(
            RejectCode::ExceedsSingleOrderLimit,
            format!(
                "单笔委托 {:.0} 元超过上限 {:.0} 元",
                amount, limits.max_single_order_amount
            ),
        );
    }
    if limits.min_single_order_amount > 0.0 && amount < limits.min_single_order_amount {
        return reject(
            RejectCode::BelowMinOrderAmount,
            format!(
                "单笔委托 {:.0} 元低于下限 {:.0} 元",
                amount, limits.min_single_order_amount
            ),
        );
    }

    // 6) 当日笔数与成交额
    if limits.max_daily_orders > 0 && ctx.today_order_count >= limits.max_daily_orders {
        return reject(
            RejectCode::ExceedsDailyOrderCount,
            format!("今日下单已达上限 {} 笔", limits.max_daily_orders),
        );
    }
    if limits.max_daily_turnover > 0.0 && ctx.today_turnover + amount > limits.max_daily_turnover {
        return reject(
            RejectCode::ExceedsDailyTurnover,
            format!(
                "今日成交额 {:.0} 元加上本单将超过上限 {:.0} 元",
                ctx.today_turnover, limits.max_daily_turnover
            ),
        );
    }

    // 7) 整手校验（仅买入；卖出允许零股，A 股规则如此）
    if order.side == Side::Buy && limits.lot_size >= 1.0 {
        let remainder = order.volume % limits.lot_size;
        if remainder.abs() > 1e-9 {
            return reject(
                RejectCode::LotSizeViolation,
                format!("买入数量必须是 {:.0} 股的整数倍", limits.lot_size),
            );
        }
    }

    let mut warnings = Vec::new();

    if order.side == Side::Buy {
        // 8) 单标的仓位上限：新手仓 + 本单市值 不得超过 净值 × 上限
        if limits.max_position_pct > 0.0 && ctx.total_equity > 0.0 {
            let cap = ctx.total_equity * limits.max_position_pct;
            let after = ctx.position_value + amount;
            if after > cap + 1e-9 {
                return reject(
                    RejectCode::ExceedsPositionLimit,
                    format!(
                        "买入后该标的市值 {:.0} 元将超过单标的上限 {:.0} 元（净值 {:.0} 元的 {:.0}%）",
                        after,
                        cap,
                        ctx.total_equity,
                        limits.max_position_pct * 100.0
                    ),
                );
            }
            // 用了 80% 以上额度时提醒
            if cap > 0.0 && after >= cap * 0.8 {
                warnings.push(format!(
                    "买入后该标的仓位将达净值 {:.0}%，接近 {:.0}% 上限",
                    after / ctx.total_equity * 100.0,
                    limits.max_position_pct * 100.0
                ));
            }
        }

        // 9) 现金充足性（含 1 分钱容差）
        if amount > ctx.available_cash + 0.01 {
            return reject(
                RejectCode::InsufficientCash,
                format!(
                    "可用资金 {:.2} 元不足以支付 {:.2} 元",
                    ctx.available_cash, amount
                ),
            );
        }
        if ctx.available_cash > 0.0 && amount >= ctx.available_cash * 0.95 {
            warnings.push("本单将用掉 95% 以上可用资金".to_string());
        }
    } else {
        // 卖出必须有足够持仓
        if order.volume > ctx.position_volume + 1e-9 {
            return reject(
                RejectCode::InvalidOrder,
                format!(
                    "卖出数量 {:.0} 股超过持仓 {:.0} 股",
                    order.volume, ctx.position_volume
                ),
            );
        }
    }

    RiskDecision::Approved { warnings }
}

/// 持仓止损/止盈触发检查。
///
/// 返回触发说明与建议动作：`Some((Side::Sell, reason))` 表示应立即市价卖出清仓。
/// 这里只做判断，真正的下单仍要走 [`check_order`]。
pub fn check_exit_trigger(
    entry_price: f64,
    last_price: f64,
    stop_loss: Option<f64>,
    take_profit: Option<f64>,
) -> Option<String> {
    if entry_price <= 0.0 || !last_price.is_finite() {
        return None;
    }
    let change = last_price / entry_price - 1.0;
    if let Some(sl) = stop_loss {
        if sl > 0.0 && change <= -sl {
            return Some(format!(
                "触发止损：浮亏 {:.2}%（阈值 -{:.2}%）",
                change * 100.0,
                sl * 100.0
            ));
        }
    }
    if let Some(tp) = take_profit {
        if tp > 0.0 && change >= tp {
            return Some(format!(
                "触发止盈：浮盈 {:.2}%（阈值 +{:.2}%）",
                change * 100.0,
                tp * 100.0
            ));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> RiskContext {
        RiskContext {
            total_equity: 100_000.0,
            available_cash: 100_000.0,
            position_value: 0.0,
            position_volume: 0.0,
            today_order_count: 0,
            today_turnover: 0.0,
            peak_equity: 100_000.0,
            current_minute: 10 * 60, // 10:00 交易时段内
            is_trading_day: true,
        }
    }

    fn buy(symbol: &str, price: f64, volume: f64) -> OrderRequest {
        OrderRequest {
            symbol: symbol.into(),
            side: Side::Buy,
            price,
            volume,
        }
    }

    fn sell(symbol: &str, price: f64, volume: f64) -> OrderRequest {
        OrderRequest {
            symbol: symbol.into(),
            side: Side::Sell,
            price,
            volume,
        }
    }

    #[test]
    fn default_limits_are_valid() {
        assert!(RiskLimits::default().validate().is_ok());
    }

    #[test]
    fn validate_rejects_bad_config() {
        let mut l = RiskLimits::default();
        l.max_position_pct = 1.5;
        assert!(l.validate().is_err());

        let mut l = RiskLimits::default();
        l.min_single_order_amount = 1000.0;
        l.max_single_order_amount = 100.0;
        assert!(l.validate().is_err());

        let mut l = RiskLimits::default();
        l.sessions = vec![];
        assert!(l.validate().is_err());

        let mut l = RiskLimits::default();
        l.sessions = vec![Session {
            start_minute: 900,
            end_minute: 600,
        }];
        assert!(l.validate().is_err());
    }

    #[test]
    fn normal_order_approved() {
        // 100 元 × 300 股 = 30000 元，未触及 5 万单笔上限、未触及 3 万仓位上限
        let d = check_order(&RiskLimits::default(), &ctx(), &buy("600519", 100.0, 300.0));
        assert!(d.is_approved(), "{d:?}");
    }

    #[test]
    fn invalid_order_rejected() {
        let d = check_order(&RiskLimits::default(), &ctx(), &buy("600519", 0.0, 100.0));
        assert_eq!(d.reject_code(), Some(RejectCode::InvalidOrder));

        let d = check_order(&RiskLimits::default(), &ctx(), &buy("600519", 10.0, 0.0));
        assert_eq!(d.reject_code(), Some(RejectCode::InvalidOrder));
    }

    #[test]
    fn blacklist_blocks_case_insensitive() {
        let mut limits = RiskLimits::default();
        limits.blacklist = vec![" 600519 ".into()];
        let d = check_order(&limits, &ctx(), &buy("600519", 10.0, 100.0));
        assert_eq!(d.reject_code(), Some(RejectCode::Blacklisted));
    }

    #[test]
    fn session_boundaries() {
        let limits = RiskLimits::default();

        // 09:29 未开盘
        let mut c = ctx();
        c.current_minute = 9 * 60 + 29;
        assert_eq!(
            check_order(&limits, &c, &buy("600519", 10.0, 100.0)).reject_code(),
            Some(RejectCode::SessionClosed)
        );

        // 09:30 开盘瞬间应放行
        c.current_minute = 9 * 60 + 30;
        assert!(check_order(&limits, &c, &buy("600519", 10.0, 100.0)).is_approved());

        // 11:30 收盘瞬间应放行
        c.current_minute = 11 * 60 + 30;
        assert!(check_order(&limits, &c, &buy("600519", 10.0, 100.0)).is_approved());

        // 11:31 午休
        c.current_minute = 11 * 60 + 31;
        assert_eq!(
            check_order(&limits, &c, &buy("600519", 10.0, 100.0)).reject_code(),
            Some(RejectCode::SessionClosed)
        );

        // 13:00 下午开盘
        c.current_minute = 13 * 60;
        assert!(check_order(&limits, &c, &buy("600519", 10.0, 100.0)).is_approved());

        // 15:00 收盘瞬间放行
        c.current_minute = 15 * 60;
        assert!(check_order(&limits, &c, &buy("600519", 10.0, 100.0)).is_approved());

        // 15:01 已收盘
        c.current_minute = 15 * 60 + 1;
        assert_eq!(
            check_order(&limits, &c, &buy("600519", 10.0, 100.0)).reject_code(),
            Some(RejectCode::SessionClosed)
        );
    }

    #[test]
    fn non_trading_day_blocked() {
        let mut c = ctx();
        c.is_trading_day = false;
        let d = check_order(&RiskLimits::default(), &c, &buy("600519", 10.0, 100.0));
        assert_eq!(d.reject_code(), Some(RejectCode::NotTradingDay));
    }

    #[test]
    fn session_check_can_be_disabled() {
        let mut limits = RiskLimits::default();
        limits.enforce_session = false;
        let mut c = ctx();
        c.current_minute = 3 * 60;
        c.is_trading_day = false;
        assert!(check_order(&limits, &c, &buy("600519", 10.0, 100.0)).is_approved());
    }

    #[test]
    fn single_order_limit() {
        let mut limits = RiskLimits::default();
        limits.max_single_order_amount = 10_000.0;
        // 100 元 × 200 股 = 20000 > 10000
        let d = check_order(&limits, &ctx(), &buy("600519", 100.0, 200.0));
        assert_eq!(d.reject_code(), Some(RejectCode::ExceedsSingleOrderLimit));
    }

    #[test]
    fn min_order_amount() {
        let mut limits = RiskLimits::default();
        limits.min_single_order_amount = 5_000.0;
        let d = check_order(&limits, &ctx(), &buy("600519", 10.0, 100.0)); // 1000 元
        assert_eq!(d.reject_code(), Some(RejectCode::BelowMinOrderAmount));
    }

    #[test]
    fn daily_order_count_limit() {
        let mut limits = RiskLimits::default();
        limits.max_daily_orders = 3;
        let mut c = ctx();
        c.today_order_count = 3;
        let d = check_order(&limits, &c, &buy("600519", 10.0, 100.0));
        assert_eq!(d.reject_code(), Some(RejectCode::ExceedsDailyOrderCount));
    }

    #[test]
    fn daily_turnover_limit() {
        let mut limits = RiskLimits::default();
        limits.max_daily_turnover = 10_000.0;
        let mut c = ctx();
        c.today_turnover = 9_500.0;
        // 10 × 100 = 1000，9500 + 1000 = 10500 > 10000
        let d = check_order(&limits, &c, &buy("600519", 10.0, 100.0));
        assert_eq!(d.reject_code(), Some(RejectCode::ExceedsDailyTurnover));
    }

    #[test]
    fn position_limit_applies_on_accumulation() {
        let mut limits = RiskLimits::default();
        limits.max_position_pct = 0.1; // 上限 10000 元
        let mut c = ctx();
        c.position_value = 8_000.0;
        c.position_volume = 800.0;
        // 再加 3000 元 → 11000 > 10000
        let d = check_order(&limits, &c, &buy("600519", 10.0, 300.0));
        assert_eq!(d.reject_code(), Some(RejectCode::ExceedsPositionLimit));
    }

    #[test]
    fn position_warning_near_limit() {
        let mut limits = RiskLimits::default();
        limits.max_position_pct = 0.1; // 上限 10000
        let mut c = ctx();
        c.position_value = 7_000.0;
        // 加 1000 → 8000，正好达到 80%，应触发提示但通过
        let d = check_order(&limits, &c, &buy("600519", 10.0, 100.0));
        assert!(d.is_approved(), "{d:?}");
        assert!(!d.warnings().is_empty());
    }

    #[test]
    fn insufficient_cash() {
        let mut c = ctx();
        c.available_cash = 500.0;
        let d = check_order(&RiskLimits::default(), &c, &buy("600519", 10.0, 100.0));
        assert_eq!(d.reject_code(), Some(RejectCode::InsufficientCash));
    }

    #[test]
    fn sell_requires_enough_position() {
        let mut c = ctx();
        c.position_volume = 500.0;
        let d = check_order(&RiskLimits::default(), &c, &sell("600519", 10.0, 800.0));
        assert_eq!(d.reject_code(), Some(RejectCode::InvalidOrder));

        let d = check_order(&RiskLimits::default(), &c, &sell("600519", 10.0, 500.0));
        assert!(d.is_approved(), "{d:?}");
    }

    #[test]
    fn lot_size_enforced_on_buy_only() {
        let limits = RiskLimits::default();
        let d = check_order(&limits, &ctx(), &buy("600519", 10.0, 150.0));
        assert_eq!(d.reject_code(), Some(RejectCode::LotSizeViolation));

        // 卖出零股允许
        let mut c = ctx();
        c.position_volume = 150.0;
        let d = check_order(&limits, &c, &sell("600519", 10.0, 150.0));
        assert!(d.is_approved(), "{d:?}");
    }

    #[test]
    fn drawdown_halt_blocks_buy_but_allows_sell() {
        let mut limits = RiskLimits::default();
        limits.max_drawdown_pct = 0.10;
        let mut c = ctx();
        c.total_equity = 85_000.0; // 回撤 15%
        c.peak_equity = 100_000.0;
        c.available_cash = 85_000.0;
        c.position_volume = 1_000.0;
        c.position_value = 0.0;

        let d = check_order(&limits, &c, &buy("600519", 10.0, 100.0));
        assert_eq!(d.reject_code(), Some(RejectCode::DrawdownHalted));

        let d = check_order(&limits, &c, &sell("600519", 10.0, 1_000.0));
        assert!(d.is_approved(), "熔断时应允许卖出: {d:?}");
    }

    #[test]
    fn drawdown_halt_can_block_sell_too() {
        let mut limits = RiskLimits::default();
        limits.max_drawdown_pct = 0.10;
        limits.allow_sell_when_halted = false;
        let mut c = ctx();
        c.total_equity = 80_000.0;
        c.peak_equity = 100_000.0;
        c.position_volume = 100.0;
        let d = check_order(&limits, &c, &sell("600519", 10.0, 100.0));
        assert_eq!(d.reject_code(), Some(RejectCode::DrawdownHalted));
    }

    #[test]
    fn drawdown_computation() {
        assert!((current_drawdown(80_000.0, 100_000.0) - 0.2).abs() < 1e-12);
        // 净值高于峰值时不产生负回撤
        assert_eq!(current_drawdown(120_000.0, 100_000.0), 0.0);
        // 峰值缺失时安全返回 0
        assert_eq!(current_drawdown(100_000.0, 0.0), 0.0);
    }

    #[test]
    fn exit_trigger_stop_loss_and_take_profit() {
        // 成本 10 元，现价 9 元 → -10%
        assert!(check_exit_trigger(10.0, 9.0, Some(0.08), None).is_some());
        // 未触发
        assert!(check_exit_trigger(10.0, 9.5, Some(0.08), None).is_none());
        // 止盈
        let msg = check_exit_trigger(10.0, 12.0, None, Some(0.15)).unwrap();
        assert!(msg.contains("止盈"));
        // 关闭时永不出场
        assert!(check_exit_trigger(10.0, 1.0, None, None).is_none());
        // 非法输入不 panic
        assert!(check_exit_trigger(0.0, 10.0, Some(0.1), None).is_none());
    }

    #[test]
    fn parse_hm_basics() {
        assert_eq!(parse_hm("09:30"), Some(570));
        assert_eq!(parse_hm("15:00"), Some(900));
        assert_eq!(parse_hm("24:00"), None);
        assert_eq!(parse_hm("10:75"), None);
        assert_eq!(parse_hm("abc"), None);
    }

    #[test]
    fn session_from_hm() {
        let s = Session::from_hm("09:30", "11:30").unwrap();
        assert!(s.contains(600));
        assert!(!s.contains(800));
    }

    #[test]
    fn reject_codes_are_stable_strings() {
        assert_eq!(RejectCode::Blacklisted.as_str(), "blacklisted");
        assert_eq!(RejectCode::DrawdownHalted.as_str(), "drawdown_halted");
    }
}
