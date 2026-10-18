// Tauri 2 桌面端入口。
//
// Windows / Linux 均为标准桌面进程；
// Android 端不使用此文件（移动端由 lib.rs 的 #[cfg_attr(mobile, tauri::mobile_entry_point)] 接管）。

// 发布构建时隐藏 Windows 控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    qbot_lib::run()
}
