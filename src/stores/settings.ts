import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * 后端服务默认地址。
 * - Windows / Linux 桌面：本机 FastAPI
 * - Android 真机：需在设置页改为局域网地址（如 http://192.168.1.10:8000）
 */
export const DEFAULT_BACKEND_URL: string =
  import.meta.env.VITE_DEFAULT_BACKEND_URL ?? 'http://127.0.0.1:8000'

interface SettingsState {
  backendBaseUrl: string
  requestTimeoutMs: number
  setBackendBaseUrl: (url: string) => void
  setRequestTimeoutMs: (ms: number) => void
  reset: () => void
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      backendBaseUrl: DEFAULT_BACKEND_URL,
      requestTimeoutMs: 15000,
      setBackendBaseUrl: (url) => set({ backendBaseUrl: url.trim() }),
      setRequestTimeoutMs: (ms) => set({ requestTimeoutMs: ms }),
      reset: () =>
        set({ backendBaseUrl: DEFAULT_BACKEND_URL, requestTimeoutMs: 15000 }),
    }),
    { name: 'qbot.settings', version: 1 },
  ),
)
