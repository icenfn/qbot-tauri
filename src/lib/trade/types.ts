/**
 * 第四阶段（交易与风控）的类型定义。
 *
 * 与 Rust 侧一一对应：
 * - 配置/快照/风控报告 → `gateway/src/lib.rs`（camelCase 序列化）
 * - 条件单入参 → `ConditionalInput`
 *
 * 修改字段名必须两边同步：`invoke` 对多余字段宽松，但缺失字段会变成 undefined，
 * 而且这种错误在 TS 层看起来完全合法，只能靠这里保持一致来防。
 */

/** 买卖方向（Rust 侧 `Side::as_str()` 输出小写） */
export type TradeSide = 'buy' | 'sell'

/** 委托类型：限价 / 市价 */
export type OrderType = 'limit' | 'market'

/** 条件单触发类型，与 `TriggerKind::as_str()` 一致 */
export type TriggerType =
  | 'price_above'
  | 'price_below'
  | 'change_up'
  | 'change_down'
  | 'time_reached'

/** 条件单状态，与 `ConditionalState::as_str()` 一致 */
export type ConditionalState =
  | 'armed'
  | 'triggered'
  | 'filled'
  | 'failed'
  | 'cancelled'

/** 委托状态（本地账本用，含网关回传值） */
export type OrderStatus =
  | 'pending'
  | 'submitted'
  | 'partial'
  | 'filled'
  | 'cancelled'
  | 'rejected'
  | 'failed'

/** 风控拒绝原因，与 `RejectCode::as_str()` 一致 */
export type RejectCode =
  | 'invalid_order'
  | 'blacklisted'
  | 'not_trading_day'
  | 'session_closed'
  | 'exceeds_single_order_limit'
  | 'below_min_order_amount'
  | 'exceeds_position_limit'
  | 'exceeds_daily_order_count'
  | 'exceeds_daily_turnover'
  | 'drawdown_halted'
  | 'insufficient_cash'
  | 'lot_size_violation'

/** 风控限制配置（表单可编辑） */
export interface RiskLimitsConfig {
  /** 单标的持仓市值占净值上限，0.3 = 30% */
  maxPositionPct: number
  /** 单笔委托金额上限（元） */
  maxSingleOrderAmount: number
  /** 单笔委托金额下限（元），0 表示不限制 */
  minSingleOrderAmount: number
  /** 每日最大下单笔数 */
  maxDailyOrders: number
  /** 每日最大成交金额（元） */
  maxDailyTurnover: number
  /** 净值回撤熔断阈值，0.2 = 20% */
  maxDrawdownPct: number
  /** 黑名单标的 */
  blacklist: string[]
  /** 是否校验交易时段 */
  enforceSession: boolean
  /** 交易时段，形如 '09:30-11:30' */
  sessions: string[]
  /** 整手股数，A 股 100 */
  lotSize: number
  /** 熔断时是否仍允许卖出 */
  allowSellWhenHalted: boolean
}

/** 网关连接配置 */
export interface GatewayConfig {
  baseUrl: string
  apiKey: string
  account: string
  timeoutMs: number
  risk: RiskLimitsConfig
}

/** 交易所时钟信息（北京时间） */
export interface ClockInfo {
  tradeDate: string
  /** 距零点分钟数 */
  minute: number
  /** 0=周一 */
  weekday: number
  isWeekend: boolean
  hhmm: string
}

/** 配置读取结果 */
export interface ConfigView {
  config: GatewayConfig
  configured: boolean
  clock: ClockInfo
}

/** 网关持仓 */
export interface PositionInfo {
  symbol: string
  name: string
  volume: number
  availableVolume: number
  costPrice: number
  lastPrice: number
  marketValue: number
}

/** 账户与持仓快照 */
export interface Snapshot {
  account: string
  totalEquity: number
  availableCash: number
  marketValue: number
  positions: PositionInfo[]
  peakEquity: number
  /** 当前回撤（正数，0.15 = 15%） */
  drawdown: number
  /** 单标的最大可用买入金额 */
  positionCap: number
  clock: ClockInfo
}

/** 风控校验报告 */
export interface RiskReport {
  approved: boolean
  /** 拒绝原因码，approved 时为 null */
  code: RejectCode | null
  reason: string
  warnings: string[]
  amount: number
  drawdown: number
  totalEquity: number
  availableCash: number
  positionValue: number
  positionCap: number
  todayOrderCount: number
  todayTurnover: number
  tradeDate: string
  minute: number
}

/** 下单结果 */
export interface PlaceOrderResult {
  accepted: boolean
  clientOrderId: string
  gatewayOrderId: string
  status: string
  message: string
  risk: RiskReport
}

/** 网关未成交委托 */
export interface OpenOrderInfo {
  orderId: string
  symbol: string
  side: string
  orderType: string
  price: number
  volume: number
  status: string
  createdAt: string
}

/** 网关连通性探测结果 */
export interface HealthResult {
  ok: boolean
  message: string
  latencyMs: number
  detail: string | null
}

/** 条件单（前端 / SQLite 视角） */
export interface ConditionalOrder {
  id: string
  account: string
  symbol: string
  name: string
  triggerType: TriggerType
  /** 阈值：价格类为价格，涨跌幅类为比例，时间类为分钟数 */
  threshold: number
  /** 涨跌幅类必填的参考价 */
  referencePrice: number
  side: TradeSide
  volume: number
  /** 触发后的委托价；null 表示市价 */
  limitPrice: number | null
  orderType: OrderType
  state: ConditionalState
  /** 作用日 YYYY-MM-DD */
  tradeDate: string
  firedToday: boolean
  note: string
  createdAt: string
  updatedAt: string
}

/** 条件单评估结果 */
export interface ConditionalCheckResult {
  id: string
  symbol: string
  state: ConditionalState
  firedToday: boolean
  triggered: boolean
  message: string
  clientOrderId: string
  gatewayOrderId: string
  /** 触发后下单被风控拦截时的报告 */
  risk: RiskReport | null
}

/** 本地委托记录 */
export interface OrderRecord {
  id: string
  gatewayOrderId: string
  account: string
  symbol: string
  name: string
  side: TradeSide
  orderType: OrderType
  price: number
  volume: number
  amount: number
  status: OrderStatus
  /** manual（手动）/ conditional（条件单）/ strategy（策略） */
  source: string
  conditionalId: string | null
  message: string
  createdAt: string
  updatedAt: string
}

/** 交易错误（命令层 TradeError 的形状） */
export interface TradeErrorShape {
  kind: 'config' | 'network' | 'rejected' | string
  message: string
}

/** 触发类型的展示信息 */
export const TRIGGER_META: Record<
  TriggerType,
  { label: string; hint: string; unit: string; needsPrice: boolean; needsReference: boolean }
> = {
  price_above: {
    label: '价格上穿',
    hint: '最新价从下向上穿越设定价格时触发',
    unit: '元',
    needsPrice: true,
    needsReference: false,
  },
  price_below: {
    label: '价格下穿',
    hint: '最新价从上向下穿越设定价格时触发（常用于止损）',
    unit: '元',
    needsPrice: true,
    needsReference: false,
  },
  change_up: {
    label: '涨幅达到',
    hint: '相对参考价的涨幅达到设定比例时触发',
    unit: '%',
    needsPrice: true,
    needsReference: true,
  },
  change_down: {
    label: '跌幅达到',
    hint: '相对参考价的跌幅达到设定比例时触发',
    unit: '%',
    needsPrice: true,
    needsReference: true,
  },
  time_reached: {
    label: '到点触发',
    hint: '到达指定时刻时触发（当日只触发一次，收盘前定时平仓常用）',
    unit: '时刻',
    needsPrice: false,
    needsReference: false,
  },
}

/** 风控拒绝原因的中文文案，前端统一从这里取，避免各处硬编码不一致 */
export const REJECT_TEXT: Record<RejectCode, string> = {
  invalid_order: '委托参数无效',
  blacklisted: '标的在黑名单',
  not_trading_day: '今天不是交易日',
  session_closed: '不在交易时段',
  exceeds_single_order_limit: '超过单笔金额上限',
  below_min_order_amount: '低于单笔金额下限',
  exceeds_position_limit: '超过单标的仓位上限',
  exceeds_daily_order_count: '超过每日下单笔数',
  exceeds_daily_turnover: '超过每日成交额上限',
  drawdown_halted: '净值回撤触发熔断',
  insufficient_cash: '可用资金不足',
  lot_size_violation: '买入数量不是整手',
}

/** 条件单状态展示 */
export const CONDITIONAL_STATE_TEXT: Record<ConditionalState, string> = {
  armed: '监控中',
  triggered: '已触发',
  filled: '已下单',
  failed: '失败',
  cancelled: '已失效',
}
