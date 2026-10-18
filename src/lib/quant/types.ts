/**
 * 第三阶段量化能力的类型定义。
 *
 * 与 Rust 侧 `src-tauri/src/quant/mod.rs` 的 DTO 一一对应（全部 camelCase）。
 * 修改字段名时必须两边同步，否则 `invoke` 返回的对象字段会静默变成 undefined。
 */

/** 参数输入类型，决定前端渲染数字输入框还是滑块 */
export type ParamKind = 'int' | 'float'

/** 策略参数规格，由 Rust 侧统一定义，前端据此自动生成表单 */
export interface ParamSpec {
  key: string
  label: string
  kind: ParamKind
  defaultValue: number
  min: number | null
  max: number | null
  step: number | null
  hint: string
}

/** 策略元信息 */
export interface StrategyMeta {
  id: string
  name: string
  description: string
  params: ParamSpec[]
}

/** 策略参数取值表 */
export type ParamValues = Record<string, number>

/** 回测配置（全部可选，缺省用 A 股默认值） */
export interface BacktestConfigInput {
  initialCash?: number
  commissionRate?: number
  minCommission?: number
  stampDutyRate?: number
  transferFeeRate?: number
  slippageRate?: number
  lotSize?: number
  stopLoss?: number
  takeProfit?: number
  allowT0?: boolean
  maxPositionPct?: number
}

/** 一笔成交 */
export interface BacktestTrade {
  date: string
  side: 'buy' | 'sell'
  price: number
  shares: number
  amount: number
  fee: number
  realizedPnl: number | null
  reason: string
  positionAfter: number
}

/** 一笔完整的买卖往返（用于胜率统计） */
export interface ClosedTrade {
  entryDate: string
  exitDate: string
  entryPrice: number
  exitPrice: number
  shares: number
  pnl: number
  returnPct: number
  holdingDays: number
}

/** 权益曲线上的一个点 */
export interface EquityPoint {
  date: string
  equity: number
  cash: number
  positionValue: number
  close: number
  /** 回撤，负值（-0.12 表示回撤 12%） */
  drawdown: number
}

/** 绩效指标 */
export interface BacktestMetrics {
  totalReturn: number
  annualReturn: number
  annualVolatility: number
  maxDrawdown: number
  maxDrawdownStart: string | null
  maxDrawdownEnd: string | null
  sharpe: number
  sortino: number
  calmar: number
  winRate: number
  /** 盈亏比为无穷大时为 null（JSON 不支持 Infinity） */
  profitFactor: number | null
  tradeCount: number
  avgHoldingDays: number
  totalFees: number
  benchmarkReturn: number
  excessReturn: number
}

/** 回测结果 */
export interface BacktestResult {
  symbol: string
  strategyId: string
  strategyName: string
  startDate: string
  endDate: string
  bars: number
  initialCash: number
  finalEquity: number
  trades: BacktestTrade[]
  closedTrades: ClosedTrade[]
  equityCurve: EquityPoint[]
  metrics: BacktestMetrics
}

/** 参数优化的一个候选 */
export interface OptimizeCandidate {
  params: ParamValues
  score: number
  totalReturn: number
  maxDrawdown: number
  sharpe: number
  tradeCount: number
  winRate: number
}

/** 参数优化报告 */
export interface OptimizeReport {
  strategyId: string
  objective: string
  evaluated: number
  candidates: OptimizeCandidate[]
  /** 最优值落在搜索边界时的过拟合提示 */
  boundaryWarnings: string[]
}

/** 优化目标 */
export type OptimizeObjective = 'sharpe' | 'total_return' | 'calmar' | 'sortino'

/** 策略信号：'hold' | 'exit' | 'target:0.5000' */
export type StrategySignal = string
