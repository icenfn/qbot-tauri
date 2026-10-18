/**
 * 量化能力的前端调用封装。
 *
 * 设计要点：
 * - 全部走 Tauri `invoke`（Rust 侧原生计算），**不经过 FastAPI**。
 *   原因：回测是逐 Bar 紧循环，走 HTTP 反而增加序列化开销，且离线时不可用。
 * - 浏览器预览环境下统一抛 `TauriUnavailableError`，由页面捕获后展示友好提示，
 *   而不是让 `invoke` 内部报错。
 * - K 线入参在这里做一次「裁剪 + 类型收敛」，避免把前端的多余字段传给 Rust
 *   （Rust 侧反序列化对未知字段是宽松的，但显式裁剪更清晰）。
 */
import { invokeCommand } from '@/lib/tauri/invoke'
import type { KlineBar } from '@/lib/api/types'
import type {
  BacktestConfigInput,
  BacktestResult,
  OptimizeObjective,
  OptimizeReport,
  ParamValues,
  StrategyMeta,
  StrategySignal,
} from './types'

/** Rust 侧 K 线入参结构 */
interface BarArg {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  amount: number
}

/** 只保留 Rust 需要的字段，并兜住 null/undefined */
function toBars(bars: KlineBar[]): BarArg[] {
  return bars.map((b) => ({
    date: b.date,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: Number.isFinite(b.volume) ? b.volume : 0,
    amount: Number.isFinite(b.amount) ? b.amount : 0,
  }))
}

/** 列出全部策略及参数规格 */
export function listStrategies(): Promise<StrategyMeta[]> {
  return invokeCommand<StrategyMeta[]>('list_strategies')
}

/**
 * 只计算信号序列（不跑回测），用于在 K 线图上叠加买卖点。
 * 返回数组与 K 线等长。
 */
export function strategySignals(
  strategyId: string,
  bars: KlineBar[],
  params: ParamValues,
): Promise<StrategySignal[]> {
  return invokeCommand<StrategySignal[]>('strategy_signals', {
    strategyId,
    bars: toBars(bars),
    params,
  })
}

/** 执行一次回测 */
export function runBacktest(args: {
  symbol: string
  strategyId: string
  bars: KlineBar[]
  params: ParamValues
  config?: BacktestConfigInput
}): Promise<BacktestResult> {
  return invokeCommand<BacktestResult>('run_backtest', {
    symbol: args.symbol,
    strategyId: args.strategyId,
    bars: toBars(args.bars),
    params: args.params,
    config: args.config ?? {},
  })
}

/** 网格参数优化 */
export function optimizeParams(args: {
  strategyId: string
  bars: KlineBar[]
  baseParams: ParamValues
  grid: { key: string; values: number[] }[]
  config?: BacktestConfigInput
  objective?: OptimizeObjective
  keep?: number
}): Promise<OptimizeReport> {
  return invokeCommand<OptimizeReport>('optimize_params', {
    strategyId: args.strategyId,
    bars: toBars(args.bars),
    baseParams: args.baseParams,
    grid: args.grid,
    config: args.config ?? {},
    objective: args.objective ?? 'sharpe',
    keep: args.keep ?? 10,
  })
}

/** 计算单个技术指标序列（`null` 表示预热期） */
export function computeIndicator(
  name: string,
  bars: KlineBar[],
  period?: number,
  mult?: number,
): Promise<(number | null)[]> {
  return invokeCommand<(number | null)[]>('compute_indicator', {
    name,
    bars: toBars(bars),
    period,
    mult,
  })
}

/**
 * 生成线性参数网格（含首尾）。
 * 用于「一键生成优化空间」，步长按 (max-min)/(steps-1) 计算。
 */
export function linspace(min: number, max: number, steps: number, integer = true): number[] {
  const n = Math.max(2, Math.floor(steps))
  const step = (max - min) / (n - 1)
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const raw = min + step * i
    out.push(integer ? Math.round(raw) : Number(raw.toFixed(4)))
  }
  // 去重（整数取整后可能出现重复）
  return Array.from(new Set(out))
}
