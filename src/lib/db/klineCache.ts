/**
 * K 线与净值的本地缓存。
 *
 * 目的：避免每次进入详情页都重新请求（AkShare 单次拉取数秒），
 * 同时保证离线时仍能查看最近一次的数据。
 *
 * 存储：Tauri 环境写 SQLite 的 kline_cache 表；
 * 浏览器预览环境写 localStorage，键名带前缀隔离。
 *
 * 缓存键形如 `600519:daily:qfq`，**必须拆成三个独立列**存储。
 * 早先版本把整串键塞进 `symbol`、并把 `period`/`adjust` 恒写成 'cache'，
 * 于是 `600519:daily:qfq` 与 `600519:weekly:none` 命中同一行（主键是
 * `(symbol, period, adjust)` = `(整串键, 'cache', 'cache')` 各不相同，
 * 但拼接后的语义键完全混乱），日线与周线互相覆盖，表现为「切换周期后数据错乱」。
 * 现在拆列存储，并保留对旧行的读取兼容，避免用户已有缓存直接失效。
 */

import { getDatabase, nowIso } from '@/lib/db'
import { isTauri } from '@/lib/tauri/env'

const LS_PREFIX = 'qbot.kline.'

/** 旧版写库时硬编码的占位值，仅用于兼容读取历史行 */
const LEGACY_PERIOD = 'cache'
const LEGACY_ADJUST = 'cache'

export interface CachedPayload<T> {
  data: T
  updatedAt: string
}

interface KlineCacheRow {
  payload: string
  updatedAt: string
}

/** 拆解缓存键：`symbol:period:adjust` → 三段 */
export function splitKey(key: string): { symbol: string; period: string; adjust: string } {
  const parts = key.split(':')
  if (parts.length >= 3) {
    const adjust = parts[parts.length - 1]
    const period = parts[parts.length - 2]
    const symbol = parts.slice(0, parts.length - 2).join(':')
    return { symbol, period, adjust }
  }
  if (parts.length === 2) {
    return { symbol: parts[0], period: parts[1], adjust: 'none' }
  }
  return { symbol: key, period: 'daily', adjust: 'none' }
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

  const { symbol, period, adjust } = splitKey(key)

  try {
    const db = await getDatabase()
    // 先按规范三维键查询；未命中再回退到旧版「整串键 + cache/cache」的行，
    // 这样升级后用户已有缓存仍可用，不需要清库重建。
    const rows = await db.select<KlineCacheRow[]>(
      `SELECT payload, updated_at AS updatedAt FROM kline_cache
       WHERE (symbol = ? AND period = ? AND adjust = ?)
          OR (symbol = ? AND period = ? AND adjust = ?)
       ORDER BY updated_at DESC
       LIMIT 1`,
      [symbol, period, adjust, key, LEGACY_PERIOD, LEGACY_ADJUST],
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

  const { symbol, period, adjust } = splitKey(key)

  try {
    const db = await getDatabase()
    await db.execute(
      `INSERT INTO kline_cache (symbol, period, adjust, payload, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(symbol, period, adjust) DO UPDATE SET
          payload = excluded.payload,
          updated_at = excluded.updated_at`,
      [symbol, period, adjust, JSON.stringify(data), updatedAt],
    )
  } catch {
    // 缓存写入失败不影响主流程
  }
}

/** 清理全部行情缓存 */
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

/**
 * 清理过期缓存，返回删除条数。
 *
 * 为什么需要：K 线按「标的 × 周期 × 复权」组合缓存，用户翻几十只票、
 * 切换多周期后会积累大量陈旧行；SQLite 单库文件持续膨胀会拖慢后续查询。
 * 默认保留 7 天——A 股日线在 7 天内不会再变，周线以上更久，长期不用的行没有价值。
 */
export async function pruneCache(keepDays = 7): Promise<number> {
  if (!isTauri()) return 0
  const cutoff = new Date(Date.now() - keepDays * 24 * 3600 * 1000).toISOString()
  try {
    const db = await getDatabase()
    const before = await db.select<{ n: number }[]>('SELECT COUNT(*) AS n FROM kline_cache')
    await db.execute('DELETE FROM kline_cache WHERE updated_at < ?', [cutoff])
    const after = await db.select<{ n: number }[]>('SELECT COUNT(*) AS n FROM kline_cache')
    return (before[0]?.n ?? 0) - (after[0]?.n ?? 0)
  } catch {
    return 0
  }
}

/** 缓存统计（供设置页展示） */
export async function cacheStats(): Promise<{ count: number; oldest: string | null }> {
  if (!isTauri()) {
    let count = 0
    for (let i = 0; i < localStorage.length; i += 1) {
      if (localStorage.key(i)?.startsWith(LS_PREFIX)) count += 1
    }
    return { count, oldest: null }
  }
  try {
    const db = await getDatabase()
    const rows = await db.select<{ n: number; oldest: string | null }[]>(
      'SELECT COUNT(*) AS n, MIN(updated_at) AS oldest FROM kline_cache',
    )
    return { count: rows[0]?.n ?? 0, oldest: rows[0]?.oldest ?? null }
  } catch {
    return { count: 0, oldest: null }
  }
}
