/**
 * 交易日志的查询、汇总与导出。
 *
 * 与 `ledger.ts` 的分工：
 * - `ledger.ts` 负责「写入」与简单的最近记录读取（供交易页内嵌小表用）；
 * - 本模块负责「按多条件检索 + 汇总 + 导出」，供独立的交易日志页使用。
 *
 * 拆开的原因：日志页需要日期区间、方向、状态、来源、关键词的任意组合过滤，
 * 这类动态 SQL 拼接如果塞进 ledger.ts 会让那个文件的职责变得含糊，
 * 而且动态条件拼接是容易出错的地方，单独成文件更好审阅。
 */

import { getDatabase } from '@/lib/db'
import { isTauri } from '@/lib/tauri/env'
import type { OrderRecord, OrderStatus, OrderType, TradeSide } from './types'

const LS_ORDERS = 'qbot.trade.orders'

export interface LogFilter {
  /** 起始日期（含），格式 YYYY-MM-DD */
  from?: string
  /** 结束日期（含），格式 YYYY-MM-DD */
  to?: string
  /** 标的代码或名称关键词 */
  keyword?: string
  side?: TradeSide | ''
  status?: OrderStatus | ''
  /** manual / conditional / strategy */
  source?: string
  /** 最多返回条数，默认 500 */
  limit?: number
}

export interface LogSummary {
  /** 记录总数 */
  total: number
  /** 买入笔数 / 卖出笔数 */
  buyCount: number
  sellCount: number
  /** 买入金额 / 卖出金额 */
  buyAmount: number
  sellAmount: number
  /** 有效成交金额（排除 rejected / failed） */
  turnover: number
  /** 风控拒绝笔数 */
  rejectedCount: number
  /** 失败笔数 */
  failedCount: number
}

interface OrderRow {
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
}

function toRecord(r: OrderRow): OrderRecord {
  return {
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
  }
}

/**
 * 按条件检索交易记录。
 *
 * 日期用 `substr(created_at, 1, 10)` 比较而不是 `date(created_at)`：
 * created_at 存的是 ISO 字符串（`2026-10-19T13:05:00.000Z`），前缀就是日期，
 * 用 substr 可以命中 `idx_orders_created` 索引；套一层 date() 函数会让索引失效。
 *
 * 注意时区：created_at 是 UTC。前端传入的 from/to 也是按 UTC 日期算的，
 * 边界由调用方负责（日志页用「本地日 0 点」转 UTC 后取日期部分），
 * 这里只做纯字符串比较，避免在 SQL 里做时区换算导致不可预测。
 */
export async function queryOrders(filter: LogFilter = {}): Promise<OrderRecord[]> {
  const limit = filter.limit ?? 500
  const keyword = filter.keyword?.trim()

  if (!isTauri()) {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_ORDERS) : null
    let rows: OrderRecord[] = []
    try {
      const parsed = raw ? JSON.parse(raw) : []
      rows = Array.isArray(parsed) ? parsed : []
    } catch {
      rows = []
    }
    return rows
      .filter((r) => {
        if (filter.from && r.createdAt.slice(0, 10) < filter.from) return false
        if (filter.to && r.createdAt.slice(0, 10) > filter.to) return false
        if (filter.side && r.side !== filter.side) return false
        if (filter.status && r.status !== filter.status) return false
        if (filter.source && r.source !== filter.source) return false
        if (keyword) {
          const q = keyword.toUpperCase()
          if (!r.symbol.toUpperCase().includes(q) && !(r.name ?? '').toUpperCase().includes(q)) {
            return false
          }
        }
        return true
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit)
  }

  const where: string[] = []
  const params: unknown[] = []

  if (filter.from) {
    where.push('substr(created_at, 1, 10) >= ?')
    params.push(filter.from)
  }
  if (filter.to) {
    where.push('substr(created_at, 1, 10) <= ?')
    params.push(filter.to)
  }
  if (filter.side) {
    where.push('side = ?')
    params.push(filter.side)
  }
  if (filter.status) {
    where.push('status = ?')
    params.push(filter.status)
  }
  if (filter.source) {
    where.push('source = ?')
    params.push(filter.source)
  }
  if (keyword) {
    where.push('(symbol LIKE ? OR name LIKE ?)')
    params.push(`%${keyword}%`, `%${keyword}%`)
  }

  const sql = `SELECT * FROM orders${
    where.length ? ` WHERE ${where.join(' AND ')}` : ''
  } ORDER BY created_at DESC LIMIT ?`
  params.push(limit)

  const db = await getDatabase()
  const rows = await db.select<OrderRow[]>(sql, params)
  return rows.map(toRecord)
}

/** 汇总统计。基于已检索结果计算，保证与表格显示一致 */
export function summarize(rows: OrderRecord[]): LogSummary {
  const summary: LogSummary = {
    total: rows.length,
    buyCount: 0,
    sellCount: 0,
    buyAmount: 0,
    sellAmount: 0,
    turnover: 0,
    rejectedCount: 0,
    failedCount: 0,
  }
  for (const r of rows) {
    if (r.side === 'buy') {
      summary.buyCount += 1
      summary.buyAmount += r.amount || 0
    } else if (r.side === 'sell') {
      summary.sellCount += 1
      summary.sellAmount += r.amount || 0
    }
    if (r.status === 'rejected') summary.rejectedCount += 1
    else if (r.status === 'failed') summary.failedCount += 1
    else summary.turnover += r.amount || 0
  }
  return summary
}

/** CSV 转义：字段含逗号/引号/换行时用双引号包裹并把内部引号翻倍 */
function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

/**
 * 导出 CSV。
 *
 * 前置 `\uFEFF`（BOM）：Excel 直接双击打开 UTF-8 CSV 时，
 * 没有 BOM 会把中文显示成乱码，这是国内用户最常见的抱怨点。
 */
export function ordersToCsv(rows: OrderRecord[]): string {
  const header = [
    '委托号',
    '网关委托号',
    '账号',
    '代码',
    '名称',
    '方向',
    '类型',
    '委托价',
    '数量',
    '金额',
    '状态',
    '来源',
    '说明',
    '创建时间',
    '更新时间',
  ]
  const lines = [header.join(',')]
  for (const r of rows) {
    lines.push(
      [
        r.id,
        r.gatewayOrderId,
        r.account,
        r.symbol,
        r.name,
        r.side === 'buy' ? '买入' : '卖出',
        r.orderType === 'market' ? '市价' : '限价',
        r.price,
        r.volume,
        r.amount,
        r.status,
        r.source,
        r.message,
        r.createdAt,
        r.updatedAt,
      ]
        .map(csvCell)
        .join(','),
    )
  }
  return `\uFEFF${lines.join('\r\n')}`
}

/** 触发浏览器下载（浏览器预览环境也可用） */
export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  // 立刻回收：某些 WebView 在点击后仍需短暂持有 URL，延迟释放更稳妥
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 清理指定日期之前的日志，返回删除条数 */
export async function purgeOrdersBefore(dateKey: string): Promise<number> {
  if (!isTauri()) {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_ORDERS) : null
    let rows: OrderRecord[] = []
    try {
      const parsed = raw ? JSON.parse(raw) : []
      rows = Array.isArray(parsed) ? parsed : []
    } catch {
      rows = []
    }
    const kept = rows.filter((r) => r.createdAt.slice(0, 10) >= dateKey)
    localStorage.setItem(LS_ORDERS, JSON.stringify(kept))
    return rows.length - kept.length
  }
  const db = await getDatabase()
  const before = await db.select<{ n: number }[]>('SELECT COUNT(*) AS n FROM orders')
  await db.execute('DELETE FROM orders WHERE substr(created_at, 1, 10) < ?', [dateKey])
  const after = await db.select<{ n: number }[]>('SELECT COUNT(*) AS n FROM orders')
  return (before[0]?.n ?? 0) - (after[0]?.n ?? 0)
}
