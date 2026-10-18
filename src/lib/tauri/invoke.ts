/**
 * 统一的 Rust 命令调用入口。
 * 在浏览器预览环境下给出明确错误，而不是抛出难懂的 "undefined is not a function"。
 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { isTauri } from '@/lib/tauri/env'

export class TauriUnavailableError extends Error {
  constructor(command: string) {
    super(`命令 "${command}" 需要 Tauri 运行时，当前为浏览器预览环境`)
    this.name = 'TauriUnavailableError'
  }
}

export async function invokeCommand<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!isTauri()) {
    throw new TauriUnavailableError(command)
  }
  return tauriInvoke<T>(command, args)
}

/** Rust 侧 `system_info` 命令返回结构 */
export interface SystemInfo {
  appName: string
  version: string
  tauriVersion: string
  platform: string
  arch: string
  family: string
  isMobile: boolean
  debugBuild: boolean
  dataDir: string | null
}

export function fetchSystemInfo(): Promise<SystemInfo> {
  return invokeCommand<SystemInfo>('system_info')
}
