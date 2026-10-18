import { useCallback, useEffect, useRef, useState } from 'react'

export interface PollingState<T> {
  data: T | null
  error: string | null
  /** 首次加载（无任何数据） */
  loading: boolean
  /** 后台刷新中（已有数据） */
  refreshing: boolean
  updatedAt: string | null
  refresh: () => void
}

interface Options {
  /** 轮询间隔（毫秒）；<=0 表示不轮询，只执行一次 */
  intervalMs: number
  /** 是否启用。移动端切到后台时建议关闭，节省电量与流量 */
  enabled?: boolean
  /** 依赖变化时重置并立即重新拉取 */
  deps?: unknown[]
}

/**
 * 通用轮询 Hook。
 *
 * 设计要点：
 * - 首次加载显示 loading，后续刷新只标记 refreshing，避免表格闪烁；
 * - 使用 ref 保存最新 fetcher，避免因内联函数变化导致定时器反复重建；
 * - 组件卸载或 enabled 关闭时清理定时器。
 */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  options: Options,
): PollingState<T> {
  const { intervalMs, enabled = true, deps = [] } = options

  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)

  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  const mountedRef = useRef(true)
  const dataRef = useRef<T | null>(null)
  dataRef.current = data

  const tick = useCallback(async () => {
    const hasData = dataRef.current !== null
    if (hasData) setRefreshing(true)
    else setLoading(true)

    try {
      const result = await fetcherRef.current()
      if (!mountedRef.current) return
      setData(result)
      setError(null)
      setUpdatedAt(new Date().toISOString())
    } catch (err) {
      if (!mountedRef.current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mountedRef.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!enabled) return

    void tick()
    if (intervalMs <= 0) return

    const timer = setInterval(() => {
      // 页面不可见时跳过刷新，避免移动端后台耗电
      if (typeof document !== 'undefined' && document.hidden) return
      void tick()
    }, intervalMs)

    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, tick, ...deps])

  const refresh = useCallback(() => {
    void tick()
  }, [tick])

  return { data, error, loading, refreshing, updatedAt, refresh }
}
