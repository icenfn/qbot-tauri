/**
 * 交易与风控的前端调用封装。
 *
 * 所有命令都走 Tauri `invoke`（Rust 侧原生 HTTP + 风控），不经过 FastAPI：
 * 风控必须在客户端本地执行才能保证三端一致，走远端风控等于把「是否放行」交给网络。
 *
 * 错误处理约定：
 * - Rust 侧 `TradeError { kind, message }` 会被 `invoke` 抛成对象而不是 Error，
 *   这里统一规范成 `TradeRequestError`，页面只处理一种错误类型；
 * - `kind` 用于分支：`network` 提示查网络，`rejected` 提示网关拒绝，`config` 提示改配置。
 */
import { invokeCommand } from '@/lib/tauri/invoke'
import type {
  ClockInfo,
  ConditionalCheckResult,
  ConditionalOrder,
  ConfigView,
  GatewayConfig,
  HealthResult,
  OpenOrderInfo,
  PlaceOrderResult,
  RiskReport,
  Snapshot,
  TradeErrorShape,
} from './types'

/** 统一的交易侧错误：把 Rust 的结构化错误与网络异常都收进来 */
export class TradeRequestError extends Error {
  /** network / rejected / config / unknown */
  readonly kind: string

  constructor(kind: string, message: string) {
    super(message)
    this.name = 'TradeRequestError'
    this.kind = kind
  }

  /** 是否属于「环境没配好」类问题（可以用来提示用户去配置） */
  get isConfigProblem(): boolean {
    return this.kind === 'config'
  }
}

/** 把任何异常规范化成 TradeRequestError */
export function toTradeError(err: unknown): TradeRequestError {
  if (err instanceof TradeRequestError) return err
  if (err && typeof err === 'object') {
    const shape = err as Partial<TradeErrorShape>
    if (typeof shape.kind === 'string' && typeof shape.message === 'string') {
      return new TradeRequestError(shape.kind, shape.message)
    }
  }
  if (err instanceof Error) return new TradeRequestError('unknown', err.message)
  return new TradeRequestError('unknown', String(err))
}

/** 统一包装：把 Rust 的结构化错误转成 TradeRequestError */
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invokeCommand<T>(command, args)
  } catch (err) {
    throw toTradeError(err)
  }
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/** 读取网关配置 */
export function getConfig(): Promise<ConfigView> {
  return call<ConfigView>('trade_get_config')
}

/** 保存网关配置（风控规则非法时 Rust 侧拒绝保存） */
export function saveConfig(config: GatewayConfig): Promise<ConfigView> {
  return call<ConfigView>('trade_save_config', { config })
}

/** 网关连通性探测 */
export function health(): Promise<HealthResult> {
  return call<HealthResult>('trade_health')
}

/** 交易所时钟（A 股北京时间，与设备时区无关） */
export function fetchClock(): Promise<ClockInfo> {
  return call<ClockInfo>('trade_clock').catch(() => {
    // 旧版本没有该命令时退回本地推算，避免页面整块失败
    const now = new Date(Date.now() + (8 * 60 + new Date().getTimezoneOffset()) * 60_000)
    const minute = now.getHours() * 60 + now.getMinutes()
    const weekday = (now.getDay() + 6) % 7
    return {
      tradeDate: now.toISOString().slice(0, 10),
      minute,
      weekday,
      isWeekend: weekday >= 5,
      hhmm: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    }
  })
}

// ---------------------------------------------------------------------------
// 账户与持仓
// ---------------------------------------------------------------------------

/** 拉取账户 + 持仓快照 */
export function snapshot(): Promise<Snapshot> {
  return call<Snapshot>('trade_snapshot')
}

// ---------------------------------------------------------------------------
// 风控预检 / 下单 / 撤单
// ---------------------------------------------------------------------------

export interface PrecheckArgs {
  symbol: string
  side: 'buy' | 'sell'
  orderType: 'limit' | 'market'
  price?: number
  volume: number
  todayOrderCount?: number
  todayTurnover?: number
}

/** 风控预检（不下单） */
export function precheck(args: PrecheckArgs): Promise<RiskReport> {
  return call<RiskReport>('trade_precheck', {
    symbol: args.symbol,
    side: args.side,
    orderType: args.orderType,
    price: args.price,
    volume: args.volume,
    todayOrderCount: args.todayOrderCount ?? 0,
    todayTurnover: args.todayTurnover ?? 0,
  })
}

export interface PlaceOrderArgs extends PrecheckArgs {
  /** 由前端生成并先落库，网关按此做幂等，重试不会重复下单 */
  clientOrderId: string
}

/** 下单（风控通过才会真正发往网关） */
export function placeOrder(args: PlaceOrderArgs): Promise<PlaceOrderResult> {
  return call<PlaceOrderResult>('trade_place_order', {
    symbol: args.symbol,
    side: args.side,
    orderType: args.orderType,
    price: args.price,
    volume: args.volume,
    clientOrderId: args.clientOrderId,
    todayOrderCount: args.todayOrderCount ?? 0,
    todayTurnover: args.todayTurnover ?? 0,
  })
}

/** 撤单 */
export function cancelOrder(orderId: string): Promise<string> {
  return call<string>('trade_cancel_order', { orderId })
}

/** 网关未成交委托 */
export function openOrders(): Promise<OpenOrderInfo[]> {
  return call<OpenOrderInfo[]>('trade_open_orders')
}

// ---------------------------------------------------------------------------
// 条件单
// ---------------------------------------------------------------------------

/** 条件单入参（与 SQLite 行一一对应） */
export type ConditionalInput = Omit<ConditionalOrder, 'createdAt' | 'updatedAt'>

/** 校验条件单配置（不落库、不联网） */
export function validateConditional(item: ConditionalInput): Promise<null> {
  return call<null>('trade_validate_conditional', { item })
}

/** 评估并执行条件单，返回每张单的新状态 */
export function checkConditionals(
  items: ConditionalInput[],
  todayOrderCount = 0,
  todayTurnover = 0,
): Promise<ConditionalCheckResult[]> {
  return call<ConditionalCheckResult[]>('trade_check_conditionals', {
    items,
    todayOrderCount,
    todayTurnover,
  })
}

// ---------------------------------------------------------------------------
// 前端本地工具
// ---------------------------------------------------------------------------

/**
 * 生成客户端委托号。
 *
 * 用 时间戳 + 随机后缀 而不是纯自增：多端（桌面 + 手机）同时下单时，
 * 纯自增会撞号，撞号会让网关幂等判断错误地把两笔单当成同一笔。
 */
export function newClientOrderId(): string {
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 8)
  return `qb${ts}${rand}`
}

/** 生成条件单 ID */
export function newConditionalId(): string {
  return `cd${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** 今日日期（北京时间），用于条件单作用日 */
export function todayKey(): string {
  const now = new Date(Date.now() + (8 * 60 + new Date().getTimezoneOffset()) * 60_000)
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
