/** 与 FastAPI 后端约定的一致数据结构（第一阶段先落地健康检查与行情/基金基础类型） */

export interface HealthResponse {
  status: string
  service: string
  version: string
  akshare_available: boolean
  time: string
}

export type SymbolKind = 'stock' | 'fund' | 'index'

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
  period: string
  adjust: string
  bars: KlineBar[]
}

export interface StockInfo {
  symbol: string
  name: string
  industry: string | null
  market: string | null
  list_date: string | null
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
