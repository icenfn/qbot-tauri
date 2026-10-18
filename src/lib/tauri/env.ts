/**
 * 运行环境探测。
 * 不使用 @tauri-apps/api 的探测方法，避免在纯浏览器调试时引入额外失败点。
 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export function isAndroidWebView(): boolean {
  if (typeof navigator === 'undefined') return false
  return /android/i.test(navigator.userAgent)
}

export function isWindows(): boolean {
  if (typeof navigator === 'undefined') return false
  return /windows/i.test(navigator.userAgent)
}

export function isLinux(): boolean {
  if (typeof navigator === 'undefined') return false
  return /linux/i.test(navigator.userAgent) && !isAndroidWebView()
}

export type RuntimeKind = 'tauri-android' | 'tauri-windows' | 'tauri-linux' | 'tauri-desktop' | 'web'

export function runtimeKind(): RuntimeKind {
  if (!isTauri()) return 'web'
  if (isAndroidWebView()) return 'tauri-android'
  if (isWindows()) return 'tauri-windows'
  if (isLinux()) return 'tauri-linux'
  return 'tauri-desktop'
}

export function runtimeLabel(): string {
  switch (runtimeKind()) {
    case 'tauri-android':
      return 'Tauri · Android'
    case 'tauri-windows':
      return 'Tauri · Windows'
    case 'tauri-linux':
      return 'Tauri · Linux'
    case 'tauri-desktop':
      return 'Tauri · Desktop'
    default:
      return '浏览器预览'
  }
}
