import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Segmented,
  Space,
  Spin,
  Statistic,
  Tag,
  Typography,
  message,
} from 'antd'
import {
  ArrowLeftOutlined,
  ReloadOutlined,
  StarFilled,
  StarOutlined,
} from '@ant-design/icons'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '@/lib/api/endpoints'
import type { FundDetail, FundNavPoint } from '@/lib/api/types'
import NavChart from '@/components/NavChart'
import ChangeText from '@/components/ChangeText'
import { usePlatform } from '@/hooks/usePlatform'
import { readCache, writeCache } from '@/lib/db/klineCache'
import { addWatchItem, listWatchlist, removeWatchItem } from '@/lib/db/watchlist'
import { formatPrice, RANGE_DAYS } from '@/lib/format'

const { Text, Title } = Typography

const RANGES = [
  { label: '1月', value: '1M' },
  { label: '3月', value: '3M' },
  { label: '6月', value: '6M' },
  { label: '1年', value: '1Y' },
  { label: '3年', value: '3Y' },
  { label: '全部', value: 'ALL' },
]

const CACHE_TTL_MS = 30 * 60 * 1000

interface RangeStats {
  startNav: number | null
  endNav: number | null
  returnPct: number | null
  maxDrawdown: number | null
  annualized: number | null
  volatility: number | null
  points: number
}

/** 区间绩效：收益率、最大回撤、年化、波动率（展示层计算，正式指标在第三阶段由 Rust 实现） */
function computeStats(points: FundNavPoint[]): RangeStats {
  if (points.length === 0) {
    return {
      startNav: null,
      endNav: null,
      returnPct: null,
      maxDrawdown: null,
      annualized: null,
      volatility: null,
      points: 0,
    }
  }

  const navs = points.map((p) => p.nav).filter((v) => v > 0)
  const startNav = navs[0] ?? null
  const endNav = navs[navs.length - 1] ?? null
  const returnPct =
    startNav && endNav && startNav > 0 ? ((endNav - startNav) / startNav) * 100 : null

  // 最大回撤
  let peak = navs[0] ?? 0
  let maxDrawdown = 0
  navs.forEach((nav) => {
    if (nav > peak) peak = nav
    if (peak > 0) {
      const dd = ((nav - peak) / peak) * 100
      if (dd < maxDrawdown) maxDrawdown = dd
    }
  })

  // 年化收益（按自然日跨度折算）
  const firstDate = new Date(points[0].date).getTime()
  const lastDate = new Date(points[points.length - 1].date).getTime()
  const days = Math.max(1, (lastDate - firstDate) / 86400000)
  const annualized =
    returnPct !== null && days >= 30
      ? (Math.pow(1 + returnPct / 100, 365 / days) - 1) * 100
      : null

  // 年化波动率（日收益标准差 × √244）
  const returns: number[] = []
  for (let i = 1; i < navs.length; i += 1) {
    if (navs[i - 1] > 0) returns.push((navs[i] - navs[i - 1]) / navs[i - 1])
  }
  let volatility: number | null = null
  if (returns.length > 2) {
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length
    const variance = returns.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (returns.length - 1)
    volatility = Math.sqrt(variance) * Math.sqrt(244) * 100
  }

  return { startNav, endNav, returnPct, maxDrawdown, annualized, volatility, points: points.length }
}

export default function FundDetailPage() {
  const { code = '' } = useParams<{ code: string }>()
  const navigate = useNavigate()
  const { isMobile } = usePlatform()

  const [detail, setDetail] = useState<FundDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fromCache, setFromCache] = useState(false)
  const [range, setRange] = useState('1Y')
  const [inWatchlist, setInWatchlist] = useState(false)
  const [starLoading, setStarLoading] = useState(false)

  useEffect(() => {
    listWatchlist()
      .then((rows) => setInWatchlist(rows.some((row) => row.symbol === code)))
      .catch(() => undefined)
  }, [code])

  const load = useCallback(async () => {
    if (!code) return
    setLoading(true)
    setError(null)

    const cacheKey = `fund:${code}:detail`
    const cached = await readCache<FundDetail>(cacheKey, CACHE_TTL_MS)
    if (cached) {
      setDetail(cached.data)
      setFromCache(true)
      setLoading(false)
    } else {
      setFromCache(false)
    }

    try {
      const res = await api.fundDetail(code, { timeoutMs: 45000 })
      setDetail(res)
      setFromCache(false)
      await writeCache(cacheKey, res)
    } catch (err) {
      if (!cached) {
        setError(err instanceof Error ? err.message : String(err))
        setDetail(null)
      }
    } finally {
      setLoading(false)
    }
  }, [code])

  useEffect(() => {
    void load()
  }, [load])

  // 按区间过滤净值点
  const visiblePoints = useMemo(() => {
    const all = detail?.points ?? []
    if (all.length === 0) return []
    if (range === 'ALL') return all
    const days = RANGE_DAYS[range] ?? 366
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - days)
    const cutoffKey = cutoff.toISOString().slice(0, 10)
    const filtered = all.filter((p) => p.date >= cutoffKey)
    return filtered.length > 1 ? filtered : all.slice(-30)
  }, [detail?.points, range])

  const stats = useMemo(() => computeStats(visiblePoints), [visiblePoints])

  const latest = detail?.points?.[detail.points.length - 1] ?? null

  const toggleWatch = async () => {
    setStarLoading(true)
    try {
      if (inWatchlist) {
        await removeWatchItem(code)
        setInWatchlist(false)
        message.success('已移出自选')
      } else {
        await addWatchItem({ symbol: code, name: detail?.name ?? '', kind: 'fund' })
        setInWatchlist(true)
        message.success('已加入自选')
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setStarLoading(false)
    }
  }

  return (
    <Space direction="vertical" size={isMobile ? 12 : 16} style={{ width: '100%' }}>
      <Card size={isMobile ? 'small' : 'default'}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <Space align="start" size={12}>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(-1)} />
            <div>
              <Title level={4} style={{ margin: 0, fontSize: isMobile ? 17 : 20 }}>
                {detail?.name || code}
              </Title>
              <Space size={6} style={{ marginTop: 4 }} wrap>
                <span className="qb-mono" style={{ fontSize: 12, color: 'var(--qb-text-secondary)' }}>
                  {code}
                </span>
                {detail?.type && <Tag color="blue">{detail.type}</Tag>}
                {fromCache && <Tag color="orange">本地缓存</Tag>}
              </Space>
            </div>
          </Space>

          <Space size={12} align="center" wrap>
            {latest && (
              <div style={{ textAlign: 'right' }}>
                <div className="qb-mono" style={{ fontSize: isMobile ? 22 : 26, fontWeight: 700 }}>
                  {formatPrice(latest.nav, 4)}
                </div>
                <Space size={6}>
                  <ChangeText changePct={latest.daily_return} percentOnly size={13} />
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {latest.date}
                  </Text>
                </Space>
              </div>
            )}
            <Button
              type={inWatchlist ? 'default' : 'primary'}
              icon={inWatchlist ? <StarFilled /> : <StarOutlined />}
              loading={starLoading}
              onClick={toggleWatch}
            >
              {inWatchlist ? '已自选' : '加自选'}
            </Button>
          </Space>
        </div>
      </Card>

      {error ? (
        <Alert type="error" showIcon message="净值加载失败" description={error} />
      ) : (
        <>
          <Card
            size={isMobile ? 'small' : 'default'}
            title={
              <div className="qb-card-title">
                <Space size={8}>
                  <span>净值走势</span>
                  {loading && <Spin size="small" />}
                </Space>
                <Segmented
                  size="small"
                  value={range}
                  onChange={(value) => setRange(value as string)}
                  options={RANGES}
                />
              </div>
            }
            extra={<Button size="small" icon={<ReloadOutlined />} onClick={() => void load()} />}
          >
            <NavChart points={visiblePoints} loading={loading && visiblePoints.length === 0} height={isMobile ? 300 : 400} />
            {detail?.latest_date && (
              <Text type="secondary" style={{ fontSize: 11 }}>
                最新净值日期 {detail.latest_date} · 净值更新通常滞后至交易日 20:00 之后
              </Text>
            )}
          </Card>

          <Card size={isMobile ? 'small' : 'default'} title={`区间绩效（${RANGES.find((r) => r.value === range)?.label ?? range}）`}>
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: 12 }}>
                <Statistic
                  title="区间收益"
                  value={stats.returnPct !== null ? Number(stats.returnPct.toFixed(2)) : 0}
                  precision={2}
                  suffix="%"
                  valueStyle={{
                    fontSize: 18,
                    color:
                      stats.returnPct === null
                        ? undefined
                        : stats.returnPct > 0
                          ? 'var(--qb-up)'
                          : stats.returnPct < 0
                            ? 'var(--qb-down)'
                            : undefined,
                  }}
                />
                <Statistic
                  title="最大回撤"
                  value={stats.maxDrawdown !== null ? Number(stats.maxDrawdown.toFixed(2)) : 0}
                  precision={2}
                  suffix="%"
                  valueStyle={{ fontSize: 18, color: 'var(--qb-down)' }}
                />
                <Statistic
                  title="年化收益"
                  value={stats.annualized !== null ? Number(stats.annualized.toFixed(2)) : 0}
                  precision={2}
                  suffix="%"
                  valueStyle={{ fontSize: 18 }}
                />
                <Statistic
                  title="年化波动率"
                  value={stats.volatility !== null ? Number(stats.volatility.toFixed(2)) : 0}
                  precision={2}
                  suffix="%"
                  valueStyle={{ fontSize: 18 }}
                />
              </div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                共 {stats.points} 个净值点。区间绩效为展示层近似计算；第三阶段将由 Rust 指标引擎统一计算并纳入回测报告。
              </Text>
            </Space>
          </Card>

          <Card size={isMobile ? 'small' : 'default'} title="基金信息">
            <Descriptions size="small" column={isMobile ? 1 : 2} bordered>
              <Descriptions.Item label="基金代码">
                <span className="qb-mono">{code}</span>
              </Descriptions.Item>
              <Descriptions.Item label="基金简称">{detail?.name || '—'}</Descriptions.Item>
              <Descriptions.Item label="基金类型">{detail?.type || '—'}</Descriptions.Item>
              <Descriptions.Item label="最新净值">
                {detail?.latest_nav !== null && detail?.latest_nav !== undefined
                  ? formatPrice(detail.latest_nav, 4)
                  : '—'}
              </Descriptions.Item>
              <Descriptions.Item label="净值日期">{detail?.latest_date || '—'}</Descriptions.Item>
              <Descriptions.Item label="累计净值">
                {(() => {
                  const point = detail?.points?.[detail.points.length - 1]
                  return point?.acc_nav !== null && point?.acc_nav !== undefined
                    ? formatPrice(point.acc_nav, 4)
                    : '—'
                })()}
              </Descriptions.Item>
            </Descriptions>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 10 }}>
              AkShare 场外基金通道暂不提供基金经理、基金规模与公司字段，故此处留空；
              后续阶段若数据源补齐将一并展示。
            </Text>
          </Card>
        </>
      )}
    </Space>
  )
}
