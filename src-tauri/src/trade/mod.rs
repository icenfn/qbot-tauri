//! Tauri 侧的交易适配层。
//!
//! 真正的实现都在 `qbot-gateway` 里（不依赖 Tauri，可独立测试）。
//! 本文件只做两件事：
//! 1. 把「应用数据目录」注入成 [`Store`]，让配置与本地状态落到各端的标准位置；
//! 2. 重导出网关类型，命令层直接 `use crate::trade::...`。

pub mod commands;

pub use qbot_gateway::{
    clock_now, fetch_snapshot, open_orders, place_order, precheck, validate_conditional,
    AccountInfo, ClockInfo, ConditionalCheckResult, ConditionalInput, GatewayError, GatewayConfig,
    LocalState, OpenOrderInfo, PlaceOrderResult, PositionInfo, QuoteInfo, RiskLimitsConfig,
    RiskReport, Snapshot, Store,
};

use tauri::Manager;

/// 构造指向应用数据目录的 [`Store`]。首次调用会创建目录。
pub fn app_store(app: &tauri::AppHandle) -> Result<Store, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{e}"))?;
    Store::new(dir)
}
