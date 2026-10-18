/**
 * 交易中心。
 *
 * 页面结构与职责（自上而下）：
 * 1. **网关与风控配置**：连接参数 + 风控规则。风控规则不是「参考项」，
 *    而是本地硬约束 —— 保存时 Rust 侧会校验合法性与一致性（如下限不能大于上限）。
 * 2. **账户与持仓**：净值、可用资金、回撤、单标的额度，全部来自网关快照；
 *    净值峰值由本地持久化，保证回撤熔断跨会话有效。
 * 3. **下单**：限价 / 市价，买入卖出。**提交前强制走风控预检**，
 *    被拦时直接显示原因码与中文说明，且不允许绕过。
 * 4. **条件单**：本地 SQLite 存规则，定时向 Rust 请求评估；
 *    触发后的下单同样过风控，被拦则条件单转 failed 并在备注写明原因。
 * 5. **交易日志**：本地账本（orders 表），可按标的过滤。
 *
 * 为什么不在前端直接 fetch 网关：
 * 风控必须与执行原子地串在一起，否则「前端校验 → 后端下单」之间的时间窗
 * 会让仓位上限、当日笔数等约束被并发击穿。Rust 侧一次调用内完成「取快照 → 校验 → 下单」。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Collapse,
  Descriptions,
  Divider,
  Empty,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Row,
  Segmented,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  message,
} from 'antd'
import {
  ApiOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  PlusOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { usePlatform } from '@/hooks/usePlatform'
import { isTauri } from '@/lib/tauri/env'
import { formatAmount, formatPrice } from '@/lib/format'
import {
  cancelOrder,
  checkConditionals,
  getConfig,
  health,
  newClientOrderId,
  newConditionalId,
  openOrders,
  placeOrder,
  precheck,
  saveConfig,
  snapshot,
  todayKey,
  validateConditional,
} from '@/lib/trade/api'
import type { ConditionalInput } from '@/lib/trade/api'
import {
  deleteConditional,
  insertConditional,
  insertOrder,
  listConditionals,
  listOrders,
  todayStats,
  updateConditionalState,
  updateOrderStatus,
} from '@/lib/trade/ledger'
import {
  CONDITIONAL_STATE_TEXT,
  REJECT_TEXT,
  TRIGGER_META,
  type ConditionalOrder,
  type ConditionalState,
  type GatewayConfig,
  type OpenOrderInfo,
  type OrderRecord,
  type OrderType,
  type PositionInfo,
  type RiskReport,
  type Snapshot,
  type TradeSide,
  type TriggerType,
} from '@/lib/trade/types'

const { Text, Paragraph, Title } = Typography

/** 表单默认值：与 Rust 侧 `RiskLimitsConfig::default()` 保持一致 */
const DEFAULT_CONFIG: GatewayConfig = {
  baseUrl: '',
  apiKey: '',
  account: 'default',
  timeoutMs: 8000,
  risk: {
    maxPositionPct: 0.3,
    maxSingleOrderAmount: 50000,
    minSingleOrderAmount: 0,
    maxDailyOrders: 50,
    maxDailyTurnover: 500000,
    maxDrawdownPct: 0.2,
    blacklist: [],
    enforceSession: true,
    sessions: ['09:30-11:30', '13:00-15:00'],
    lotSize: 100,
    allowSellWhenHalted: true,
  },
}

interface ConfigFormValues {
  baseUrl: string
  apiKey: string
  account: string
  timeoutMs: number
  maxPositionPctPct: number
  maxSingleOrderAmount: number
  minSingleOrderAmount: number
  maxDailyOrders: number
  maxDailyTurnover: number
  maxDrawdownPctPct: number
  blacklistText: string
  enforceSession: boolean
  sessionsText: string
  lotSize: number
  allowSellWhenHalted: boolean
}

/** 把配置转成表单值：百分比字段 ×100 便于用户填整数 */
function toForm(config: GatewayConfig): ConfigFormValues {
  return {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    account: config.account,
    timeoutMs: config.timeoutMs,
    maxPositionPctPct: Number((config.risk.maxPositionPct * 100).toFixed(4)),
    maxSingleOrderAmount: config.risk.maxSingleOrderAmount,
    minSingleOrderAmount: config.risk.minSingleOrderAmount,
    maxDailyOrders: config.risk.maxDailyOrders,
    maxDailyTurnover: config.risk.maxDailyTurnover,
    maxDrawdownPctPct: Number((config.risk.maxDrawdownPct * 100).toFixed(4)),
    blacklistText: config.risk.blacklist.join(', '),
    enforceSession: config.risk.enforceSession,
    sessionsText: config.risk.sessions.join(', '),
    lotSize: config.risk.lotSize,
    allowSellWhenHalted: config.risk.allowSellWhenHalted,
  }
}

/** 表单值转回配置：百分比 ÷100，逗号分隔字段解析成数组 */
function fromForm(values: ConfigFormValues): GatewayConfig {
  return {
    baseUrl: values.baseUrl.trim(),
    apiKey: values.apiKey.trim(),
    account: values.account.trim() || 'default',
    timeoutMs: values.timeoutMs,
    risk: {
      maxPositionPct: values.maxPositionPctPct / 100,
      maxSingleOrderAmount: values.maxSingleOrderAmount,
      minSingleOrderAmount: values.minSingleOrderAmount,
      maxDailyOrders: values.maxDailyOrders,
      maxDailyTurnover: values.maxDailyTurnover,
      maxDrawdownPct: values.maxDrawdownPctPct / 100,
      blacklist: values.blacklistText
        .split(/[,，\s]+/)
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
      enforceSession: values.enforceSession,
      sessions: values.sessionsText
        .split(/[,，]+/)
        .map((s) => s.trim())
        .filter(Boolean),
      lotSize: values.lotSize,
      allowSellWhenHalted: values.allowSellWhenHalted,
    },
  }
}

/** 风控报告的状态色 */
function reportTone(report: RiskReport | null): 'ok' | 'warn' | 'error' | 'idle' {
  if (!report) return 'idle'
  if (!report.approved) return 'error'
  return report.warnings.length > 0 ? 'warn' : 'ok'
}

/** 条件单状态对应的 Tag 颜色 */
const STATE_COLOR: Record<ConditionalState, string> = {
  armed: 'processing',
  triggered: 'warning',
  filled: 'success',
  failed: 'error',
  cancelled: 'default',
}

/** 委托状态对应的 Tag 颜色 */
const ORDER_STATUS_COLOR: Record<string, string> = {
  pending: 'default',
  submitted: 'processing',
  partial: 'warning',
  filled: 'success',
  cancelled: 'default',
  rejected: 'error',
  failed: 'error',
}

const ORDER_STATUS_TEXT: Record<string, string> = {
  pending: '待提交',
  submitted: '已报',
  partial: '部分成交',
  filled: '已成交',
  cancelled: '已撤',
  rejected: '风控拒绝',
  failed: '失败',
}

export default function TradePage() {
  const { isMobile } = usePlatform()

  // ---- 配置 ----
  const [form] = Form.useForm<ConfigFormValues>()
  const [config, setConfig] = useState<GatewayConfig>(DEFAULT_CONFIG)
  const [configured, setConfigured] = useState(false)
  const [savingConfig, setSavingConfig] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)

  // ---- 快照 ----
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [snapError, setSnapError] = useState<string | null>(null)
  const [loadingSnap, setLoadingSnap] = useState(false)

  // ---- 下单 ----
  const [side, setSide] = useState<TradeSide>('buy')
  const [orderType, setOrderType] = useState<OrderType>('limit')
  const [symbol, setSymbol] = useState('')
  const [price, setPrice] = useState<number | null>(null)
  const [volume, setVolume] = useState<number | null>(100)
  const [report, setReport] = useState<RiskReport | null>(null)
  const [checking, setChecking] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  // ---- 条件单 ----
  const [conditionals, setConditionals] = useState<ConditionalOrder[]>([])
  const [creating, setCreating] = useState(false)
  const [condSymbol, setCondSymbol] = useState('')
  const [condTrigger, setCondTrigger] = useState<TriggerType>('price_below')
  const [condThreshold, setCondThreshold] = useState<number | null>(null)
  const [condReference, setCondReference] = useState<number | null>(null)
  const [condSide, setCondSide] = useState<TradeSide>('sell')
  const [condVolume, setCondVolume] = useState<number | null>(100)
  const [condPrice, setCondPrice] = useState<number | null>(null)

  // ---- 委托与日志 ----
  const [opening, setOpening] = useState<OpenOrderInfo[]>([])
  const [orders, setOrders] = useState<OrderRecord[]>([])
  const [logFilter, setLogFilter] = useState('')

  const tauriReady = isTauri()
  // 用 ref 保存最新配置，供定时器读取，避免把整个页面的 effect 依赖链拖长
  const configRef = useRef(config)
  configRef.current = config

  // -------------------------------------------------------------------------
  // 数据加载
  // -------------------------------------------------------------------------

  const loadConfig = useCallback(async () => {
    if (!tauriReady) return
    try {
      const view = await getConfig()
      setConfig(view.config)
      setConfigured(view.configured)
      form.setFieldsValue(toForm(view.config))
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    }
  }, [form, tauriReady])

  const loadSnapshot = useCallback(async () => {
    if (!tauriReady) return
    setLoadingSnap(true)
    try {
      const data = await snapshot()
      setSnap(data)
      setSnapError(null)
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      setSnapError(e.message)
      setSnap(null)
    } finally {
      setLoadingSnap(false)
    }
  }, [tauriReady])

  const loadOrders = useCallback(async () => {
    try {
      setOrders(await listOrders({ symbol: logFilter || undefined, limit: 100 }))
    } catch (err) {
      // 账本读取失败不应打断交易主流程，仅提示
      console.warn('[trade] 读取本地委托失败', err)
    }
  }, [logFilter])

  const loadConditionals = useCallback(async () => {
    try {
      setConditionals(await listConditionals(false))
    } catch (err) {
      console.warn('[trade] 读取条件单失败', err)
    }
  }, [])

  useEffect(() => {
    if (!tauriReady) return
    void loadConfig()
    void loadOrders()
    void loadConditionals()
  }, [tauriReady, loadConfig, loadOrders, loadConditionals])

  useEffect(() => {
    if (!tauriReady || !configured) return
    void loadSnapshot()
    void openOrders().then(setOpening).catch(() => setOpening([]))
  }, [tauriReady, configured, loadSnapshot])

  // 条件单轮询：15 秒一轮。行情接口本身就是分钟级，再快没有意义且费流量。
  useEffect(() => {
    if (!tauriReady || !configured) return
    let alive = true

    const tick = async () => {
      try {
        const armed = await listConditionals(true)
        if (!alive || armed.length === 0) return

        const stats = await todayStats(todayKey())
        const payload: ConditionalInput[] = armed.map((c) => ({
          id: c.id,
          account: c.account,
          symbol: c.symbol,
          name: c.name,
          triggerType: c.triggerType,
          threshold: c.threshold,
          referencePrice: c.referencePrice,
          side: c.side,
          volume: c.volume,
          limitPrice: c.limitPrice,
          orderType: c.orderType,
          state: c.state,
          tradeDate: c.tradeDate,
          firedToday: c.firedToday,
          note: c.note,
        }))
        const results = await checkConditionals(payload, stats.count, stats.turnover)
        if (!alive) return

        let changed = false
        for (const r of results) {
          if (r.state === 'armed' && !r.triggered) continue
          changed = true
          await updateConditionalState(r.id, r.state, r.firedToday, r.message)
          if (r.triggered) {
            message.info(`条件单 ${r.symbol} 已触发：${r.message}`)
          }
          // 触发后产生了真实委托，补记本地账本，保证今日统计与风控额度准确
          if (r.clientOrderId) {
            await insertOrder({
              id: r.clientOrderId,
              gatewayOrderId: r.gatewayOrderId,
              account: configRef.current.account,
              symbol: r.symbol,
              name: '',
              side: payload.find((p) => p.id === r.id)?.side ?? 'sell',
              orderType: 'limit',
              price: r.risk?.amount && payload.find((p) => p.id === r.id)?.volume
                ? (r.risk?.amount ?? 0) / (payload.find((p) => p.id === r.id)?.volume || 1)
                : 0,
              volume: payload.find((p) => p.id === r.id)?.volume ?? 0,
              amount: r.risk?.amount ?? 0,
              status: r.state === 'filled' ? 'submitted' : 'rejected',
              source: 'conditional',
              conditionalId: r.id,
              message: r.message,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            })
          }
        }
        if (changed) {
          await loadConditionals()
          await loadOrders()
        }
      } catch (err) {
        // 轮询失败静默处理：网络抖动不应反复弹窗骚扰用户
        console.warn('[trade] 条件单评估失败', err)
      }
    }

    void tick()
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return
      void tick()
    }, 15_000)

    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [tauriReady, configured, loadConditionals, loadOrders])

  // -------------------------------------------------------------------------
  // 操作
  // -------------------------------------------------------------------------

  const handleSaveConfig = async () => {
    let values: ConfigFormValues
    try {
      values = await form.validateFields()
    } catch {
      return
    }
    setSavingConfig(true)
    try {
      const next = fromForm(values)
      const view = await saveConfig(next)
      setConfig(view.config)
      setConfigured(view.configured)
      message.success('配置已保存')
    } catch (err) {
      const e = err instanceof Error ? err.message : String(err)
      message.error(e)
    } finally {
      setSavingConfig(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await health()
      setTestResult({
        ok: res.ok,
        text: `${res.message}（${res.latencyMs} ms）${res.detail ? ` · ${res.detail}` : ''}`,
      })
    } catch (err) {
      setTestResult({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setTesting(false)
    }
  }

  /** 预检：把本地今日统计一并带上，让「每日笔数 / 成交额」判断准确 */
  const runPrecheck = useCallback(
    async (args?: { symbol?: string; side?: TradeSide; orderType?: OrderType; price?: number | null; volume?: number | null }) => {
      const s = (args?.symbol ?? symbol).trim()
      const v = args?.volume ?? volume ?? 0
      if (!s) {
        message.warning('请先填写标的代码')
        return null
      }
      if (!v || v <= 0) {
        message.warning('请填写有效数量')
        return null
      }
      setChecking(true)
      try {
        const stats = await todayStats(todayKey())
        const r = await precheck({
          symbol: s,
          side: args?.side ?? side,
          orderType: args?.orderType ?? orderType,
          price: args?.price === undefined ? price ?? undefined : args.price ?? undefined,
          volume: v,
          todayOrderCount: stats.count,
          todayTurnover: stats.turnover,
        })
        setReport(r)
        return r
      } catch (err) {
        setReport(null)
        message.error(err instanceof Error ? err.message : String(err))
        return null
      } finally {
        setChecking(false)
      }
    },
    [symbol, volume, side, orderType, price],
  )

  /** 提交下单：预检 → 落库 → 下单 → 回写状态 */
  const handleSubmitOrder = async () => {
    const s = symbol.trim()
    const v = volume ?? 0
    if (!s || v <= 0) {
      message.warning('请填写标的代码与数量')
      return
    }
    if (orderType === 'limit' && (!price || price <= 0)) {
      message.warning('限价单必须填写委托价')
      return
    }

    setSubmitting(true)
    const clientOrderId = newClientOrderId()
    try {
      const stats = await todayStats(todayKey())
      const amount = (orderType === 'limit' ? price ?? 0 : 0) * v

      // 先落库再下单：网络失败时也能看到「本地发起过这笔委托」，避免账实不符
      await insertOrder({
        id: clientOrderId,
        gatewayOrderId: '',
        account: config.account,
        symbol: s,
        name: '',
        side,
        orderType,
        price: orderType === 'limit' ? price ?? 0 : 0,
        volume: v,
        amount,
        status: 'pending',
        source: 'manual',
        conditionalId: null,
        message: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })

      const result = await placeOrder({
        symbol: s,
        side,
        orderType,
        price: orderType === 'limit' ? price ?? undefined : undefined,
        volume: v,
        clientOrderId,
        todayOrderCount: stats.count,
        todayTurnover: stats.turnover,
      })
      setReport(result.risk)

      if (result.accepted) {
        await updateOrderStatus(clientOrderId, 'submitted', {
          gatewayOrderId: result.gatewayOrderId,
          amount: result.risk.amount,
          price: orderType === 'limit' ? price ?? 0 : result.risk.amount / v,
          message: result.message,
        })
        message.success(result.message)
        void openOrders().then(setOpening).catch(() => undefined)
      } else {
        await updateOrderStatus(clientOrderId, 'rejected', { message: result.message })
        message.error(result.message)
      }
      await loadOrders()
    } catch (err) {
      const e = err instanceof Error ? err.message : String(err)
      await updateOrderStatus(clientOrderId, 'failed', { message: e }).catch(() => undefined)
      await loadOrders()
      message.error(e)
    } finally {
      setSubmitting(false)
    }
  }

  const handleCancel = async (orderId: string) => {
    try {
      const text = await cancelOrder(orderId)
      message.success(text)
      void openOrders().then(setOpening).catch(() => undefined)
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleCreateConditional = async () => {
    const s = condSymbol.trim()
    if (!s) {
      message.warning('请填写标的代码')
      return
    }
    if (!condVolume || condVolume <= 0) {
      message.warning('请填写有效数量')
      return
    }
    const meta = TRIGGER_META[condTrigger]
    if (meta.needsPrice && (!condThreshold || condThreshold <= 0)) {
      message.warning(condTrigger === 'time_reached' ? '请填写触发时刻' : '请填写触发阈值')
      return
    }
    if (meta.needsReference && (!condReference || condReference <= 0)) {
      message.warning('涨跌幅类条件单必须填写参考价')
      return
    }

    // 时间类阈值存「距零点分钟数」，用 时:分 输入换算
    const threshold = condTrigger === 'time_reached'
      ? (condThreshold ?? 0)
      : condTrigger === 'change_up' || condTrigger === 'change_down'
        ? (condThreshold ?? 0) / 100
        : condThreshold ?? 0

    const item: ConditionalInput = {
      id: newConditionalId(),
      account: config.account,
      symbol: s,
      name: '',
      triggerType: condTrigger,
      threshold,
      referencePrice: meta.needsReference ? condReference ?? 0 : 0,
      side: condSide,
      volume: condVolume,
      limitPrice: condPrice && condPrice > 0 ? condPrice : null,
      orderType: condPrice && condPrice > 0 ? 'limit' : 'market',
      state: 'armed',
      tradeDate: todayKey(),
      firedToday: false,
      note: '',
    }

    setCreating(true)
    try {
      await validateConditional(item)
      await insertConditional(item)
      message.success('条件单已创建，将在下一个轮询周期开始监控')
      setCondSymbol('')
      setCondThreshold(null)
      setCondReference(null)
      setCondPrice(null)
      await loadConditionals()
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  const handleCancelConditional = async (row: ConditionalOrder) => {
    try {
      await updateConditionalState(row.id, 'cancelled', row.firedToday, '用户手动撤销')
      await loadConditionals()
      message.success('已撤销')
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleDeleteConditional = async (row: ConditionalOrder) => {
    try {
      await deleteConditional(row.id)
      await loadConditionals()
      message.success('已删除')
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    }
  }

  // -------------------------------------------------------------------------
  // 表格列
  // -------------------------------------------------------------------------

  const positionColumns: ColumnsType<PositionInfo> = [
    {
      title: '代码',
      dataIndex: 'symbol',
      render: (v: string, row) => (
        <Space direction="vertical" size={0}>
          <span className="qb-mono">{v}</span>
          {row.name ? <Text type="secondary" style={{ fontSize: 12 }}>{row.name}</Text> : null}
        </Space>
      ),
    },
    {
      title: '持仓 / 可用',
      align: 'right' as const,
      render: (_: unknown, row) => `${row.volume} / ${row.availableVolume}`,
    },
    {
      title: '成本',
      dataIndex: 'costPrice',
      align: 'right' as const,
      render: (v: number) => formatPrice(v, 3),
    },
    {
      title: '现价',
      dataIndex: 'lastPrice',
      align: 'right' as const,
      render: (v: number) => formatPrice(v, 3),
    },
    {
      title: '市值',
      align: 'right' as const,
      render: (_: unknown, row) => formatAmount(row.marketValue || row.lastPrice * row.volume),
    },
  ]

  const openColumns: ColumnsType<OpenOrderInfo> = [
    { title: '委托号', dataIndex: 'orderId', render: (v: string) => <span className="qb-mono">{v}</span> },
    { title: '代码', dataIndex: 'symbol', render: (v: string) => <span className="qb-mono">{v}</span> },
    {
      title: '方向',
      dataIndex: 'side',
      render: (v: string) => (
        <Tag color={v.toLowerCase() === 'buy' ? 'red' : 'green'}>
          {v.toLowerCase() === 'buy' ? '买入' : '卖出'}
        </Tag>
      ),
    },
    { title: '价格', dataIndex: 'price', align: 'right' as const, render: (v: number) => formatPrice(v, 3) },
    { title: '数量', dataIndex: 'volume', align: 'right' as const },
    { title: '状态', dataIndex: 'status' },
    {
      title: '操作',
      align: 'right' as const,
      render: (_: unknown, row) => (
        <Popconfirm title={`确认撤销委托 ${row.orderId}？`} onConfirm={() => handleCancel(row.orderId)}>
          <Button size="small" danger type="link">
            撤单
          </Button>
        </Popconfirm>
      ),
    },
  ]

  const conditionalColumns: ColumnsType<ConditionalOrder> = [
    { title: '代码', dataIndex: 'symbol', render: (v: string) => <span className="qb-mono">{v}</span> },
    {
      title: '触发条件',
      render: (_: unknown, row) => {
        const meta = TRIGGER_META[row.triggerType]
        const value =
          row.triggerType === 'time_reached'
            ? `${String(Math.floor(row.threshold / 60)).padStart(2, '0')}:${String(row.threshold % 60).padStart(2, '0')}`
            : row.triggerType === 'change_up' || row.triggerType === 'change_down'
              ? `${(row.threshold * 100).toFixed(2)}%`
              : formatPrice(row.threshold, 3)
        return (
          <Space direction="vertical" size={0}>
            <span>
              {meta.label} <Text strong>{value}</Text>
            </span>
            {(row.triggerType === 'change_up' || row.triggerType === 'change_down') && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                参考价 {formatPrice(row.referencePrice, 3)}
              </Text>
            )}
          </Space>
        )
      },
    },
    {
      title: '方向 / 数量',
      render: (_: unknown, row) => (
        <Space size={4}>
          <Tag color={row.side === 'buy' ? 'red' : 'green'}>{row.side === 'buy' ? '买' : '卖'}</Tag>
          <span>{row.volume}</span>
        </Space>
      ),
    },
    {
      title: '委托价',
      render: (_: unknown, row) => (row.limitPrice ? formatPrice(row.limitPrice, 3) : '市价'),
    },
    {
      title: '状态',
      dataIndex: 'state',
      render: (v: ConditionalState) => <Tag color={STATE_COLOR[v]}>{CONDITIONAL_STATE_TEXT[v]}</Tag>,
    },
    { title: '作用日', dataIndex: 'tradeDate' },
    {
      title: '备注',
      dataIndex: 'note',
      render: (v: string) => (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {v || '—'}
        </Text>
      ),
    },
    {
      title: '操作',
      align: 'right' as const,
      render: (_: unknown, row) =>
        row.state === 'armed' ? (
          <Popconfirm title="撤销后该规则不再监控，确认？" onConfirm={() => handleCancelConditional(row)}>
            <Button size="small" type="link" danger>
              撤销
            </Button>
          </Popconfirm>
        ) : (
          <Popconfirm title="删除这条记录？" onConfirm={() => handleDeleteConditional(row)}>
            <Button size="small" type="link" icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        ),
    },
  ]

  const orderColumns: ColumnsType<OrderRecord> = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      render: (v: string) => <span className="qb-mono">{v.replace('T', ' ').slice(0, 19)}</span>,
    },
    { title: '代码', dataIndex: 'symbol', render: (v: string) => <span className="qb-mono">{v}</span> },
    {
      title: '方向',
      dataIndex: 'side',
      render: (v: TradeSide) => <Tag color={v === 'buy' ? 'red' : 'green'}>{v === 'buy' ? '买入' : '卖出'}</Tag>,
    },
    { title: '价格', dataIndex: 'price', align: 'right' as const, render: (v: number) => formatPrice(v, 3) },
    { title: '数量', dataIndex: 'volume', align: 'right' as const },
    { title: '金额', dataIndex: 'amount', align: 'right' as const, render: (v: number) => formatAmount(v) },
    {
      title: '状态',
      dataIndex: 'status',
      render: (v: string) => <Tag color={ORDER_STATUS_COLOR[v] ?? 'default'}>{ORDER_STATUS_TEXT[v] ?? v}</Tag>,
    },
    {
      title: '来源 / 说明',
      render: (_: unknown, row) => (
        <Space direction="vertical" size={0}>
          <Tag>{row.source === 'conditional' ? '条件单' : row.source === 'strategy' ? '策略' : '手动'}</Tag>
          {row.message ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {row.message}
            </Text>
          ) : null}
        </Space>
      ),
    },
  ]

  // -------------------------------------------------------------------------
  // 派生数据
  // -------------------------------------------------------------------------

  const tone = reportTone(report)
  const armedCount = useMemo(
    () => conditionals.filter((c) => c.state === 'armed').length,
    [conditionals],
  )

  const envAlert = !tauriReady ? (
    <Alert
      type="warning"
      showIcon
      message="浏览器预览环境不支持交易"
      description="交易需要 Tauri 运行时：配置存储、风控校验与网关访问都在 Rust 侧完成。请用 npm run app:dev 启动桌面端。"
    />
  ) : null

  return (
    <div style={{ padding: isMobile ? 12 : 20 }}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>
            交易中心
          </Title>
          <Paragraph type="secondary" style={{ margin: '4px 0 0', fontSize: 13 }}>
            所有委托在发往网关前都会经过本地风控校验；风控规则不可被单笔委托绕过。
          </Paragraph>
        </div>

        {envAlert}

        {/* ---------------- 1. 网关与风控配置 ---------------- */}
        <Card
          size="small"
          title={
            <Space>
              <ApiOutlined />
              <span>交易网关与风控规则</span>
              {configured ? <Tag color="success">已配置</Tag> : <Tag color="warning">未配置</Tag>}
            </Space>
          }
          extra={
            <Space>
              <Button size="small" icon={<ThunderboltOutlined />} loading={testing} onClick={handleTest} disabled={!tauriReady}>
                测试连接
              </Button>
              <Button size="small" type="primary" loading={savingConfig} onClick={handleSaveConfig} disabled={!tauriReady}>
                保存
              </Button>
            </Space>
          }
        >
          {testResult ? (
            <Alert
              style={{ marginBottom: 12 }}
              type={testResult.ok ? 'success' : 'error'}
              showIcon
              icon={testResult.ok ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
              message={testResult.text}
            />
          ) : null}

          <Form form={form} layout="vertical" initialValues={toForm(DEFAULT_CONFIG)} disabled={!tauriReady}>
            <Row gutter={12}>
              <Col xs={24} md={10}>
                <Form.Item
                  name="baseUrl"
                  label="网关地址"
                  rules={[{ required: true, message: '请填写网关地址' }]}
                  tooltip="自建交易网关的 HTTP 根地址，例如 http://127.0.0.1:8001"
                >
                  <Input placeholder="http://127.0.0.1:8001" allowClear />
                </Form.Item>
              </Col>
              <Col xs={24} md={7}>
                <Form.Item name="apiKey" label="API Key" tooltip="放在 X-API-Key 请求头，网关侧自行校验">
                  <Input.Password placeholder="可选" allowClear />
                </Form.Item>
              </Col>
              <Col xs={12} md={4}>
                <Form.Item name="account" label="资金账号">
                  <Input placeholder="default" />
                </Form.Item>
              </Col>
              <Col xs={12} md={3}>
                <Form.Item name="timeoutMs" label="超时(ms)">
                  <InputNumber min={500} max={60000} step={500} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            </Row>

            <Collapse
              size="small"
              items={[
                {
                  key: 'risk',
                  label: (
                    <Space>
                      <WarningOutlined />
                      <span>风控规则</span>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        单标的 {Number((config.risk.maxPositionPct * 100).toFixed(0))}% · 单笔上限{' '}
                        {formatAmount(config.risk.maxSingleOrderAmount)} · 回撤熔断{' '}
                        {Number((config.risk.maxDrawdownPct * 100).toFixed(0))}%
                      </Text>
                    </Space>
                  ),
                  children: (
                    <>
                      <Row gutter={12}>
                        <Col xs={12} md={4}>
                          <Form.Item name="maxPositionPctPct" label="单标的仓位上限(%)">
                            <InputNumber min={0} max={100} step={1} style={{ width: '100%' }} />
                          </Form.Item>
                        </Col>
                        <Col xs={12} md={4}>
                          <Form.Item name="maxDrawdownPctPct" label="回撤熔断(%)">
                            <InputNumber min={0} max={100} step={1} style={{ width: '100%' }} />
                          </Form.Item>
                        </Col>
                        <Col xs={12} md={4}>
                          <Form.Item name="maxSingleOrderAmount" label="单笔上限(元)">
                            <InputNumber min={0} step={1000} style={{ width: '100%' }} />
                          </Form.Item>
                        </Col>
                        <Col xs={12} md={4}>
                          <Form.Item name="minSingleOrderAmount" label="单笔下限(元)">
                            <InputNumber min={0} step={100} style={{ width: '100%' }} />
                          </Form.Item>
                        </Col>
                        <Col xs={12} md={4}>
                          <Form.Item name="maxDailyOrders" label="每日笔数上限">
                            <InputNumber min={0} step={1} style={{ width: '100%' }} />
                          </Form.Item>
                        </Col>
                        <Col xs={12} md={4}>
                          <Form.Item name="maxDailyTurnover" label="每日成交额上限(元)">
                            <InputNumber min={0} step={10000} style={{ width: '100%' }} />
                          </Form.Item>
                        </Col>
                      </Row>
                      <Row gutter={12}>
                        <Col xs={24} md={8}>
                          <Form.Item name="sessionsText" label="交易时段" tooltip="多个时段用逗号分隔，格式 HH:MM-HH:MM">
                            <Input placeholder="09:30-11:30, 13:00-15:00" />
                          </Form.Item>
                        </Col>
                        <Col xs={24} md={8}>
                          <Form.Item name="blacklistText" label="黑名单标的" tooltip="逗号分隔，禁止买卖">
                            <Input placeholder="例如 000001, 600519" />
                          </Form.Item>
                        </Col>
                        <Col xs={8} md={3}>
                          <Form.Item name="lotSize" label="整手股数">
                            <InputNumber min={1} step={100} style={{ width: '100%' }} />
                          </Form.Item>
                        </Col>
                        <Col xs={8} md={2}>
                          <Form.Item name="enforceSession" label="校验时段">
                            <Select
                              options={[
                                { value: true, label: '是' },
                                { value: false, label: '否' },
                              ]}
                            />
                          </Form.Item>
                        </Col>
                        <Col xs={8} md={3}>
                          <Form.Item name="allowSellWhenHalted" label="熔断可卖">
                            <Select
                              options={[
                                { value: true, label: '是' },
                                { value: false, label: '否' },
                              ]}
                            />
                          </Form.Item>
                        </Col>
                      </Row>
                    </>
                  ),
                },
              ]}
            />
          </Form>
        </Card>

        {/* ---------------- 2. 账户与持仓 ---------------- */}
        <Card
          size="small"
          title="账户与持仓"
          extra={
            <Space>
              {snap ? (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {snap.clock.tradeDate} {snap.clock.hhmm}
                </Text>
              ) : null}
              <Button
                size="small"
                icon={<ReloadOutlined />}
                loading={loadingSnap}
                onClick={() => void loadSnapshot()}
                disabled={!tauriReady || !configured}
              >
                刷新
              </Button>
            </Space>
          }
        >
          {snapError ? (
            <Alert type="error" showIcon message="无法获取账户快照" description={snapError} />
          ) : snap ? (
            <>
              <Row gutter={[12, 12]}>
                <Col xs={12} md={6}>
                  <Statistic title="总净值" value={snap.totalEquity} precision={2} />
                </Col>
                <Col xs={12} md={6}>
                  <Statistic title="可用资金" value={snap.availableCash} precision={2} />
                </Col>
                <Col xs={12} md={6}>
                  <Statistic
                    title="持仓市值"
                    value={snap.marketValue}
                    precision={2}
                    valueStyle={{ color: 'var(--qb-text)' }}
                  />
                </Col>
                <Col xs={12} md={6}>
                  <Statistic
                    title="净值回撤"
                    value={snap.drawdown * 100}
                    precision={2}
                    suffix="%"
                    valueStyle={{ color: snap.drawdown >= config.risk.maxDrawdownPct ? 'var(--qb-up)' : undefined }}
                  />
                </Col>
              </Row>
              <Divider style={{ margin: '12px 0' }} />
              <Descriptions size="small" column={isMobile ? 1 : 3}>
                <Descriptions.Item label="资金账号">{snap.account}</Descriptions.Item>
                <Descriptions.Item label="历史净值峰值">{formatAmount(snap.peakEquity)}</Descriptions.Item>
                <Descriptions.Item label="单标的可买额度">{formatAmount(snap.positionCap)}</Descriptions.Item>
              </Descriptions>
              <Table
                size="small"
                rowKey="symbol"
                style={{ marginTop: 12 }}
                columns={positionColumns}
                dataSource={snap.positions}
                pagination={false}
                scroll={{ x: 560 }}
                locale={{ emptyText: <Empty description="暂无持仓" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
              />
            </>
          ) : (
            <Empty
              description={configured ? '点击刷新获取账户数据' : '请先配置交易网关'}
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
          )}
        </Card>

        {/* ---------------- 3. 下单 ---------------- */}
        <Card size="small" title="委托下单">
          <Row gutter={12}>
            <Col xs={24} md={3}>
              <div style={{ marginBottom: 4, fontSize: 13, color: 'var(--qb-text-secondary)' }}>方向</div>
              <Segmented
                block
                value={side}
                onChange={(v) => {
                  setSide(v as TradeSide)
                  setReport(null)
                }}
                options={[
                  { label: '买入', value: 'buy' },
                  { label: '卖出', value: 'sell' },
                ]}
              />
            </Col>
            <Col xs={24} md={3}>
              <div style={{ marginBottom: 4, fontSize: 13, color: 'var(--qb-text-secondary)' }}>类型</div>
              <Segmented
                block
                value={orderType}
                onChange={(v) => {
                  setOrderType(v as OrderType)
                  setReport(null)
                }}
                options={[
                  { label: '限价', value: 'limit' },
                  { label: '市价', value: 'market' },
                ]}
              />
            </Col>
            <Col xs={12} md={5}>
              <div style={{ marginBottom: 4, fontSize: 13, color: 'var(--qb-text-secondary)' }}>代码</div>
              <Input
                placeholder="600519"
                value={symbol}
                onChange={(e) => {
                  setSymbol(e.target.value)
                  setReport(null)
                }}
              />
            </Col>
            <Col xs={12} md={4}>
              <div style={{ marginBottom: 4, fontSize: 13, color: 'var(--qb-text-secondary)' }}>
                价格{orderType === 'market' ? '（市价自动取最新价）' : ''}
              </div>
              <InputNumber
                style={{ width: '100%' }}
                min={0}
                step={0.01}
                value={price}
                disabled={orderType === 'market'}
                onChange={(v) => {
                  setPrice(v)
                  setReport(null)
                }}
              />
            </Col>
            <Col xs={12} md={4}>
              <div style={{ marginBottom: 4, fontSize: 13, color: 'var(--qb-text-secondary)' }}>数量（股）</div>
              <InputNumber
                style={{ width: '100%' }}
                min={0}
                step={config.risk.lotSize || 100}
                value={volume}
                onChange={(v) => {
                  setVolume(v)
                  setReport(null)
                }}
              />
            </Col>
            <Col xs={12} md={5}>
              <div style={{ marginBottom: 4, fontSize: 13, color: 'var(--qb-text-secondary)' }}>操作</div>
              <Space>
                <Button loading={checking} onClick={() => void runPrecheck()} disabled={!configured}>
                  风控预检
                </Button>
                <Popconfirm
                  title={`确认${side === 'buy' ? '买入' : '卖出'} ${symbol || '—'} ${volume ?? 0} 股？`}
                  description="提交后将经过风控校验并发送至交易网关"
                  onConfirm={handleSubmitOrder}
                  okText="确认下单"
                  cancelText="取消"
                >
                  <Button
                    type="primary"
                    danger={side === 'sell'}
                    loading={submitting}
                    disabled={!configured}
                    icon={<ThunderboltOutlined />}
                  >
                    提交委托
                  </Button>
                </Popconfirm>
              </Space>
            </Col>
          </Row>

          {report ? (
            <Alert
              style={{ marginTop: 12 }}
              type={tone === 'error' ? 'error' : tone === 'warn' ? 'warning' : 'success'}
              showIcon
              icon={
                tone === 'error' ? <CloseCircleOutlined /> : tone === 'warn' ? <WarningOutlined /> : <CheckCircleOutlined />
              }
              message={
                <Space wrap>
                  <span>{report.reason}</span>
                  {report.code ? <Tag color="error">{REJECT_TEXT[report.code] ?? report.code}</Tag> : null}
                </Space>
              }
              description={
                <Space direction="vertical" size={2} style={{ fontSize: 12 }}>
                  <span>
                    委托金额 {formatAmount(report.amount)} · 净值 {formatAmount(report.totalEquity)} · 可用{' '}
                    {formatAmount(report.availableCash)}
                  </span>
                  <span>
                    该标的当前市值 {formatAmount(report.positionValue)} / 额度 {formatAmount(report.positionCap)} · 回撤{' '}
                    {(report.drawdown * 100).toFixed(2)}%
                  </span>
                  <span>
                    今日已下单 {report.todayOrderCount} 笔 · 成交额 {formatAmount(report.todayTurnover)} ·{' '}
                    {report.tradeDate} {String(Math.floor(report.minute / 60)).padStart(2, '0')}:
                    {String(report.minute % 60).padStart(2, '0')}
                  </span>
                  {report.warnings.map((w) => (
                    <Text key={w} type="warning" style={{ fontSize: 12 }}>
                      提示：{w}
                    </Text>
                  ))}
                </Space>
              }
            />
          ) : null}

          <Divider style={{ margin: '16px 0 12px' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              当前未成交委托
            </Text>
          </Divider>
          <Table
            size="small"
            rowKey={(r) => `${r.orderId}-${r.symbol}-${r.price}`}
            columns={openColumns}
            dataSource={opening}
            pagination={false}
            scroll={{ x: 640 }}
            locale={{ emptyText: <Empty description="无未成交委托" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          />
        </Card>

        {/* ---------------- 4. 条件单 ---------------- */}
        <Card
          size="small"
          title={
            <Space>
              <span>条件单</span>
              <Badge count={armedCount} showZero color="#1677ff" />
            </Space>
          }
          extra={
            <Text type="secondary" style={{ fontSize: 12 }}>
              每 15 秒评估一次
            </Text>
          }
        >
          <Row gutter={12} align="bottom">
            <Col xs={12} md={3}>
              <div style={{ marginBottom: 4, fontSize: 13, color: 'var(--qb-text-secondary)' }}>代码</div>
              <Input placeholder="600519" value={condSymbol} onChange={(e) => setCondSymbol(e.target.value)} />
            </Col>
            <Col xs={12} md={4}>
              <div style={{ marginBottom: 4, fontSize: 13, color: 'var(--qb-text-secondary)' }}>触发条件</div>
              <Select
                style={{ width: '100%' }}
                value={condTrigger}
                onChange={(v) => setCondTrigger(v as TriggerType)}
                options={(Object.keys(TRIGGER_META) as TriggerType[]).map((k) => ({
                  value: k,
                  label: TRIGGER_META[k].label,
                }))}
              />
            </Col>
            <Col xs={12} md={3}>
              <div style={{ marginBottom: 4, fontSize: 13, color: 'var(--qb-text-secondary)' }}>
                {TRIGGER_META[condTrigger].needsPrice
                  ? condTrigger === 'change_up' || condTrigger === 'change_down'
                    ? '阈值(%)'
                    : '阈值(元)'
                  : '时刻(时:分)'}
              </div>
              <InputNumber
                style={{ width: '100%' }}
                min={0}
                step={condTrigger === 'time_reached' ? 30 : 0.01}
                value={condThreshold}
                onChange={(v) => setCondThreshold(v)}
                placeholder={condTrigger === 'time_reached' ? '870 = 14:30' : ''}
              />
            </Col>
            <Col xs={12} md={3}>
              <div style={{ marginBottom: 4, fontSize: 13, color: 'var(--qb-text-secondary)' }}>
                参考价{TRIGGER_META[condTrigger].needsReference ? '' : '（不需要）'}
              </div>
              <InputNumber
                style={{ width: '100%' }}
                min={0}
                step={0.01}
                value={condReference}
                disabled={!TRIGGER_META[condTrigger].needsReference}
                onChange={(v) => setCondReference(v)}
              />
            </Col>
            <Col xs={12} md={3}>
              <div style={{ marginBottom: 4, fontSize: 13, color: 'var(--qb-text-secondary)' }}>方向</div>
              <Segmented
                block
                value={condSide}
                onChange={(v) => setCondSide(v as TradeSide)}
                options={[
                  { label: '买', value: 'buy' },
                  { label: '卖', value: 'sell' },
                ]}
              />
            </Col>
            <Col xs={12} md={2}>
              <div style={{ marginBottom: 4, fontSize: 13, color: 'var(--qb-text-secondary)' }}>数量</div>
              <InputNumber style={{ width: '100%' }} min={0} step={100} value={condVolume} onChange={(v) => setCondVolume(v)} />
            </Col>
            <Col xs={12} md={3}>
              <div style={{ marginBottom: 4, fontSize: 13, color: 'var(--qb-text-secondary)' }}>委托价（空=市价）</div>
              <InputNumber style={{ width: '100%' }} min={0} step={0.01} value={condPrice} onChange={(v) => setCondPrice(v)} />
            </Col>
            <Col xs={24} md={3}>
              <Button type="dashed" block icon={<PlusOutlined />} loading={creating} onClick={handleCreateConditional}>
                创建
              </Button>
            </Col>
          </Row>
          <Paragraph type="secondary" style={{ fontSize: 12, margin: '8px 0 0' }}>
            {TRIGGER_META[condTrigger].hint}。条件单仅当日有效，跨日自动失效，需重新创建。
          </Paragraph>

          <Table
            size="small"
            rowKey="id"
            style={{ marginTop: 12 }}
            columns={conditionalColumns}
            dataSource={conditionals}
            pagination={{ pageSize: 8, hideOnSinglePage: true }}
            scroll={{ x: 900 }}
            locale={{ emptyText: <Empty description="暂无条件单" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          />
        </Card>

        {/* ---------------- 5. 交易日志 ---------------- */}
        <Card
          size="small"
          title="交易日志"
          extra={
            <Space>
              <Input
                size="small"
                placeholder="按代码过滤"
                allowClear
                value={logFilter}
                onChange={(e) => setLogFilter(e.target.value)}
                style={{ width: 140 }}
              />
              <Button size="small" icon={<ReloadOutlined />} onClick={() => void loadOrders()}>
                刷新
              </Button>
            </Space>
          }
        >
          <Table
            size="small"
            rowKey="id"
            columns={orderColumns}
            dataSource={orders}
            pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }}
            scroll={{ x: 900 }}
            locale={{ emptyText: <Empty description="暂无交易记录" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          />
        </Card>
      </Space>
    </div>
  )
}
