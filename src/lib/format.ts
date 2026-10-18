/** 通用格式化工具：金额、成交量、涨跌幅、日期。三端一致。 */

export function formatPrice(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return value.toFixed(digits)
}

/** 涨跌额，带正负号 */
export function formatChange(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(digits)}`
}

/** 涨跌幅百分比 */
export function formatPercent(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(digits)}%`
}

/** 大数字转中文单位：亿 / 万 */
export function formatAmount(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  const abs = Math.abs(value)
  if (abs >= 1e8) return `${(value / 1e8).toFixed(2)}亿`
  if (abs >= 1e4) return `${(value / 1e4).toFixed(2)}万`
  return value.toFixed(2)
}

/** 成交量：股数转「手」再压缩 */
export function formatVolume(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  const hands = value / 100
  return formatAmount(hands)
}

/** A 股 / 基金涨跌配色：涨红跌绿 */
export function changeColor(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value) || value === 0) {
    return 'var(--qb-text-secondary)'
  }
  return value > 0 ? 'var(--qb-up)' : 'var(--qb-down)'
}

export function changeClass(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value) || value === 0) return ''
  return value > 0 ? 'qb-num-up' : 'qb-num-down'
}

/** 把 'YYYY-MM-DD' 或 ISO 时间规整为 'YYYY-MM-DD' */
export function toDateKey(input: string): string {
  if (!input) return ''
  return input.length > 10 ? input.slice(0, 10) : input
}

/** 生成最近 N 个自然日的 YYYY-MM-DD 区间（用于 K 线起始日） */
export function daysAgoKey(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 区间名映射为天数，供图表区间切换使用 */
export const RANGE_DAYS: Record<string, number> = {
  '1M': 31,
  '3M': 92,
  '6M': 183,
  '1Y': 366,
  '3Y': 1096,
  'ALL': 3650,
}
