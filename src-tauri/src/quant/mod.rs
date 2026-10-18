//! 量化命令层：把 `qbot-core` 的纯计算能力暴露给前端。
//!
//! 分层原因：
//! - `qbot-core` 刻意保持「零第三方依赖」，方便在任意平台编译与单元测试；
//!   因此它不引入 `serde`，也不关心 JSON 形态。
//! - 本文件负责**边界转换**：入参从 JSON 反序列化成核心类型，出参再把核心类型映射成
//!   带 `camelCase` 的 DTO。前端因此拿到的是稳定的、与 TS 类型一一对应的结构。
//!
//! 并发说明：回测与参数优化都是纯 CPU 计算，通过 `spawn_blocking` 放到阻塞线程池执行，
//! 避免长时间占用 Tauri 的异步运行时、导致 UI 卡顿（Android 上尤其明显）。

pub mod commands;

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use qbot_core::backtest::{BacktestError, Runner};
use qbot_core::optimizer::{self, Objective, OptimizeError, ParamGrid};
use qbot_core::strategies;
use qbot_core::types::{
    BacktestConfig, Bar, ClosedTrade, EquityPoint, Metrics, ParamKind, Params, Side, Signal,
    StrategyMeta, Trade,
};

// ---------------------------------------------------------------------------
// 入参
// ---------------------------------------------------------------------------

/// 前端传入的 K 线（字段名与前端 `KlineBar` 对齐，采用 camelCase）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BarInput {
    pub date: String,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    #[serde(default)]
    pub volume: f64,
    #[serde(default)]
    pub amount: f64,
}

impl From<BarInput> for Bar {
    fn from(b: BarInput) -> Self {
        Bar {
            date: b.date,
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            volume: b.volume,
            amount: b.amount,
        }
    }
}

/// 回测配置入参，全部字段可选，缺省用 A 股默认值。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigInput {
    pub initial_cash: Option<f64>,
    pub commission_rate: Option<f64>,
    pub min_commission: Option<f64>,
    pub stamp_duty_rate: Option<f64>,
    pub transfer_fee_rate: Option<f64>,
    pub slippage_rate: Option<f64>,
    pub lot_size: Option<f64>,
    pub stop_loss: Option<f64>,
    pub take_profit: Option<f64>,
    pub allow_t0: Option<bool>,
    pub max_position_pct: Option<f64>,
}

impl ConfigInput {
    fn merge(&self, base: BacktestConfig) -> BacktestConfig {
        let mut cfg = base;
        if let Some(v) = self.initial_cash {
            cfg.initial_cash = v;
        }
        if let Some(v) = self.commission_rate {
            cfg.commission_rate = v;
        }
        if let Some(v) = self.min_commission {
            cfg.min_commission = v;
        }
        if let Some(v) = self.stamp_duty_rate {
            cfg.stamp_duty_rate = v;
        }
        if let Some(v) = self.transfer_fee_rate {
            cfg.transfer_fee_rate = v;
        }
        if let Some(v) = self.slippage_rate {
            cfg.slippage_rate = v;
        }
        if let Some(v) = self.lot_size {
            cfg.lot_size = v;
        }
        if let Some(v) = self.stop_loss {
            cfg.stop_loss = if v > 0.0 { Some(v) } else { None };
        }
        if let Some(v) = self.take_profit {
            cfg.take_profit = if v > 0.0 { Some(v) } else { None };
        }
        if let Some(v) = self.allow_t0 {
            cfg.allow_t0 = v;
        }
        if let Some(v) = self.max_position_pct {
            cfg.max_position_pct = v;
        }
        cfg
    }
}

/// 一次参数网格（优化用）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridInput {
    pub key: String,
    pub values: Vec<f64>,
}

// ---------------------------------------------------------------------------
// 出参 DTO
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamSpecDto {
    pub key: String,
    pub label: String,
    /// "int" | "float"
    pub kind: String,
    pub default_value: f64,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub step: Option<f64>,
    pub hint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategyMetaDto {
    pub id: String,
    pub name: String,
    pub description: String,
    pub params: Vec<ParamSpecDto>,
}

pub(crate) fn kind_str(kind: ParamKind) -> String {
    match kind {
        ParamKind::Int => "int".into(),
        ParamKind::Float => "float".into(),
    }
}

pub(crate) fn meta_to_dto(m: StrategyMeta) -> StrategyMetaDto {
    StrategyMetaDto {
        id: m.id,
        name: m.name,
        description: m.description,
        params: m
            .params
            .into_iter()
            .map(|p| ParamSpecDto {
                key: p.key,
                label: p.label,
                kind: kind_str(p.kind),
                default_value: p.default_value,
                min: p.min,
                max: p.max,
                step: p.step,
                hint: p.hint,
            })
            .collect(),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeDto {
    pub date: String,
    pub side: String,
    pub price: f64,
    pub shares: f64,
    pub amount: f64,
    pub fee: f64,
    pub realized_pnl: Option<f64>,
    pub reason: String,
    pub position_after: f64,
}

pub(crate) fn trade_to_dto(t: Trade) -> TradeDto {
    TradeDto {
        date: t.date,
        side: t.side.as_str().to_string(),
        price: t.price,
        shares: t.shares,
        amount: t.amount,
        fee: t.fee,
        realized_pnl: t.realized_pnl,
        reason: t.reason,
        position_after: t.position_after,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedTradeDto {
    pub entry_date: String,
    pub exit_date: String,
    pub entry_price: f64,
    pub exit_price: f64,
    pub shares: f64,
    pub pnl: f64,
    pub return_pct: f64,
    pub holding_days: i64,
}

pub(crate) fn closed_to_dto(t: ClosedTrade) -> ClosedTradeDto {
    ClosedTradeDto {
        entry_date: t.entry_date,
        exit_date: t.exit_date,
        entry_price: t.entry_price,
        exit_price: t.exit_price,
        shares: t.shares,
        pnl: t.pnl,
        return_pct: t.return_pct,
        holding_days: t.holding_days,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EquityPointDto {
    pub date: String,
    pub equity: f64,
    pub cash: f64,
    pub position_value: f64,
    pub close: f64,
    pub drawdown: f64,
}

pub(crate) fn point_to_dto(p: EquityPoint) -> EquityPointDto {
    EquityPointDto {
        date: p.date,
        equity: p.equity,
        cash: p.cash,
        position_value: p.position_value,
        close: p.close,
        drawdown: p.drawdown,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsDto {
    pub total_return: f64,
    pub annual_return: f64,
    pub annual_volatility: f64,
    pub max_drawdown: f64,
    pub max_drawdown_start: Option<String>,
    pub max_drawdown_end: Option<String>,
    pub sharpe: f64,
    pub sortino: f64,
    pub calmar: f64,
    pub win_rate: f64,
    /// 盈亏比为无穷大时序列化为 `null`（JSON 不支持 Infinity）
    pub profit_factor: Option<f64>,
    pub trade_count: usize,
    pub avg_holding_days: f64,
    pub total_fees: f64,
    pub benchmark_return: f64,
    pub excess_return: f64,
}

pub(crate) fn metrics_to_dto(m: Metrics) -> MetricsDto {
    MetricsDto {
        total_return: m.total_return,
        annual_return: m.annual_return,
        annual_volatility: m.annual_volatility,
        max_drawdown: m.max_drawdown,
        max_drawdown_start: m.max_drawdown_start,
        max_drawdown_end: m.max_drawdown_end,
        sharpe: m.sharpe,
        sortino: m.sortino,
        calmar: m.calmar,
        win_rate: m.win_rate,
        profit_factor: if m.profit_factor.is_finite() {
            Some(m.profit_factor)
        } else {
            None
        },
        trade_count: m.trade_count,
        avg_holding_days: m.avg_holding_days,
        total_fees: m.total_fees,
        benchmark_return: m.benchmark_return,
        excess_return: m.excess_return,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BacktestResultDto {
    pub symbol: String,
    pub strategy_id: String,
    pub strategy_name: String,
    pub start_date: String,
    pub end_date: String,
    pub bars: usize,
    pub initial_cash: f64,
    pub final_equity: f64,
    pub trades: Vec<TradeDto>,
    pub closed_trades: Vec<ClosedTradeDto>,
    pub equityCurve: Vec<EquityPointDto>,
    pub metrics: MetricsDto,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateDto {
    pub params: BTreeMap<String, f64>,
    pub score: f64,
    pub total_return: f64,
    pub max_drawdown: f64,
    pub sharpe: f64,
    pub trade_count: usize,
    pub win_rate: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizeReportDto {
    pub strategy_id: String,
    pub objective: String,
    pub evaluated: usize,
    pub candidates: Vec<CandidateDto>,
    pub boundary_warnings: Vec<String>,
}
