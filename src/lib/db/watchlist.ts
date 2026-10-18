/**
 * 自选标的数据仓库。
 * Tauri 环境写 SQLite；浏览器预览环境写 localStorage，保证界面逻辑三端一致可测。
 */
import { getDatabase, nowIso } from '@/lib/db'
import { isTauri } from '@/lib/tauri/env'
import type { SymbolKind } from '@/lib/api/types'

export interface WatchItem {
  symbol: string
  name: string
  kind: SymbolKind
  group: string
  sort: number
  createdAt: string
}

export interface NewWatchItem {
  symbol: string
  name?: string
  kind?: SymbolKind
  group?: string
}

const LS_KEY = 'qbot.watchlist'

interface WatchRow {
  symbol: string
  name: string
  kind: string
  groupName: string
  sort: number
  createdAt: string
}

function readLocal(): WatchItem[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as WatchItem[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeLocal(items: WatchItem[]): void {
  localStorage.setItem(LS_KEY, JSON.stringify(items))
}

function toKind(value: string): SymbolKind {
  return value === 'fund' || value === 'index' ? value : 'stock'
}

function compareItems(a: WatchItem, b: WatchItem): number {
  if (a.sort !== b.sort) return a.sort - b.sort
  return a.createdAt.localeCompare(b.createdAt)
}

export async function listWatchlist(): Promise<WatchItem[]> {
  if (!isTauri()) {
    return readLocal().sort(compareItems)
  }
  const db = await getDatabase()
  const rows = await db.select<WatchRow[]>(
    `SELECT symbol, name, kind, grp AS groupName, sort, created_at AS createdAt
       FROM watchlist
      ORDER BY sort ASC, created_at ASC`,
  )
  return rows.map((row) => ({
    symbol: row.symbol,
    name: row.name,
    kind: toKind(row.kind),
    group: row.groupName,
    sort: row.sort,
    createdAt: row.createdAt,
  }))
}

export async function addWatchItem(input: NewWatchItem): Promise<WatchItem> {
  const symbol = input.symbol.trim().toUpperCase()
  if (!symbol) throw new Error('标的代码不能为空')

  const item: WatchItem = {
    symbol,
    name: (input.name ?? '').trim(),
    kind: input.kind ?? 'stock',
    group: (input.group ?? 'default').trim() || 'default',
    sort: Date.now(),
    createdAt: nowIso(),
  }

  if (!isTauri()) {
    const items = readLocal().filter((it) => it.symbol !== symbol)
    items.push(item)
    writeLocal(items)
    return item
  }

  const db = await getDatabase()
  await db.execute(
    `INSERT INTO watchlist (symbol, name, kind, grp, sort, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET
        name = excluded.name,
        kind = excluded.kind,
        grp  = excluded.grp`,
    [item.symbol, item.name, item.kind, item.group, item.sort, item.createdAt],
  )
  return item
}

export async function removeWatchItem(symbol: string): Promise<void> {
  const key = symbol.trim().toUpperCase()
  if (!isTauri()) {
    writeLocal(readLocal().filter((it) => it.symbol !== key))
    return
  }
  const db = await getDatabase()
  await db.execute('DELETE FROM watchlist WHERE symbol = ?', [key])
}

export async function clearWatchlist(): Promise<void> {
  if (!isTauri()) {
    writeLocal([])
    return
  }
  const db = await getDatabase()
  await db.execute('DELETE FROM watchlist')
}
