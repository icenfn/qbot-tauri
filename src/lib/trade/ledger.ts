/**
 * 交易本地账本（orders / fills / conditional_orders）。
 *
 * 为什么账本放前端而不是 Rust：
 * Rust 侧已经有 tauri-plugin-sql 建的库，但若 Rust 再直连一次（sqlx），
 * 就会出现「两套连接 + 两套写入路径」，迁移与事务边界容易打架。
 * 这里让前端独占 SQLite 写入，Rust 只负责「校验 + 执行 + 调网关」，
 * 职责单一：**Rust 决定能不能做，前端记录做了什么**。
 *
 * 浏览器预览环境没有 SQLite，退化为 localStorage，保证界面逻辑可测。
 */
import { getDatabase, nowIso } from '@/lib/db'
import { isTauri } from '@/lib/tauri/env'
import type {
  ConditionalOrder,
  ConditionalState,
  OrderRecord,
  OrderStatus,
  OrderType,
  TradeSide,
} from './types'

const LS_ORDERS = 'qbot.trade.orders'
const LS_CONDITIONALS = 'qbot.trade.conditionals'

/** 条件单入参（写库时补齐时间戳） */
export type NewConditional = Omit<ConditionalOrder, 'createdAt' | 'updatedAt'>

// ---------------------------------------------------------------------------
// 浏览器回退存储
// ---------------------------------------------------------------------------

function lsRead<T>(key: string): T[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function lsWrite<T>(key: string, rows: T[]): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(key, JSON.stringify(rows))
  } catch {
    // 配额不足时静默失败：账本不是关键路径，不应阻断下单流程
  }
}

/** 判断是否走 SQLite */
function useSqlite(): boolean {
  return isTauri()
}

// ---------------------------------------------------------------------------
// 委托
// ---------------------------------------------------------------------------

/** 写入一条委托（下单前先落库，拿到 accepted 后再更新状态） */
export async function insertOrder(row: OrderRecord): Promise<void> {
  if (!useSqlite()) {
    const rows = lsRead<OrderRecord>(LS_ORDERS)
    rows.unshift(row)
    lsWrite(LS_ORDERS, rows.slice(0, 500))
    return
  }
  const db = await getDatabase()
  await db.execute(
    `INSERT INTO orders (id, gateway_order_id, account, symbol, name, side, order_type,
       price, volume, amount, status, source, conditional_id, message, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.gatewayOrderId,
      row.account,
      row.symbol,
      row.name,
      row.side,
      row.orderType,
      row.price,
      row.volume,
      row.amount,
      row.status,
      row.source,
      row.conditionalId,
      row.message,
      row.createdAt,
      row.updatedAt,
    ],
  )
}

/** 更新委托状态（下单回执、撤单、成交回写都走这里） */
export async function updateOrderStatus(
  id: string,
  status: OrderStatus,
  patch: Partial<Pick<OrderRecord, 'gatewayOrderId' | 'price' | 'volume' | 'amount' | 'message'>> = {},
): Promise<void> {
  const updatedAt = nowIso()
  if (!useSqlite()) {
    const rows = lsRead<OrderRecord>(LS_ORDERS).map((r) =>
      r.id === id ? { ...r, ...patch, status, updatedAt } : r,
    )
    lsWrite(LS_ORDERS, rows)
    return
  }
  const db = await getDatabase()
  await db.execute(
    `UPDATE orders SET status = ?, gateway_order_id = COALESCE(?, gateway_order_id),
       price = COALESCE(?, price), volume = COALESCE(?, volume), amount = COALESCE(?, amount),
       message = COALESCE(?, message), updated_at = ?
     WHERE id = ?`,
    [
      status,
      patch.gatewayOrderId ?? null,
      patch.price ?? null,
      patch.volume ?? null,
      patch.amount ?? null,
      patch.message ?? null,
      updatedAt,
      id,
    ],
  )
}

export interface OrderQuery {
  symbol?: string
  limit?: number
}

/** 查询最近委托（默认 100 条） */
export async function listOrders(query: OrderQuery = {}): Promise<OrderRecord[]> {
  const limit = query.limit ?? 100
  if (!useSqlite()) {
    const rows = lsRead<OrderRecord>(LS_ORDERS)
    const filtered = query.symbol
      ? rows.filter((r) => r.symbol.toUpperCase().includes(query.symbol!.toUpperCase()))
      : rows
    return filtered.slice(0, limit)
  }
  const db = await getDatabase()
  const rows = await db.select<
    {
      id: string
      gateway_order_id: string
      account: string
      symbol: string
      name: string
      side: string
      order_type: string
      price: number
      volume: number
      amount: number
      status: string
      source: string
      conditional_id: string | null
      message: string
      created_at: string
      updated_at: string
    }[]
  >(
    query.symbol
      ? `SELECT * FROM orders WHERE symbol LIKE ? ORDER BY created_at DESC LIMIT ?`
      : `SELECT * FROM orders ORDER BY created_at DESC LIMIT ?`,
    query.symbol ? [`%${query.symbol}%`, limit] : [limit],
  )
  return rows.map((r) => ({
    id: r.id,
    gatewayOrderId: r.gateway_order_id,
    account: r.account,
    symbol: r.symbol,
    name: r.name,
    side: r.side as TradeSide,
    orderType: r.order_type as OrderType,
    price: r.price,
    volume: r.volume,
    amount: r.amount,
    status: r.status as OrderStatus,
    source: r.source,
    conditionalId: r.conditional_id,
    message: r.message,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }))
}

/**
 * 今日下单统计（笔数 + 成交金额）。
 *
 * 这两个数字要回灌给风控做「每日笔数 / 每日成交额」上限判断。
 * 只统计非 rejected / failed 的单 —— 被风控拦下的单不该消耗额度，
 * 否则用户改完配置重试时会被自己的失败记录卡住。
 */
export async function todayStats(dateKey: string): Promise<{ count: number; turnover: number }> {
  const rows = await listOrders({ limit: 500 })
  const mine = rows.filter((r) => r.createdAt.slice(0, 10) === dateKey)
  const effective = mine.filter((r) => r.status !== 'rejected' && r.status !== 'failed')
  return {
    count: effective.length,
    turnover: effective.reduce((sum, r) => sum + (r.amount || 0), 0),
  }
}

// ---------------------------------------------------------------------------
// 条件单
// ---------------------------------------------------------------------------

function rowToConditional(r: {
  id: string
  account: string
  symbol: string
  name: string
  trigger_type: string
  threshold: number
  reference_price: number
  side: string
  volume: number
  limit_price: number | null
  order_type: string
  state: string
  trade_date: string
  fired_today: number
  note: string
  created_at: string
  updated_at: string
}): ConditionalOrder {
  return {
    id: r.id,
    account: r.account,
    symbol: r.symbol,
    name: r.name,
    triggerType: r.trigger_type as ConditionalOrder['triggerType'],
    threshold: r.threshold,
    referencePrice: r.reference_price,
    side: r.side as TradeSide,
    volume: r.volume,
    limitPrice: r.limit_price,
    orderType: r.order_type as OrderType,
    state: r.state as ConditionalState,
    tradeDate: r.trade_date,
    firedToday: r.fired_today === 1,
    note: r.note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** 新增条件单 */
export async function insertConditional(item: NewConditional): Promise<ConditionalOrder> {
  const now = nowIso()
  const row: ConditionalOrder = { ...item, createdAt: now, updatedAt: now }
  if (!useSqlite()) {
    const rows = lsRead<ConditionalOrder>(LS_CONDITIONALS)
    rows.unshift(row)
    lsWrite(LS_CONDITIONALS, rows)
    return row
  }
  const db = await getDatabase()
  await db.execute(
    `INSERT INTO conditional_orders (id, account, symbol, name, trigger_type, threshold,
       reference_price, side, volume, limit_price, order_type, state, trade_date,
       fired_today, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.account,
      row.symbol,
      row.name,
      row.triggerType,
      row.threshold,
      row.referencePrice,
      row.side,
      row.volume,
      row.limitPrice,
      row.orderType,
      row.state,
      row.tradeDate,
      row.firedToday ? 1 : 0,
      row.note,
      row.createdAt,
      row.updatedAt,
    ],
  )
  return row
}

/** 更新条件单状态（触发、成交、失败、作废） */
export async function updateConditionalState(
  id: string,
  state: ConditionalState,
  firedToday?: boolean,
  note?: string,
): Promise<void> {
  const updatedAt = nowIso()
  if (!useSqlite()) {
    const rows = lsRead<ConditionalOrder>(LS_CONDITIONALS).map((r) =>
      r.id === id
        ? {
            ...r,
            state,
            firedToday: firedToday ?? r.firedToday,
            note: note ?? r.note,
            updatedAt,
          }
        : r,
    )
    lsWrite(LS_CONDITIONALS, rows)
    return
  }
  const db = await getDatabase()
  await db.execute(
    `UPDATE conditional_orders SET state = ?, fired_today = COALESCE(?, fired_today),
       note = COALESCE(?, note), updated_at = ? WHERE id = ?`,
    [state, firedToday === undefined ? null : firedToday ? 1 : 0, note ?? null, updatedAt, id],
  )
}

/** 列出条件单；默认只列监控中的，便于轮询 */
export async function listConditionals(onlyArmed = true): Promise<ConditionalOrder[]> {
  if (!useSqlite()) {
    const rows = lsRead<ConditionalOrder>(LS_CONDITIONALS)
    return onlyArmed ? rows.filter((r) => r.state === 'armed') : rows
  }
  const db = await getDatabase()
  const rows = await db.select<Parameters<typeof rowToConditional>[0][]>(
    onlyArmed
      ? `SELECT * FROM conditional_orders WHERE state = 'armed' ORDER BY created_at DESC`
      : `SELECT * FROM conditional_orders ORDER BY created_at DESC LIMIT 200`,
  )
  return rows.map(rowToConditional)
}

/** 删除条件单（仅限已终态的，监控中的必须先撤销，避免误删后无法追溯） */
export async function deleteConditional(id: string): Promise<void> {
  if (!useSqlite()) {
    const rows = lsRead<ConditionalOrder>(LS_CONDITIONALS).filter((r) => r.id !== id)
    lsWrite(LS_CONDITIONALS, rows)
    return
  }
  const db = await getDatabase()
  await db.execute(`DELETE FROM conditional_orders WHERE id = ?`, [id])
}
