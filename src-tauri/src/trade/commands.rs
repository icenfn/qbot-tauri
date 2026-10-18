//! 交易相关 Tauri 命令。
//!
//! 所有命令遵循同一条铁律：**风控前置，且不可跳过**。
//! 前端拿到 `accepted=false` 时不得自行重试下单，只能提示用户改单或改风控配置。
//!
//! 编排实现位于 `qbot-gateway`（不依赖 Tauri）；本文件只负责
//! 「把应用数据目录注入 Store → 调用编排 → 把错误分类成前端可用的 kind」。

use serde::Serialize;

use crate::trade::{app_store, self as gw};

/// 命令层统一错误：`message` 给用户看，`kind` 给前端分支用
/// （network = 网络/网关不可达；rejected = 网关业务拒绝；config = 本地配置问题）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeError {
    pub kind: String,
    pub message: String,
}

impl TradeError {
    pub fn config(message: impl Into<String>) -> Self {
        Self {
            kind: "config".into(),
            message: message.into(),
        }
    }
    pub fn network(message: impl Into<String>) -> Self {
        Self {
            kind: "network".into(),
            message: message.into(),
        }
    }
    pub fn rejected(message: impl Into<String>) -> Self {
        Self {
            kind: "rejected".into(),
            message: message.into(),
        }
    }
}

/// 把底层的纯字符串错误分类。分类只影响提示语，不改变「失败」这一事实。
fn to_error(err: String) -> TradeError {
    let lower = err.to_lowercase();
    let network_hint = [
        "无法访问交易网关",
        "timed out",
        "connection",
        "dns",
        "refused",
    ];
    if network_hint.iter().any(|k| lower.contains(k)) {
        TradeError::network(err)
    } else if err.contains("HTTP ") || err.contains("网关返回") {
        TradeError::rejected(err)
    } else {
        TradeError::config(err)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigView {
    pub config: gw::GatewayConfig,
    pub configured: bool,
    pub clock: gw::ClockInfo,
}

/// 读取网关配置（首次运行返回默认值，`configured=false`）。
#[tauri::command]
pub fn trade_get_config(app: tauri::AppHandle) -> Result<ConfigView, TradeError> {
    let store = app_store(&app).map_err(TradeError::config)?;
    let config = store.load_config().map_err(TradeError::config)?;
    Ok(ConfigView {
        configured: config.is_configured(),
        config,
        clock: gw::clock_now(),
    })
}

/// 保存网关配置；风控规则非法时直接拒绝保存。
#[tauri::command]
pub fn trade_save_config(
    app: tauri::AppHandle,
    config: gw::GatewayConfig,
) -> Result<ConfigView, TradeError> {
    let store = app_store(&app).map_err(TradeError::config)?;
    store.save_config(&config).map_err(TradeError::config)?;
    Ok(ConfigView {
        configured: config.is_configured(),
        config,
        clock: gw::clock_now(),
    })
}

/// 连通性探测：先试 `/api/v1/ping`，未实现时退化为拉账户列表。
#[tauri::command]
pub async fn trade_health(app: tauri::AppHandle) -> Result<serde_json::Value, TradeError> {
    let store = app_store(&app).map_err(TradeError::config)?;
    let cfg = store.load_config().map_err(TradeError::config)?;
    let started = std::time::Instant::now();
    let result = gw::probe(&cfg).await;
    let latency = started.elapsed().as_millis() as u64;
    Ok(match result {
        Ok(detail) => serde_json::json!({
            "ok": true,
            "message": "网关连接正常",
            "latencyMs": latency,
            "detail": detail,
        }),
        Err(e) => serde_json::json!({
            "ok": false,
            "message": e,
            "latencyMs": latency,
            "detail": serde_json::Value::Null,
        }),
    })
}

/// 拉取账户 + 持仓快照，并刷新净值峰值（回撤熔断依赖它）。
#[tauri::command]
pub async fn trade_snapshot(app: tauri::AppHandle) -> Result<gw::Snapshot, TradeError> {
    let store = app_store(&app).map_err(TradeError::config)?;
    let cfg = store.load_config().map_err(TradeError::config)?;
    gw::fetch_snapshot(&store, &cfg).await.map_err(to_error)
}

/// 下单前预检：只做校验，不发委托。
///
/// 用途：用户填单时实时提示「会被拦在哪一条」，避免点了买入才发现超限。
#[tauri::command]
pub async fn trade_precheck(
    app: tauri::AppHandle,
    symbol: String,
    side: String,
    order_type: String,
    price: Option<f64>,
    volume: f64,
    today_order_count: Option<usize>,
    today_turnover: Option<f64>,
) -> Result<gw::RiskReport, TradeError> {
    let store = app_store(&app).map_err(TradeError::config)?;
    let cfg = store.load_config().map_err(TradeError::config)?;
    gw::precheck(
        &store,
        &cfg,
        &symbol,
        &side,
        &order_type,
        price,
        volume,
        today_order_count.unwrap_or(0),
        today_turnover.unwrap_or(0.0),
    )
    .await
    .map_err(to_error)
}

/// 下单。风控通过才会真正发往网关。
///
/// `todayOrderCount` / `todayTurnover` 由前端从本地 `orders` 表统计后传入：
/// 「今日已下单笔数」属于本地账本信息，网关不一定提供。
#[tauri::command]
pub async fn trade_place_order(
    app: tauri::AppHandle,
    symbol: String,
    side: String,
    order_type: String,
    price: Option<f64>,
    volume: f64,
    client_order_id: Option<String>,
    today_order_count: Option<usize>,
    today_turnover: Option<f64>,
) -> Result<gw::PlaceOrderResult, TradeError> {
    let store = app_store(&app).map_err(TradeError::config)?;
    let cfg = store.load_config().map_err(TradeError::config)?;
    gw::place_order(
        &store,
        &cfg,
        &symbol,
        &side,
        &order_type,
        price,
        volume,
        client_order_id,
        today_order_count.unwrap_or(0),
        today_turnover.unwrap_or(0.0),
    )
    .await
    .map_err(to_error)
}

/// 撤单。
#[tauri::command]
pub async fn trade_cancel_order(
    app: tauri::AppHandle,
    order_id: String,
) -> Result<String, TradeError> {
    let store = app_store(&app).map_err(TradeError::config)?;
    let cfg = store.load_config().map_err(TradeError::config)?;
    gw::cancel_order(&cfg, &order_id).await.map_err(to_error)
}

/// 当前未成交委托。
#[tauri::command]
pub async fn trade_open_orders(app: tauri::AppHandle) -> Result<Vec<gw::OpenOrderInfo>, TradeError> {
    let store = app_store(&app).map_err(TradeError::config)?;
    let cfg = store.load_config().map_err(TradeError::config)?;
    if !cfg.is_configured() {
        return Ok(Vec::new());
    }
    gw::open_orders(&cfg).await.map_err(to_error)
}

/// 保存前校验条件单（不落库、不联网）。
#[tauri::command]
pub fn trade_validate_conditional(item: gw::ConditionalInput) -> Result<(), TradeError> {
    gw::validate_conditional(&item).map_err(TradeError::config)
}

/// 评估并执行条件单。前端把 SQLite 里的 `armed` 条件单传进来，
/// 返回每张单的新状态，前端负责回写。
#[tauri::command]
pub async fn trade_check_conditionals(
    app: tauri::AppHandle,
    items: Vec<gw::ConditionalInput>,
    today_order_count: Option<usize>,
    today_turnover: Option<f64>,
) -> Result<Vec<gw::ConditionalCheckResult>, TradeError> {
    if items.is_empty() {
        return Ok(Vec::new());
    }
    let store = app_store(&app).map_err(TradeError::config)?;
    let cfg = store.load_config().map_err(TradeError::config)?;
    gw::check_conditionals(
        &store,
        &cfg,
        items,
        today_order_count.unwrap_or(0),
        today_turnover.unwrap_or(0.0),
    )
    .await
    .map_err(to_error)
}
