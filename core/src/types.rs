//! 核心数据类型：Bar、交易、持仓、信号、配置。
//!
//! 这些结构同时是 Tauri 命令的入参/返回值，因此字段命名采用 `snake_case`，
//! 序列化后与前端 TypeScript 类型一一对应（不用 camelCase 转换，避免歧义）。

use std::collections::BTreeMap;

/// 一根 K 线（日线 / 周线 / 月线）。
#[derive(Debug, Clone, PartialEq)]
pub struct Bar {
    /// 交易日，格式 `YYYY-MM-DD`
    pub date: String,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
    pub amount: f64,
}

/// 交易方向。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Buy,
    Sell,
}

impl Side {
    pub fn as_str(&self) -> &'static str {
        match self {
            Side::Buy => "buy",
            Side::Sell => "sell",
        }
    }
}

/// 一条成交记录。
#[derive(Debug, Clone, PartialEq)]
pub struct Trade {
    /// 交易日
    pub date: String,
    pub side: Side,
    pub price: f64,
    pub shares: f64,
    /// 成交金额（不含费用）
    pub amount: f64,
    /// 佣金 + 印花税 + 过户费 + 滑点损失（滑点已摊入 price，此项只含显性费用）
    pub fee: f64,
    /// 该笔卖出实现的盈亏（买入为 None）
    pub realized_pnl: Option<f64>,
    /// 触发原因，便于在报告里解释「为什么交易」
    pub reason: String,
    /// 平仓后持仓成本（用于展示）
    pub position_after: f64,
}

/// 已平仓的一笔完整交易（一次买入 + 对应卖出），用于统计胜率与盈亏比。
#[derive(Debug, Clone, PartialEq)]
pub struct ClosedTrade {
    pub entry_date: String,
    pub exit_date: String,
    pub entry_price: f64,
    pub exit_price: f64,
    pub shares: f64,
    /// 扣费后的净盈亏
    pub pnl: f64,
    /// 净盈亏率（相对买入成本）
    pub return_pct: f64,
    /// 持仓天数（自然日）
    pub holding_days: i64,
}

/// 策略在某一根 Bar 上给出的意图。
#[derive(Debug, Clone, PartialEq)]
pub enum Signal {
    /// 空仓观望
    Hold,
    /// 目标仓位比例（0.0~1.0），引擎据此换算股数
    TargetPosition(f64),
    /// 强制清仓
    Exit,
}

/// 回测配置。
#[derive(Debug, Clone, PartialEq)]
pub struct BacktestConfig {
    /// 初始资金（元）
    pub initial_cash: f64,
    /// 佣金率（双边），A 股常见万三，且通常有 5 元最低
    pub commission_rate: f64,
    /// 单笔最低佣金（元）
    pub min_commission: f64,
    /// 印花税（仅卖出），2023-08-28 起为 0.05%
    pub stamp_duty_rate: f64,
    /// 过户费（双边，沪深均按成交金额收取），当前 0.001%
    pub transfer_fee_rate: f64,
    /// 滑点（按成交价百分比，买入上浮、卖出下调）
    pub slippage_rate: f64,
    /// 最小交易单位（A 股 100 股 / 手）
    pub lot_size: f64,
    /// 止损（相对成本价的回撤比例，如 0.08 表示 -8%）
    pub stop_loss: Option<f64>,
    /// 止盈（如 0.20 表示 +20%）
    pub take_profit: Option<f64>,
    /// 是否允许 T+0（A 股为 false：当日买入不可当日卖出）
    pub allow_t0: bool,
    /// 单笔最大仓位比例，避免一把梭
    pub max_position_pct: f64,
}

impl Default for BacktestConfig {
    fn default() -> Self {
        Self {
            initial_cash: 100_000.0,
            commission_rate: 0.0003,
            min_commission: 5.0,
            stamp_duty_rate: 0.0005,
            transfer_fee_rate: 0.00001,
            slippage_rate: 0.0005,
            lot_size: 100.0,
            stop_loss: None,
            take_profit: None,
            allow_t0: false,
            max_position_pct: 1.0,
        }
    }
}

impl BacktestConfig {
    /// 校验配置是否合理。返回 `Err(说明)` 便于前端直接提示。
    pub fn validate(&self) -> Result<(), String> {
        if !(self.initial_cash > 0.0) || !self.initial_cash.is_finite() {
            return Err("初始资金必须为正数".into());
        }
        if self.commission_rate < 0.0 || self.commission_rate >= 0.05 {
            return Err("佣金率应在 [0, 0.05) 之间".into());
        }
        if self.stamp_duty_rate < 0.0 || self.stamp_duty_rate >= 0.05 {
            return Err("印花税率应在 [0, 0.05) 之间".into());
        }
        if self.transfer_fee_rate < 0.0 || self.transfer_fee_rate >= 0.01 {
            return Err("过户费率应在 [0, 0.01) 之间".into());
        }
        if self.slippage_rate < 0.0 || self.slippage_rate >= 0.1 {
            return Err("滑点应在 [0, 0.1) 之间".into());
        }
        if self.lot_size < 1.0 {
            return Err("最小交易单位至少为 1".into());
        }
        if !(0.0..=1.0).contains(&self.max_position_pct) || self.max_position_pct <= 0.0 {
            return Err("最大仓位比例应在 (0, 1] 之间".into());
        }
        for (name, value) in [("止损", self.stop_loss), ("止盈", self.take_profit)] {
            if let Some(v) = value {
                if !(v > 0.0 && v < 1.0) {
                    return Err(format!("{name}比例应在 (0, 1) 之间"));
                }
            }
        }
        Ok(())
    }
}

/// 权益曲线上的一个点。
#[derive(Debug, Clone, PartialEq)]
pub struct EquityPoint {
    pub date: String,
    /// 总资产 = 现金 + 持仓市值
    pub equity: f64,
    pub cash: f64,
    /// 持仓市值
    pub position_value: f64,
    /// 当前收盘价
    pub close: f64,
    /// 回撤（相对历史最高，负值，如 -0.12 表示回撤 12%）
    pub drawdown: f64,
}

/// 回测结果。
#[derive(Debug, Clone, PartialEq)]
pub struct BacktestResult {
    pub symbol: String,
    pub strategy_id: String,
    pub strategy_name: String,
    pub start_date: String,
    pub end_date: String,
    pub bars: usize,
    pub initial_cash: f64,
    pub final_equity: f64,
    pub trades: Vec<Trade>,
    pub closed_trades: Vec<ClosedTrade>,
    pub equity_curve: Vec<EquityPoint>,
    pub metrics: Metrics,
}

/// 绩效指标集合。
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Metrics {
    /// 累计收益率（小数，0.23 表示 23%）
    pub total_return: f64,
    /// 年化收益率
    pub annual_return: f64,
    /// 年化波动率
    pub annual_volatility: f64,
    /// 最大回撤（正数，0.15 表示回撤 15%）
    pub max_drawdown: f64,
    /// 最大回撤区间
    pub max_drawdown_start: Option<String>,
    pub max_drawdown_end: Option<String>,
    /// 夏普比率（无风险利率默认 2%）
    pub sharpe: f64,
    /// 索提诺比率（只用下行波动）
    pub sortino: f64,
    /// 卡玛比率 = 年化收益 / 最大回撤
    pub calmar: f64,
    /// 胜率（已平仓交易中盈利笔数占比）
    pub win_rate: f64,
    /// 盈亏比 = 平均盈利 / 平均亏损
    pub profit_factor: f64,
    /// 交易次数（买入笔数）
    pub trade_count: usize,
    /// 平均持仓天数
    pub avg_holding_days: f64,
    /// 总费用（佣金 + 印花税 + 过户费）
    pub total_fees: f64,
    /// 基准同期收益（买入并持有）
    pub benchmark_return: f64,
    /// 相对基准超额收益
    pub excess_return: f64,
}

/// 策略元信息，前端据此渲染参数表单。
#[derive(Debug, Clone, PartialEq)]
pub struct StrategyMeta {
    pub id: String,
    pub name: String,
    pub description: String,
    pub params: Vec<ParamSpec>,
}

/// 参数规格：用于前端自动生成表单。
#[derive(Debug, Clone, PartialEq)]
pub struct ParamSpec {
    pub key: String,
    pub label: String,
    pub kind: ParamKind,
    pub default_value: f64,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub step: Option<f64>,
    pub hint: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParamKind {
    Int,
    Float,
}

/// 参数表：策略用字符串键取值，便于从 JSON 直接传入。
pub type Params = BTreeMap<String, f64>;

/// 从参数表取整型，带默认值与下限保护。
pub fn param_int(params: &Params, key: &str, default: usize, min: usize) -> usize {
    params
        .get(key)
        .map(|v| {
            if !v.is_finite() {
                default
            } else {
                v.round().max(0.0) as usize
            }
        })
        .map(|v| v.max(min))
        .unwrap_or(default)
}

/// 从参数表取浮点型，带默认值。
pub fn param_float(params: &Params, key: &str, default: f64) -> f64 {
    params
        .get(key)
        .copied()
        .filter(|v| v.is_finite())
        .unwrap_or(default)
}
