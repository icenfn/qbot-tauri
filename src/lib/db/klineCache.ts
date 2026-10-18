/**
 * K 线与净值的本地缓存。
 *
 * 目的：避免每次进入详情页都重新请求（AkShare 单次拉取数秒），
 * 同时保证离线时仍能查看最近一次的数据。
 *
 * 存储：Tauri 环境写 SQLite 的 kline_cache 表；
 * 浏览器预览环境写 localStorage，键名带前缀隔离。
 */

import { getDatabase, nowIso } from '@/lib/db'
import { isTauri } from '@/lib/tauri/env'

const LS_PREFIX = 'qbot.kline.'

export interface CachedPayload<T> {
  data: T
  updatedAt: string
}

interface KlineCacheRow {
  payload: string
  updatedAt: string
}

function lsKey(key: string): string {
  return `${LS_PREFIX}${key}`
}

/**
 * 读取缓存。
 * @param key 缓存键，形如 `600519:daily:qfq`
 * @param maxAgeMs 超过该时长视为过期，返回 null
 */
export async function readCache<T>(
  key: string,
  maxAgeMs: number,
): Promise<CachedPayload<T> | null> {
  const now = Date.now()

  if (!isTauri()) {
    try {
      const raw = localStorage.getItem(lsKey(key))
      if (!raw) return null
      const parsed = JSON.parse(raw) as CachedPayload<T>
      if (!parsed?.updatedAt) return null
      if (now - new Date(parsed.updatedAt).getTime() > maxAgeMs) return null
      return parsed
    } catch {
      return null
    }
  }

  try {
    const db = await getDatabase()
    const rows = await db.select<KlineCacheRow[]>(
      `SELECT payload, updated_at AS updatedAt FROM kline_cache WHERE symbol = ?`,
      [key],
    )
    const row = rows[0]
    if (!row) return null
    if (now - new Date(row.updatedAt).getTime() > maxAgeMs) return null
    return { data: JSON.parse(row.payload) as T, updatedAt: row.updatedAt }
  } catch {
    return null
  }
}

export async function writeCache<T>(key: string, data: T): Promise<void> {
  const updatedAt = nowIso()

  if (!isTauri()) {
    try {
      localStorage.setItem(lsKey(key), JSON.stringify({ data, updatedAt }))
    } catch {
      // 配额超限时静默失败，缓存非关键路径
    }
    return
  }

  try {
    const db = await getDatabase()
    await db.execute(
      `INSERT INTO kline_cache (symbol, period, adjust, payload, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(symbol, period, adjust) DO UPDATE SET
          payload = excluded.payload,
          updated_at = excluded.updated_at`,
      [key, 'cache', 'cache', JSON.stringify(data), updatedAt],
    )
  } catch {
    // 缓存写入失败不影响主流程
  }
}

/** 清理全部行情缓存，返回清理条数（仅桌面/移动端可统计） */
export async function clearAllCache(): Promise<void> {
  if (!isTauri()) {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (key?.startsWith(LS_PREFIX)) keys.push(key)
    }
    keys.forEach((key) => localStorage.removeItem(key))
    return
  }
  const db = await getDatabase()
  await db.execute('DELETE FROM kline_cache')
}
