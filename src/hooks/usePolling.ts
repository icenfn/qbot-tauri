import { useCallback, useEffect, useRef, useState } from 'react'

export interface PollingState<T> {
  data: T | null
  error: string | null
  /** 首次加载（无任何数据） */
  loading: boolean
  /** 后台刷新中（已有数据） */
  refreshing: boolean
  updatedAt: string | null
  /** 连续失败次数，0 表示正常 */
  failures: number
  /** 距离下次自动刷新的毫秒数，未安排时为 null */
  nextDelayMs: number | null
  refresh: () => void
}

interface Options {
  /** 轮询间隔（毫秒）；<=0 表示不轮询，只执行一次 */
  intervalMs: number
  /** 是否启用。移动端切到后台时建议关闭，节省电量与流量 */
  enabled?: boolean
  /** 依赖变化时重置并立即重新拉取 */
  deps?: unknown[]
  /**
   * 失败退避上限（毫秒）。
   * 默认取 `intervalMs * 8`：连续失败时逐步拉长间隔，避免后端挂掉时
   * 每 10 秒刷一次错误并把日志刷满；恢复成功后立刻回到正常节奏。
   */
  maxIntervalMs?: number
  /**
   * 回到前台时是否立即刷新（默认 true）。
   * 手机切回应用时，上次数据可能已经几分钟前的了，等下一个定时器周期
   * 会让人误以为「价格没变」，所以立即补一次。
   */
  refreshOnVisible?: boolean
}

/**
 * 通用轮询 Hook。
 *
 * 设计要点：
 * - 首次加载显示 loading，后续刷新只标记 refreshing，避免表格闪烁；
 * - 使用 setTimeout 递归而非 setInterval：失败退避需要动态调整下一次间隔，
 *   setInterval 改不了已排队的周期，只能整体重建定时器，容易丢拍；
 * - 使用 ref 保存最新 fetcher，避免因内联函数变化导致定时器反复重建；
 * - 页面不可见时跳过一次刷新（移动端省电），回到前台立即补一次；
 * - 组件卸载或 enabled 关闭时清理定时器，不留悬挂任务。
 */
export function usePolling<T>(fetcher: () => Promise<T>, options: Options): PollingState<T> {
  const { intervalMs, enabled = true, deps = [], maxIntervalMs, refreshOnVisible = true } = options

  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [failures, setFailures] = useState(0)
  const [nextDelayMs, setNextDelayMs] = useState<number | null>(null)

  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  const mountedRef = useRef(true)
  const dataRef = useRef<T | null>(null)
  dataRef.current = data

  // 失败次数用 ref 同步保存，避免定时器读到的永远是首次渲染时的 0
  const failuresRef = useRef(0)

  const tick = useCallback(async (): Promise<boolean> => {
    const hasData = dataRef.current !== null
    if (hasData) setRefreshing(true)
    else setLoading(true)

    try {
      const result = await fetcherRef.current()
      if (!mountedRef.current) return true
      setData(result)
      setError(null)
      setUpdatedAt(new Date().toISOString())
      failuresRef.current = 0
      setFailures(0)
      return true
    } catch (err) {
      if (!mountedRef.current) return false
      setError(err instanceof Error ? err.message : String(err))
      failuresRef.current += 1
      setFailures(failuresRef.current)
      return false
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

  /** 退避计算：失败 n 次后间隔翻倍，封顶 maxIntervalMs */
  const delayFor = useCallback(
    (failCount: number): number => {
      if (intervalMs <= 0) return 0
      if (failCount <= 0) return intervalMs
      const cap = maxIntervalMs ?? intervalMs * 8
      const grown = intervalMs * 2 ** Math.min(failCount, 6)
      return Math.min(grown, Math.max(cap, intervalMs))
    },
    [intervalMs, maxIntervalMs],
  )

  useEffect(() => {
    if (!enabled) {
      setNextDelayMs(null)
      return
    }

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const schedule = (delay: number) => {
      if (cancelled) return
      if (delay <= 0) {
        setNextDelayMs(null)
        return
      }
      setNextDelayMs(delay)
      timer = setTimeout(() => {
        void run()
      }, delay)
    }

    const run = async () => {
      if (cancelled) return
      // 页面不可见时跳过本次刷新，等 visibilitychange 回来再补
      if (typeof document !== 'undefined' && document.hidden) {
        schedule(intervalMs)
        return
      }
      await tick()
      schedule(delayFor(failuresRef.current))
    }

    // 首轮立即执行
    void run()

    const onVisible = () => {
      if (cancelled || !refreshOnVisible) return
      if (typeof document !== 'undefined' && document.hidden) return
      // 回到前台：取消已排队的定时器，立即刷新，避免等待剩余周期
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      void run()
    }

    if (typeof document !== 'undefined' && refreshOnVisible) {
      document.addEventListener('visibilitychange', onVisible)
    }

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      if (typeof document !== 'undefined' && refreshOnVisible) {
        document.removeEventListener('visibilitychange', onVisible)
      }
      setNextDelayMs(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, tick, delayFor, refreshOnVisible, ...deps])

  const refresh = useCallback(() => {
    void tick()
  }, [tick])

  return { data, error, loading, refreshing, updatedAt, failures, nextDelayMs, refresh }
}
