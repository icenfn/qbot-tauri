import { useEffect, useState } from 'react'
import { isTauri, runtimeKind, runtimeLabel, type RuntimeKind } from '@/lib/tauri/env'

export interface PlatformInfo {
  /** 视口是否为窄屏（移动端布局） */
  isMobile: boolean
  /** 是否运行在 Tauri 容器内 */
  isTauri: boolean
  /** 具体运行环境 */
  runtime: RuntimeKind
  /** 人类可读的运行环境名称 */
  runtimeText: string
}

function readIsMobile(breakpoint: number): boolean {
  if (typeof window === 'undefined') return false
  return window.innerWidth <= breakpoint
}

/**
 * 响应式平台信息。桌面端使用侧边栏布局，窄屏切换为底部导航。
 */
export function usePlatform(breakpoint = 768): PlatformInfo {
  const [isMobile, setIsMobile] = useState<boolean>(() => readIsMobile(breakpoint))

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint}px)`)
    const handleChange = (event: MediaQueryListEvent) => setIsMobile(event.matches)

    setIsMobile(mql.matches)
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', handleChange)
      return () => mql.removeEventListener('change', handleChange)
    }
    // 兼容旧版 WebKitGTK
    mql.addListener(handleChange)
    return () => mql.removeListener(handleChange)
  }, [breakpoint])

  return {
    isMobile,
    isTauri: isTauri(),
    runtime: runtimeKind(),
    runtimeText: runtimeLabel(),
  }
}
