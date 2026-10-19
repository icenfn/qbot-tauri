import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * 后端服务默认地址。
 * - Windows / Linux 桌面：本机 FastAPI
 * - Android 真机：需在设置页改为局域网地址（如 http://192.168.1.10:8000）
 */
export const DEFAULT_BACKEND_URL: string =
  import.meta.env.VITE_DEFAULT_BACKEND_URL ?? 'http://127.0.0.1:8000'

/** 行情自动刷新间隔的可选值（毫秒）。0 表示关闭自动刷新。 */
export const QUOTE_REFRESH_OPTIONS = [
  { value: 0, label: '关闭' },
  { value: 5000, label: '5 秒' },
  { value: 10000, label: '10 秒' },
  { value: 30000, label: '30 秒' },
  { value: 60000, label: '60 秒' },
] as const

/** 条件单轮询间隔的可选值（毫秒）。 */
export const TRADE_POLL_OPTIONS = [
  { value: 0, label: '关闭' },
  { value: 5000, label: '5 秒' },
  { value: 10000, label: '10 秒' },
  { value: 15000, label: '15 秒' },
  { value: 30000, label: '30 秒' },
  { value: 60000, label: '60 秒' },
] as const

/** 交易时段内的默认刷新间隔 */
export const DEFAULT_QUOTE_REFRESH_MS = 10000
/** 条件单默认轮询间隔 */
export const DEFAULT_TRADE_POLL_MS = 15000
/** K 线缓存默认保留天数 */
export const DEFAULT_CACHE_KEEP_DAYS = 7

interface SettingsState {
  backendBaseUrl: string
  requestTimeoutMs: number
  /** 行情自动刷新间隔（毫秒），0 = 关闭 */
  quoteRefreshMs: number
  /** 条件单轮询间隔（毫秒），0 = 关闭 */
  tradePollMs: number
  /** K 线缓存保留天数，0 = 不自动清理 */
  cacheKeepDays: number
  setBackendBaseUrl: (url: string) => void
  setRequestTimeoutMs: (ms: number) => void
  setQuoteRefreshMs: (ms: number) => void
  setTradePollMs: (ms: number) => void
  setCacheKeepDays: (days: number) => void
  reset: () => void
}

const DEFAULTS = {
  backendBaseUrl: DEFAULT_BACKEND_URL,
  requestTimeoutMs: 15000,
  quoteRefreshMs: DEFAULT_QUOTE_REFRESH_MS,
  tradePollMs: DEFAULT_TRADE_POLL_MS,
  cacheKeepDays: DEFAULT_CACHE_KEEP_DAYS,
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      setBackendBaseUrl: (url) => set({ backendBaseUrl: url.trim() }),
      setRequestTimeoutMs: (ms) => set({ requestTimeoutMs: ms }),
      setQuoteRefreshMs: (ms) => set({ quoteRefreshMs: ms }),
      setTradePollMs: (ms) => set({ tradePollMs: ms }),
      setCacheKeepDays: (days) => set({ cacheKeepDays: days }),
      reset: () => set({ ...DEFAULTS }),
    }),
    {
      name: 'qbot.settings',
      // v1 只有后端地址与超时；升级到 v2 时补齐新增字段的默认值，
      // 避免老用户读到 undefined 导致轮询间隔变成 NaN 而彻底停止刷新。
      version: 2,
      migrate: (persisted, version) => {
        const prev = (persisted ?? {}) as Partial<SettingsState>
        if (version < 2) {
          return {
            ...prev,
            quoteRefreshMs: prev.quoteRefreshMs ?? DEFAULT_QUOTE_REFRESH_MS,
            tradePollMs: prev.tradePollMs ?? DEFAULT_TRADE_POLL_MS,
            cacheKeepDays: prev.cacheKeepDays ?? DEFAULT_CACHE_KEEP_DAYS,
          } as SettingsState
        }
        return prev as SettingsState
      },
    },
  ),
)
