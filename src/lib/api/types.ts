/**
 * 与 FastAPI 后端约定的一致数据结构。
 * 字段名与 backend/app/schemas.py 严格对应（snake_case），
 * 不做驼峰转换，避免两端出现隐性不一致。
 */

export interface HealthResponse {
  status: string
  service: string
  version: string
  akshare_available: boolean
  akshare_version: string | null
  cache_entries: number
  time: string
}

export type SymbolKind = 'stock' | 'fund' | 'index'
export type KlinePeriod = 'daily' | 'weekly' | 'monthly'
export type KlineAdjust = 'none' | 'qfq' | 'hfq'

export interface Quote {
  symbol: string
  name: string
  price: number
  prev_close: number
  open: number
  high: number
  low: number
  change: number
  change_pct: number
  volume: number
  amount: number
  turnover: number | null
  pe_ttm: number | null
  timestamp: string
}

export interface KlineBar {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  amount: number
  change_pct: number | null
}

export interface KlineResponse {
  symbol: string
  period: KlinePeriod
  adjust: KlineAdjust
  bars: KlineBar[]
}

export interface StockInfo {
  symbol: string
  name: string
  industry: string | null
  market: string | null
  list_date: string | null
}

export interface StockProfile {
  symbol: string
  name: string
  industry: string | null
  market: string | null
  list_date: string | null
  total_market_cap: number | null
  float_market_cap: number | null
  total_shares: number | null
  float_shares: number | null
}

export interface IndexQuote {
  symbol: string
  name: string
  price: number
  change: number
  change_pct: number
  volume: number
  amount: number
}

export interface MarketOverview {
  indices: IndexQuote[]
  updated_at: string
}

export interface FundInfo {
  code: string
  name: string
  type: string | null
  company: string | null
  manager: string | null
  size: number | null
}

export interface FundNavPoint {
  date: string
  nav: number
  acc_nav: number | null
  daily_return: number | null
}

export interface FundNavResponse {
  code: string
  name: string
  points: FundNavPoint[]
}

export interface FundDetail {
  code: string
  name: string
  type: string | null
  company: string | null
  manager: string | null
  size: number | null
  latest_nav: number | null
  latest_date: string | null
  points: FundNavPoint[]
}

export interface SearchResult {
  symbol: string
  name: string
  kind: SymbolKind
}
