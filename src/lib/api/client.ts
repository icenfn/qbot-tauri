import { useSettingsStore } from '@/stores/settings'
import { isTauri } from '@/lib/tauri/env'

export class ApiError extends Error {
  readonly status: number
  readonly detail: string

  constructor(message: string, status = 0, detail = '') {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
  }
}

export interface RequestOptions {
  timeoutMs?: number
  /** 传入后由调用方控制取消 */
  signal?: AbortSignal
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

function resolveUrl(path: string): string {
  const base = useSettingsStore.getState().backendBaseUrl.replace(/\/+$/, '')
  return `${base}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * 选择实际的 fetch 实现。
 *
 * 为什么 Tauri 环境必须走 plugin-http：
 * 1. Android 9+ 默认禁止 WebView 明文 HTTP，插件走 Rust reqwest 不受该策略限制；
 * 2. 桌面端自定义协议下跨域请求会被 CORS 拦截，插件同样规避；
 * 3. 三端行为完全一致，不需要为平台写分支逻辑。
 */
async function resolveFetch(): Promise<FetchLike> {
  if (isTauri()) {
    const mod = await import('@tauri-apps/plugin-http')
    return mod.fetch as unknown as FetchLike
  }
  return (input, init) => fetch(input, init)
}

function describeFetchError(error: unknown, url: string): ApiError {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new ApiError(`请求超时：${url}`)
  }
  const message = error instanceof Error ? error.message : String(error)
  return new ApiError(`无法连接后端服务：${message}（目标 ${url}）`)
}

/**
 * 统一的后端请求封装：自动拼接地址、超时中断、错误规整。
 */
export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
  options: RequestOptions = {},
): Promise<T> {
  const url = resolveUrl(path)
  const timeoutMs = options.timeoutMs ?? useSettingsStore.getState().requestTimeoutMs

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  if (options.signal) {
    if (options.signal.aborted) controller.abort()
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  const doFetch = await resolveFetch()

  let response: Response
  try {
    response = await doFetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    })
  } catch (error) {
    throw describeFetchError(error, url)
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    let detail = ''
    try {
      const payload = (await response.json()) as { detail?: string }
      detail = payload?.detail ?? ''
    } catch {
      detail = await response.text().catch(() => '')
    }
    throw new ApiError(
      `后端返回错误 ${response.status}${detail ? `：${detail}` : ''}`,
      response.status,
      detail,
    )
  }

  if (response.status === 204) {
    return undefined as T
  }

  return (await response.json()) as T
}

export function buildQuery(
  params: Record<string, string | number | boolean | undefined | null>,
): string {
  const search = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return
    search.set(key, String(value))
  })
  const query = search.toString()
  return query ? `?${query}` : ''
}
