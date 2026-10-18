//! 前端可调用的 Rust 命令。
//!
//! 第一阶段只提供环境信息与健康检查；
//! 后续阶段将在此注册指标计算、回测引擎、策略运行、风控校验等命令。

use serde::Serialize;
use tauri::Manager;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub app_name: String,
    pub version: String,
    pub tauri_version: String,
    pub platform: String,
    pub arch: String,
    pub family: String,
    pub is_mobile: bool,
    pub debug_build: bool,
    pub data_dir: Option<String>,
}

fn is_mobile_target() -> bool {
    cfg!(any(target_os = "android", target_os = "ios"))
}

/// 返回运行环境信息，供「设置」页展示，同时验证 Rust <-> 前端 IPC 通路。
#[tauri::command]
pub fn system_info(app: tauri::AppHandle) -> Result<SystemInfo, String> {
    let package = app.package_info();
    let data_dir = app
        .path()
        .app_data_dir()
        .ok()
        .map(|path| path.to_string_lossy().to_string());

    Ok(SystemInfo {
        app_name: package.name.clone(),
        version: package.version.to_string(),
        tauri_version: tauri::VERSION.to_string(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        family: std::env::consts::FAMILY.to_string(),
        is_mobile: is_mobile_target(),
        debug_build: cfg!(debug_assertions),
        data_dir,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PingResult {
    pub ok: bool,
    pub message: String,
    pub timestamp: String,
    pub data_dir: Option<String>,
}

/// 本地核心存活性探测，用于前端诊断 Rust 侧是否正常工作。
#[tauri::command]
pub fn app_ping(app: tauri::AppHandle) -> PingResult {
    let data_dir = app
        .path()
        .app_data_dir()
        .ok()
        .map(|path| path.to_string_lossy().to_string());

    PingResult {
        ok: true,
        message: "Rust 核心运行正常".to_string(),
        timestamp: chrono::Local::now().to_rfc3339(),
        data_dir,
    }
}

/// 打开应用数据目录（桌面端）。Android 上沙盒不支持外部文件管理器直达，返回提示。
#[tauri::command]
pub fn open_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("无法获取数据目录：{err}"))?;

    std::fs::create_dir_all(&dir).map_err(|err| format!("创建数据目录失败：{err}"))?;

    if is_mobile_target() {
        return Ok(dir.to_string_lossy().to_string());
    }

    tauri_plugin_opener::OpenerExt::opener(&app)
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|err| format!("打开目录失败：{err}"))?;

    Ok(dir.to_string_lossy().to_string())
}
