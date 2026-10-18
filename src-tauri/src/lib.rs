//! Qbot Tauri 核心库。
//!
//! 设计要点（三端一致）：
//! - 业务计算（指标、回测、策略、风控）全部用 Rust 实现，三端原生编译，不依赖 Python 运行时；
//! - 数据获取统一经 FastAPI + AkShare，客户端只做 HTTP 调用；
//! - 本地持久化统一使用 SQLite（tauri-plugin-sql，底层 sqlx bundled sqlite）；
//! - 不使用 sidecar，因此 Android 与桌面端能力一致。

mod commands;
mod migrations;
mod quant;

use tauri::Manager;

/// 应用数据目录（三端均存在，只是路径不同）
fn resolve_data_dir(app: &tauri::AppHandle) -> Option<String> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|path| path.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    builder = builder
        // 用系统默认程序打开链接 / 文件
        .plugin(tauri_plugin_opener::init())
        // 本地 SQLite：迁移在此集中管理，前端不再建表
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:qbot.db", migrations::all())
                .build(),
        )
        // 键值配置存储
        .plugin(tauri_plugin_store::Builder::default().build())
        // 文件系统（行情缓存导出 CSV、回测报告导出）
        .plugin(tauri_plugin_fs::init())
        // 文件选择对话框（导入导出）
        .plugin(tauri_plugin_dialog::init())
        // 本地通知（交易信号、止盈止损、日报）
        .plugin(tauri_plugin_notification::init())
        // 由 Rust 发起 HTTP，规避 WebView CORS 与 Android 明文流量限制
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            commands::system_info,
            commands::app_ping,
            commands::open_data_dir,
            // 第三阶段：量化核心（指标 / 策略 / 回测 / 参数优化）
            quant::commands::list_strategies,
            quant::commands::strategy_signals,
            quant::commands::run_backtest,
            quant::commands::optimize_params,
            quant::commands::compute_indicator,
        ]);

    builder
        .setup(|app| {
            if let Some(dir) = resolve_data_dir(app.handle()) {
                // 确保数据目录存在，Android 上首次启动时可能尚未创建
                let _ = std::fs::create_dir_all(&dir);
                log_info(&format!("[qbot] data dir = {dir}"));
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Qbot 启动失败");
}

fn log_info(message: &str) {
    #[cfg(debug_assertions)]
    println!("{message}");
    #[cfg(not(debug_assertions))]
    let _ = message;
}
