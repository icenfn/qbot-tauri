import { apiFetch, buildQuery, type RequestOptions } from '@/lib/api/client'
import type {
  FundInfo,
  FundNavResponse,
  HealthResponse,
  KlineResponse,
  Quote,
  StockInfo,
} from '@/lib/api/types'

export interface KlineParams {
  symbol: string
  period?: 'daily' | 'weekly' | 'monthly'
  adjust?: 'none' | 'qfq' | 'hfq'
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

  stockList: (keyword?: string, options?: RequestOptions) =>
    apiFetch<StockInfo[]>(
      `/api/v1/stocks${buildQuery({ keyword, limit: 200 })}`,
      {},
      options,
    ),

  quotes: (symbols: string[], options?: RequestOptions) =>
    apiFetch<Quote[]>(
      `/api/v1/stocks/quotes${buildQuery({ symbols: symbols.join(',') })}`,
      {},
      options,
    ),

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
}
