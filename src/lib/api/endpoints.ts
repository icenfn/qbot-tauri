import { apiFetch, buildQuery, type RequestOptions } from '@/lib/api/client'
import type {
  FundDetail,
  FundInfo,
  FundNavResponse,
  HealthResponse,
  KlineAdjust,
  KlinePeriod,
  KlineResponse,
  MarketOverview,
  Quote,
  SearchResult,
  StockInfo,
  StockProfile,
} from '@/lib/api/types'

export interface KlineParams {
  symbol: string
  period?: KlinePeriod
  adjust?: KlineAdjust
  start?: string
  end?: string
}

export interface FundNavParams {
  code: string
  start?: string
  end?: string
}

/** FastAPI 路由封装，路径与 backend/app/api/v1 保持一致 */
export const api = {
  health: (options?: RequestOptions) => apiFetch<HealthResponse>('/health', {}, options),

  // ---------------- A 股
  stockList: (keyword?: string, options?: RequestOptions) =>
    apiFetch<StockInfo[]>(
      `/api/v1/stocks${buildQuery({ keyword, limit: 200 })}`,
      {},
      options,
    ),

  quotes: (symbols: string[], options?: RequestOptions) => {
    if (symbols.length === 0) return Promise.resolve<Quote[]>([])
    return apiFetch<Quote[]>(
      `/api/v1/stocks/quotes${buildQuery({ symbols: symbols.join(',') })}`,
      {},
      options,
    )
  },

  kline: (params: KlineParams, options?: RequestOptions) =>
    apiFetch<KlineResponse>(
      `/api/v1/stocks/kline${buildQuery({
        symbol: params.symbol,
        period: params.period ?? 'daily',
        adjust: params.adjust ?? 'qfq',
        start: params.start,
        end: params.end,
      })}`,
      {},
      options,
    ),

  stockProfile: (symbol: string, options?: RequestOptions) =>
    apiFetch<StockProfile>(
      `/api/v1/stocks/${encodeURIComponent(symbol)}/profile`,
      {},
      options,
    ),

  // ---------------- 指数 / 市场
  marketOverview: (limit = 6, options?: RequestOptions) =>
    apiFetch<MarketOverview>(`/api/v1/market/overview${buildQuery({ limit })}`, {}, options),

  // ---------------- 基金
  fundList: (keyword?: string, options?: RequestOptions) =>
    apiFetch<FundInfo[]>(
      `/api/v1/funds${buildQuery({ keyword, limit: 200 })}`,
      {},
      options,
    ),

  fundNav: (params: FundNavParams, options?: RequestOptions) =>
    apiFetch<FundNavResponse>(
      `/api/v1/funds/nav${buildQuery({
        code: params.code,
        start: params.start,
        end: params.end,
      })}`,
      {},
      options,
    ),

  fundDetail: (code: string, options?: RequestOptions) =>
    apiFetch<FundDetail>(
      `/api/v1/funds/${encodeURIComponent(code)}/detail`,
      {},
      options,
    ),

  // ---------------- 统一搜索
  search: (keyword: string, limit = 20, options?: RequestOptions) =>
    apiFetch<SearchResult[]>(
      `/api/v1/search${buildQuery({ keyword, limit })}`,
      {},
      options,
    ),
}
