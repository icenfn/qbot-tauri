import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  AutoComplete,
  Button,
  Card,
  Col,
  Collapse,
  Divider,
  Empty,
  InputNumber,
  Row,
  Segmented,
  Select,
  Slider,
  Space,
  Spin,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'

import EquityChart from '@/components/EquityChart'
import { api } from '@/lib/api/endpoints'
import type { KlineBar, SearchResult } from '@/lib/api/types'
import { formatAmount, formatPrice } from '@/lib/format'
import { TauriUnavailableError } from '@/lib/tauri/invoke'
import {
  linspace,
  listStrategies,
  optimizeParams,
  runBacktest,
} from '@/lib/quant/api'
import type {
  BacktestResult,
  BacktestTrade,
  ClosedTrade,
  OptimizeObjective,
  OptimizeReport,
  ParamValues,
  StrategyMeta,
} from '@/lib/quant/types'
import { usePlatform } from '@/hooks/usePlatform'

const { Paragraph, Text, Title } = Typography

/** 回测区间预设 */
const RANGE_PRESETS: { label: string; years: number }[] = [
  { label: '近 1 年', years: 1 },
  { label: '近 2 年', years: 2 },
  { label: '近 3 年', years: 3 },
  { label: '近 5 年', years: 5 },
]

const DEFAULT_CONFIG = {
  initialCash: 100_000,
  commissionRate: 0.0003,
  minCommission: 5,
  stampDutyRate: 0.0005,
  transferFeeRate: 0.00001,
  slippageRate: 0.0005,
  stopLoss: 0,
  takeProfit: 0,
  maxPositionPct: 1,
  allowT0: false,
}

/** 百分比 <-> 小数 转换（表单里给用户看 %，传给 Rust 的是小数） */
function pctToRate(pct: number): number {
  return Number.isFinite(pct) ? pct / 100 : 0
}
function rateToPct(rate: number): number {
  return Number.isFinite(rate) ? Number((rate * 100).toFixed(4)) : 0
}

export default function BacktestPage() {
  const { isMobile } = usePlatform()

  // ---- 策略与参数 ----
  const [strategies, setStrategies] = useState<StrategyMeta[]>([])
  const [strategyId, setStrategyId] = useState<string>('')
  const [params, setParams] = useState<ParamValues>({})
  const [registryError, setRegistryError] = useState<string | null>(null)
  const [loadingRegistry, setLoadingRegistry] = useState(true)

  // ---- 标的与区间 ----
  const [symbol, setSymbol] = useState('600519')
  const [searchText, setSearchText] = useState('')
  const [searchOptions, setSearchOptions] = useState<{ value: string; label: string }[]>([])
  const [rangeYears, setRangeYears] = useState<number>(3)

  // ---- 资金与费用 ----
  const [initialCash, setInitialCash] = useState(DEFAULT_CONFIG.initialCash)
  const [commissionPct, setCommissionPct] = useState(rateToPct(DEFAULT_CONFIG.commissionRate))
  const [stampDutyPct, setStampDutyPct] = useState(rateToPct(DEFAULT_CONFIG.stampDutyRate))
  const [slippagePct, setSlippagePct] = useState(rateToPct(DEFAULT_CONFIG.slippageRate))
  const [stopLossPct, setStopLossPct] = useState(0)
  const [takeProfitPct, setTakeProfitPct] = useState(0)
  const [maxPositionPct, setMaxPositionPct] = useState(100)

  // ---- 运行状态 ----
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<BacktestResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [barCount, setBarCount] = useState<number | null>(null)

  // ---- 参数优化 ----
  const [optimizing, setOptimizing] = useState(false)
  const [objective, setObjective] = useState<OptimizeObjective>('sharpe')
  const [optReport, setOptReport] = useState<OptimizeReport | null>(null)
  const [optError, setOptError] = useState<string | null>(null)

  const currentStrategy = useMemo(
    () => strategies.find((s) => s.id === strategyId) ?? null,
    [strategies, strategyId],
  )

  // 加载策略注册表（来自 Rust，避免前后端各维护一份参数定义）
  useEffect(() => {
    let cancelled = false
    setLoadingRegistry(true)
    listStrategies()
      .then((list) => {
        if (cancelled) return
        setStrategies(list)
        setRegistryError(null)
        if (list.length > 0) {
          setStrategyId(list[0].id)
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setRegistryError(
          e instanceof TauriUnavailableError
            ? '策略引擎需要在桌面/移动端应用中运行（当前为浏览器预览）'
            : e instanceof Error
              ? e.message
              : String(e),
        )
      })
      .finally(() => {
        if (!cancelled) setLoadingRegistry(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 切换策略时，用该策略的默认值初始化参数
  useEffect(() => {
    if (!currentStrategy) return
    const next: ParamValues = {}
    for (const p of currentStrategy.params) {
      next[p.key] = p.defaultValue
    }
    setParams(next)
    setOptReport(null)
  }, [currentStrategy])

  // 标的搜索补全
  useEffect(() => {
    const keyword = searchText.trim()
    if (keyword.length < 1) {
      setSearchOptions([])
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      api
        .search(keyword)
        .then((rows: SearchResult[]) => {
          if (cancelled) return
          setSearchOptions(
            rows
              .filter((r) => r.kind === 'stock')
              .map((r) => ({ value: r.symbol, label: `${r.symbol} ${r.name}` })),
          )
        })
        .catch(() => {
          if (!cancelled) setSearchOptions([])
        })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [searchText])

  const buildConfig = useCallback(
    () => ({
      initialCash,
      commissionRate: pctToRate(commissionPct),
      stampDutyRate: pctToRate(stampDutyPct),
      slippageRate: pctToRate(slippagePct),
      stopLoss: stopLossPct > 0 ? pctToRate(stopLossPct) : 0,
      takeProfit: takeProfitPct > 0 ? pctToRate(takeProfitPct) : 0,
      maxPositionPct: Math.min(1, Math.max(0.01, maxPositionPct / 100)),
    }),
    [initialCash, commissionPct, stampDutyPct, slippagePct, stopLossPct, takeProfitPct, maxPositionPct],
  )

  /** 拉取 K 线（后复权，保证跨除权日收益连续） */
  const fetchBars = useCallback(async (): Promise<KlineBar[]> => {
    const start = dayjs().subtract(rangeYears, 'year').format('YYYY-MM-DD')
    const end = dayjs().format('YYYY-MM-DD')
    const resp = await api.kline({ symbol, period: 'daily', adjust: 'hfq', start, end })
    return resp.bars
  }, [symbol, rangeYears])

  const handleRun = useCallback(async () => {
    if (!strategyId) {
      message.warning('请先选择策略')
      return
    }
    if (!symbol.trim()) {
      message.warning('请填写标的代码')
      return
    }
    setRunning(true)
    setError(null)
    try {
      const bars = await fetchBars()
      if (bars.length < 30) {
        setError(`数据量不足（仅 ${bars.length} 根），无法回测，请缩短区间或更换标的`)
        setResult(null)
        return
      }
      setBarCount(bars.length)
      const res = await runBacktest({
        symbol: symbol.trim(),
        strategyId,
        bars,
        params,
        config: buildConfig(),
      })
      setResult(res)
      message.success(
        `回测完成：${res.bars} 根 K 线，${res.trades.length} 笔成交`,
      )
    } catch (e: unknown) {
      const msg =
        e instanceof TauriUnavailableError
          ? '回测引擎需要桌面/移动端运行时，浏览器预览环境不可用'
          : e instanceof Error
            ? e.message
            : String(e)
      setError(msg)
      setResult(null)
    } finally {
      setRunning(false)
    }
  }, [strategyId, symbol, params, fetchBars, buildConfig])

  const handleOptimize = useCallback(async () => {
    if (!currentStrategy) return
    // 每个参数取默认值上下浮动，生成 3 档候选；命中上限时 Rust 会返回明确错误
    const grid = currentStrategy.params
      .map((p) => {
        const min = p.min ?? p.defaultValue * 0.5
        const max = p.max ?? p.defaultValue * 1.5
        const lo = Math.max(min, p.defaultValue * 0.5)
        const hi = Math.min(max, p.defaultValue * 2)
        const kind = p.kind
        const values =
          kind === 'int'
            ? linspace(Math.round(lo), Math.round(hi), 3, true)
            : linspace(lo, hi, 3, false)
        return { key: p.key, values: values.length > 0 ? values : [p.defaultValue] }
      })
      .filter((g) => g.values.length > 0)

    if (grid.length === 0) {
      message.warning('当前策略没有可优化的参数')
      return
    }

    setOptimizing(true)
    setOptError(null)
    try {
      const bars = await fetchBars()
      const report = await optimizeParams({
        strategyId: currentStrategy.id,
        bars,
        baseParams: params,
        grid,
        config: buildConfig(),
        objective,
        keep: 10,
      })
      setOptReport(report)
      message.success(`已完成 ${report.evaluated} 组参数评估`)
    } catch (e: unknown) {
      setOptError(e instanceof Error ? e.message : String(e))
      setOptReport(null)
    } finally {
      setOptimizing(false)
    }
  }, [currentStrategy, params, fetchBars, buildConfig, objective])

  // ---------------- 渲染辅助 ----------------

  const pct = (v: number, digits = 2) => `${(v * 100).toFixed(digits)}%`
  const negativeColor = '#e5484d'
  const positiveColor = '#1f9d55'

  const tradeColumns: ColumnsType<BacktestTrade> = [
    { title: '日期', dataIndex: 'date', width: 100, fixed: 'left' },
    {
      title: '方向',
      dataIndex: 'side',
      width: 70,
      render: (side: string) =>
        side === 'buy' ? <Tag color="red">买入</Tag> : <Tag color="green">卖出</Tag>,
    },
    {
      title: '成交价',
      dataIndex: 'price',
      width: 90,
      align: 'right',
      render: (v: number) => formatPrice(v),
    },
    {
      title: '数量',
      dataIndex: 'shares',
      width: 90,
      align: 'right',
      render: (v: number) => v.toFixed(0),
    },
    {
      title: '成交额',
      dataIndex: 'amount',
      width: 110,
      align: 'right',
      render: (v: number) => formatAmount(v),
    },
    {
      title: '费用',
      dataIndex: 'fee',
      width: 80,
      align: 'right',
      render: (v: number) => v.toFixed(2),
    },
    {
      title: '实现盈亏',
      dataIndex: 'realizedPnl',
      width: 110,
      align: 'right',
      render: (v: number | null) =>
        v == null ? (
          <Text type="secondary">—</Text>
        ) : (
          <span style={{ color: v >= 0 ? positiveColor : negativeColor }}>
            {v >= 0 ? '+' : ''}
            {v.toFixed(2)}
          </span>
        ),
    },
    { title: '触发原因', dataIndex: 'reason', ellipsis: true },
  ]

  const closedColumns: ColumnsType<ClosedTrade> = [
    { title: '买入日', dataIndex: 'entryDate', width: 100 },
    { title: '卖出日', dataIndex: 'exitDate', width: 100 },
    {
      title: '买入价',
      dataIndex: 'entryPrice',
      width: 90,
      align: 'right',
      render: (v: number) => formatPrice(v),
    },
    {
      title: '卖出价',
      dataIndex: 'exitPrice',
      width: 90,
      align: 'right',
      render: (v: number) => formatPrice(v),
    },
    {
      title: '数量',
      dataIndex: 'shares',
      width: 90,
      align: 'right',
      render: (v: number) => v.toFixed(0),
    },
    {
      title: '净盈亏',
      dataIndex: 'pnl',
      width: 110,
      align: 'right',
      render: (v: number) => (
        <span style={{ color: v >= 0 ? positiveColor : negativeColor }}>
          {v >= 0 ? '+' : ''}
          {v.toFixed(2)}
        </span>
      ),
    },
    {
      title: '收益率',
      dataIndex: 'returnPct',
      width: 100,
      align: 'right',
      render: (v: number) => (
        <span style={{ color: v >= 0 ? positiveColor : negativeColor }}>{pct(v)}</span>
      ),
    },
    {
      title: '持仓天数',
      dataIndex: 'holdingDays',
      width: 90,
      align: 'right',
    },
  ]

  const optimizerColumns: ColumnsType<OptimizeReport['candidates'][number]> = [
    {
      title: '参数',
      dataIndex: 'params',
      render: (p: ParamValues) =>
        Object.entries(p)
          .map(([k, v]) => `${k}=${Number.isInteger(v) ? v : v.toFixed(3)}`)
          .join('  '),
    },
    {
      title: '得分',
      dataIndex: 'score',
      width: 90,
      align: 'right',
      render: (v: number) => (Number.isFinite(v) ? v.toFixed(3) : '—'),
    },
    {
      title: '累计收益',
      dataIndex: 'totalReturn',
      width: 100,
      align: 'right',
      render: (v: number) => pct(v, 1),
    },
    {
      title: '最大回撤',
      dataIndex: 'maxDrawdown',
      width: 100,
      align: 'right',
      render: (v: number) => pct(v, 1),
    },
    {
      title: '夏普',
      dataIndex: 'sharpe',
      width: 80,
      align: 'right',
      render: (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '—'),
    },
    { title: '交易次数', dataIndex: 'tradeCount', width: 90, align: 'right' },
    {
      title: '胜率',
      dataIndex: 'winRate',
      width: 80,
      align: 'right',
      render: (v: number) => pct(v, 0),
    },
  ]

  const m = result?.metrics

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {/* ---------------- 配置区 ---------------- */}
      <Card size={isMobile ? 'small' : 'default'} title="回测配置">
        {registryError && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="策略引擎不可用"
            description={registryError}
          />
        )}

        <Spin spinning={loadingRegistry}>
          <Row gutter={[12, 12]}>
            <Col xs={24} md={8}>
              <div style={{ marginBottom: 4, fontSize: 12, color: 'var(--qb-text-secondary)' }}>
                标的代码
              </div>
              <AutoComplete
                value={symbol}
                options={searchOptions}
                style={{ width: '100%' }}
                onSearch={setSearchText}
                onChange={(v) => setSymbol(v ?? '')}
                placeholder="输入代码或名称，如 600519"
              />
            </Col>
            <Col xs={24} md={8}>
              <div style={{ marginBottom: 4, fontSize: 12, color: 'var(--qb-text-secondary)' }}>
                策略
              </div>
              <Select
                value={strategyId || undefined}
                style={{ width: '100%' }}
                placeholder="选择策略"
                onChange={setStrategyId}
                options={strategies.map((s) => ({ value: s.id, label: s.name }))}
              />
            </Col>
            <Col xs={24} md={8}>
              <div style={{ marginBottom: 4, fontSize: 12, color: 'var(--qb-text-secondary)' }}>
                回测区间
              </div>
              <Segmented
                block
                value={rangeYears}
                onChange={(v) => setRangeYears(v as number)}
                options={RANGE_PRESETS.map((p) => ({ label: p.label, value: p.years }))}
              />
            </Col>
          </Row>

          {currentStrategy && (
            <Paragraph
              type="secondary"
              style={{ fontSize: 12, marginTop: 10, marginBottom: 0 }}
            >
              {currentStrategy.description}
            </Paragraph>
          )}
        </Spin>

        <Divider style={{ margin: '14px 0' }} />

        {/* 参数表单：由 Rust 提供的 ParamSpec 自动生成，避免前后端定义漂移 */}
        {currentStrategy && currentStrategy.params.length > 0 && (
          <>
            <Title level={5} style={{ fontSize: 13, marginBottom: 10 }}>
              策略参数
            </Title>
            <Row gutter={[16, 8]}>
              {currentStrategy.params.map((p) => (
                <Col xs={24} sm={12} md={8} key={p.key}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: 12,
                      color: 'var(--qb-text-secondary)',
                    }}
                  >
                    <span title={p.hint}>{p.label}</span>
                    <Text style={{ fontSize: 12 }}>{params[p.key] ?? p.defaultValue}</Text>
                  </div>
                  <Slider
                    min={p.min ?? 0}
                    max={p.max ?? 100}
                    step={p.step ?? (p.kind === 'int' ? 1 : 0.1)}
                    value={params[p.key] ?? p.defaultValue}
                    onChange={(v) => setParams((prev) => ({ ...prev, [p.key]: v as number }))}
                    tooltip={{ formatter: (v) => `${v}` }}
                  />
                </Col>
              ))}
            </Row>
            <Divider style={{ margin: '10px 0' }} />
          </>
        )}

        {/* 资金与交易成本 */}
        <Collapse
          size="small"
          ghost
          items={[
            {
              key: 'cost',
              label: <Text style={{ fontSize: 13 }}>资金与交易成本（A 股默认值已填好）</Text>,
              children: (
                <Row gutter={[12, 12]}>
                  <Col xs={12} md={6}>
                    <div style={{ fontSize: 12, color: 'var(--qb-text-secondary)' }}>初始资金（元）</div>
                    <InputNumber
                      value={initialCash}
                      min={1000}
                      step={10000}
                      style={{ width: '100%' }}
                      onChange={(v) => setInitialCash(v ?? DEFAULT_CONFIG.initialCash)}
                    />
                  </Col>
                  <Col xs={12} md={6}>
                    <div style={{ fontSize: 12, color: 'var(--qb-text-secondary)' }}>
                      佣金（%，双边）
                    </div>
                    <InputNumber
                      value={commissionPct}
                      min={0}
                      max={1}
                      step={0.01}
                      style={{ width: '100%' }}
                      onChange={(v) => setCommissionPct(v ?? 0.03)}
                    />
                  </Col>
                  <Col xs={12} md={6}>
                    <div style={{ fontSize: 12, color: 'var(--qb-text-secondary)' }}>
                      印花税（%，卖出）
                    </div>
                    <InputNumber
                      value={stampDutyPct}
                      min={0}
                      max={1}
                      step={0.01}
                      style={{ width: '100%' }}
                      onChange={(v) => setStampDutyPct(v ?? 0.05)}
                    />
                  </Col>
                  <Col xs={12} md={6}>
                    <div style={{ fontSize: 12, color: 'var(--qb-text-secondary)' }}>
                      滑点（%）
                    </div>
                    <InputNumber
                      value={slippagePct}
                      min={0}
                      max={2}
                      step={0.01}
                      style={{ width: '100%' }}
                      onChange={(v) => setSlippagePct(v ?? 0.05)}
                    />
                  </Col>
                  <Col xs={12} md={6}>
                    <div style={{ fontSize: 12, color: 'var(--qb-text-secondary)' }}>
                      止损（%，0 = 不启用）
                    </div>
                    <InputNumber
                      value={stopLossPct}
                      min={0}
                      max={50}
                      step={0.5}
                      style={{ width: '100%' }}
                      onChange={(v) => setStopLossPct(v ?? 0)}
                    />
                  </Col>
                  <Col xs={12} md={6}>
                    <div style={{ fontSize: 12, color: 'var(--qb-text-secondary)' }}>
                      止盈（%，0 = 不启用）
                    </div>
                    <InputNumber
                      value={takeProfitPct}
                      min={0}
                      max={200}
                      step={1}
                      style={{ width: '100%' }}
                      onChange={(v) => setTakeProfitPct(v ?? 0)}
                    />
                  </Col>
                  <Col xs={12} md={6}>
                    <div style={{ fontSize: 12, color: 'var(--qb-text-secondary)' }}>
                      最大仓位（%）
                    </div>
                    <InputNumber
                      value={maxPositionPct}
                      min={1}
                      max={100}
                      step={5}
                      style={{ width: '100%' }}
                      onChange={(v) => setMaxPositionPct(v ?? 100)}
                    />
                  </Col>
                  <Col xs={24} md={6}>
                    <div style={{ fontSize: 12, color: 'var(--qb-text-secondary)' }}>
                      说明
                    </div>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      按 100 股整手撮合、T+1 限制、佣金最低 5 元
                    </Text>
                  </Col>
                </Row>
              ),
            },
          ]}
        />

        <Space style={{ marginTop: 14 }} wrap>
          <Button type="primary" onClick={handleRun} loading={running} disabled={!strategyId}>
            开始回测
          </Button>
          <Space size={6}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              优化目标
            </Text>
            <Select
              size="small"
              value={objective}
              style={{ width: 120 }}
              onChange={(v) => setObjective(v as OptimizeObjective)}
              options={[
                { value: 'sharpe', label: '夏普比率' },
                { value: 'total_return', label: '累计收益' },
                { value: 'calmar', label: '卡玛比率' },
                { value: 'sortino', label: '索提诺' },
              ]}
            />
          </Space>
          <Button onClick={handleOptimize} loading={optimizing} disabled={!strategyId}>
            参数优化
          </Button>
          {barCount != null && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              最近一次数据量：{barCount} 根日线
            </Text>
          )}
        </Space>

        {error && (
          <Alert type="error" showIcon style={{ marginTop: 12 }} message={error} />
        )}
      </Card>

      {/* ---------------- 结果区 ---------------- */}
      {result && m && (
        <>
          <Card
            size={isMobile ? 'small' : 'default'}
            title={
              <Space size={8} wrap>
                <span>
                  {result.symbol} · {result.strategyName}
                </span>
                <Tag>{`${result.startDate} ~ ${result.endDate}`}</Tag>
              </Space>
            }
          >
            <Row gutter={[12, 16]}>
              <Col xs={12} sm={8} md={4}>
                <Statistic
                  title="累计收益"
                  value={m.totalReturn * 100}
                  precision={2}
                  suffix="%"
                  valueStyle={{ color: m.totalReturn >= 0 ? negativeColor : positiveColor }}
                />
              </Col>
              <Col xs={12} sm={8} md={4}>
                <Statistic
                  title="年化收益"
                  value={m.annualReturn * 100}
                  precision={2}
                  suffix="%"
                  valueStyle={{ color: m.annualReturn >= 0 ? negativeColor : positiveColor }}
                />
              </Col>
              <Col xs={12} sm={8} md={4}>
                <Statistic title="最大回撤" value={m.maxDrawdown * 100} precision={2} suffix="%" />
              </Col>
              <Col xs={12} sm={8} md={4}>
                <Statistic title="夏普比率" value={m.sharpe} precision={2} />
              </Col>
              <Col xs={12} sm={8} md={4}>
                <Statistic title="索提诺" value={m.sortino} precision={2} />
              </Col>
              <Col xs={12} sm={8} md={4}>
                <Statistic title="卡玛比率" value={m.calmar} precision={2} />
              </Col>
              <Col xs={12} sm={8} md={4}>
                <Statistic title="胜率" value={m.winRate * 100} precision={1} suffix="%" />
              </Col>
              <Col xs={12} sm={8} md={4}>
                <Statistic
                  title="盈亏比"
                  value={m.profitFactor == null ? '∞' : m.profitFactor.toFixed(2)}
                />
              </Col>
              <Col xs={12} sm={8} md={4}>
                <Statistic title="交易次数" value={m.tradeCount} suffix="笔" />
              </Col>
              <Col xs={12} sm={8} md={4}>
                <Statistic title="平均持仓" value={m.avgHoldingDays} precision={1} suffix="天" />
              </Col>
              <Col xs={12} sm={8} md={4}>
                <Statistic
                  title="超额收益"
                  value={m.excessReturn * 100}
                  precision={2}
                  suffix="%"
                  valueStyle={{ color: m.excessReturn >= 0 ? negativeColor : positiveColor }}
                />
              </Col>
              <Col xs={12} sm={8} md={4}>
                <Statistic title="总费用" value={m.totalFees} precision={2} prefix="¥" />
              </Col>
            </Row>

            <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 14, marginBottom: 0 }}>
              期初 {formatAmount(result.initialCash)} → 期末 {formatAmount(result.finalEquity)}；
              同期买入持有基准 {pct(m.benchmarkReturn)}。
              {m.maxDrawdownStart && m.maxDrawdownEnd && (
                <> 最大回撤区间 {m.maxDrawdownStart} ~ {m.maxDrawdownEnd}。</>
              )}
            </Paragraph>

            <Divider style={{ margin: '12px 0' }} />
            <EquityChart
              points={result.equityCurve}
              initialCash={result.initialCash}
              height={isMobile ? 260 : 340}
            />
          </Card>

          <Card size={isMobile ? 'small' : 'default'}>
            <Tabs
              items={[
                {
                  key: 'trades',
                  label: `成交明细（${result.trades.length}）`,
                  children: (
                    <Table<BacktestTrade>
                      size="small"
                      rowKey={(r, i) => `${r.date}-${r.side}-${i}`}
                      dataSource={result.trades}
                      columns={tradeColumns}
                      pagination={{ pageSize: 10, size: 'small', showSizeChanger: false }}
                      scroll={{ x: 760 }}
                      locale={{ emptyText: <Empty description="区间内未触发交易" /> }}
                    />
                  ),
                },
                {
                  key: 'closed',
                  label: `已平仓（${result.closedTrades.length}）`,
                  children: (
                    <Table<ClosedTrade>
                      size="small"
                      rowKey={(r, i) => `${r.entryDate}-${r.exitDate}-${i}`}
                      dataSource={result.closedTrades}
                      columns={closedColumns}
                      pagination={{ pageSize: 10, size: 'small', showSizeChanger: false }}
                      scroll={{ x: 800 }}
                      locale={{ emptyText: <Empty description="没有已平仓交易" /> }}
                    />
                  ),
                },
              ]}
            />
          </Card>
        </>
      )}

      {/* ---------------- 参数优化结果 ---------------- */}
      {optReport && (
        <Card
          size={isMobile ? 'small' : 'default'}
          title={
            <Space size={8} wrap>
              <span>参数优化结果</span>
              <Tag color="blue">目标：{optReport.objective}</Tag>
              <Tag>评估 {optReport.evaluated} 组</Tag>
            </Space>
          }
        >
          {optReport.boundaryWarnings.length > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message="存在过拟合风险"
              description={
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {optReport.boundaryWarnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              }
            />
          )}
          <Table
            size="small"
            rowKey={(r, i) => `${r.score}-${i}`}
            dataSource={optReport.candidates}
            columns={optimizerColumns}
            pagination={false}
            scroll={{ x: 700 }}
          />
          <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 10, marginBottom: 0 }}>
            提示：样本内最优参数不代表未来表现，建议用不同区间做样本外验证后再使用。
          </Paragraph>
        </Card>
      )}

      {optError && <Alert type="error" showIcon message={optError} />}

      {!result && !running && !error && (
        <Card size={isMobile ? 'small' : 'default'}>
          <Empty description="选择标的与策略后点击「开始回测」" />
        </Card>
      )}
    </Space>
  )
}
