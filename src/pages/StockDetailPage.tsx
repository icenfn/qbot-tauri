import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Empty,
  Segmented,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from 'antd'
import {
  ArrowLeftOutlined,
  ReloadOutlined,
  StarOutlined,
  StarFilled,
} from '@ant-design/icons'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '@/lib/api/endpoints'
import type {
  KlineAdjust,
  KlineBar,
  KlinePeriod,
  Quote,
  StockProfile,
} from '@/lib/api/types'
import KlineChart from '@/components/KlineChart'
import ChangeText from '@/components/ChangeText'
import { usePlatform } from '@/hooks/usePlatform'
import { readCache, writeCache } from '@/lib/db/klineCache'
import { addWatchItem, listWatchlist, removeWatchItem } from '@/lib/db/watchlist'
import { changeColor, formatAmount, formatPrice, formatVolume } from '@/lib/format'

const { Text, Title } = Typography

const PERIODS: { label: string; value: KlinePeriod }[] = [
  { label: '日线', value: 'daily' },
  { label: '周线', value: 'weekly' },
  { label: '月线', value: 'monthly' },
]

const ADJUSTS: { label: string; value: KlineAdjust }[] = [
  { label: '前复权', value: 'qfq' },
  { label: '后复权', value: 'hfq' },
  { label: '不复权', value: 'none' },
]

/** K 线缓存有效期：盘中 5 分钟，足够应对频繁切换周期 */
const CACHE_TTL_MS = 5 * 60 * 1000

export default function StockDetailPage() {
  const { symbol = '' } = useParams<{ symbol: string }>()
  const navigate = useNavigate()
  const { isMobile } = usePlatform()

  const [period, setPeriod] = useState<KlinePeriod>('daily')
  const [adjust, setAdjust] = useState<KlineAdjust>('qfq')
  const [bars, setBars] = useState<KlineBar[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fromCache, setFromCache] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)

  const [quote, setQuote] = useState<Quote | null>(null)
  const [profile, setProfile] = useState<StockProfile | null>(null)
  const [inWatchlist, setInWatchlist] = useState(false)
  const [starLoading, setStarLoading] = useState(false)

  // 自选状态
  useEffect(() => {
    let cancelled = false
    listWatchlist()
      .then((rows) => {
        if (!cancelled) setInWatchlist(rows.some((row) => row.symbol === symbol))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [symbol])

  // 实时行情（只取一次，进入页面时快照）
  useEffect(() => {
    if (!symbol) return
    let cancelled = false
    api
      .quotes([symbol], { timeoutMs: 12000 })
      .then((rows) => {
        if (!cancelled && rows.length > 0) setQuote(rows[0])
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [symbol])

  // 个股资料
  useEffect(() => {
    if (!symbol) return
    let cancelled = false
    api
      .stockProfile(symbol, { timeoutMs: 15000 })
      .then((data) => {
        if (!cancelled) setProfile(data)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [symbol])

  const loadBars = useCallback(async () => {
    if (!symbol) return
    const cacheKey = `${symbol}:${period}:${adjust}`
    setLoading(true)
    setError(null)

    // 先读缓存，命中即渲染，随后再静默刷新
    const cached = await readCache<KlineBar[]>(cacheKey, CACHE_TTL_MS)
    if (cached) {
      setBars(cached.data)
      setFromCache(true)
      setUpdatedAt(cached.updatedAt)
      setLoading(false)
    } else {
      setFromCache(false)
    }

    try {
      const res = await api.kline({ symbol, period, adjust }, { timeoutMs: 30000 })
      setBars(res.bars)
      setFromCache(false)
      setUpdatedAt(new Date().toISOString())
      await writeCache(cacheKey, res.bars)
    } catch (err) {
      if (!cached) {
        setError(err instanceof Error ? err.message : String(err))
        setBars([])
      }
    } finally {
      setLoading(false)
    }
  }, [symbol, period, adjust])

  useEffect(() => {
    void loadBars()
  }, [loadBars])

  const title = useMemo(() => {
    const name = quote?.name || profile?.name || ''
    return name ? `${name} ${symbol}` : symbol
  }, [quote?.name, profile?.name, symbol])

  const toggleWatch = async () => {
    setStarLoading(true)
    try {
      if (inWatchlist) {
        await removeWatchItem(symbol)
        setInWatchlist(false)
        message.success('已移出自选')
      } else {
        await addWatchItem({
          symbol,
          name: quote?.name || profile?.name || '',
          kind: 'stock',
        })
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
                {title}
              </Title>
              <Space size={6} style={{ marginTop: 4 }} wrap>
                {profile?.market && <Tag>{profile.market}</Tag>}
                {profile?.industry && <Tag color="blue">{profile.industry}</Tag>}
                {profile?.list_date && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    上市 {profile.list_date}
                  </Text>
                )}
              </Space>
            </div>
          </Space>

          <Space size={12} align="center" wrap>
            {quote && (
              <div style={{ textAlign: 'right' }}>
                <div
                  className="qb-mono"
                  style={{ fontSize: isMobile ? 22 : 26, fontWeight: 700, color: changeColor(quote.change_pct) }}
                >
                  {formatPrice(quote.price)}
                </div>
                <ChangeText change={quote.change} changePct={quote.change_pct} />
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

        {quote && (
          <>
            <div style={{ height: 1, background: 'var(--qb-border)', margin: '14px 0' }} />
            <Descriptions size="small" column={isMobile ? 2 : 4} colon={false}>
              <Descriptions.Item label="今开">{formatPrice(quote.open)}</Descriptions.Item>
              <Descriptions.Item label="昨收">{formatPrice(quote.prev_close)}</Descriptions.Item>
              <Descriptions.Item label="最高">{formatPrice(quote.high)}</Descriptions.Item>
              <Descriptions.Item label="最低">{formatPrice(quote.low)}</Descriptions.Item>
              <Descriptions.Item label="成交量">{formatVolume(quote.volume)}</Descriptions.Item>
              <Descriptions.Item label="成交额">{formatAmount(quote.amount)}</Descriptions.Item>
              <Descriptions.Item label="换手率">
                {quote.turnover !== null ? `${formatPrice(quote.turnover)}%` : '—'}
              </Descriptions.Item>
              <Descriptions.Item label="市盈率(TTM)">
                {quote.pe_ttm !== null ? formatPrice(quote.pe_ttm) : '—'}
              </Descriptions.Item>
            </Descriptions>
          </>
        )}
      </Card>

      <Card
        size={isMobile ? 'small' : 'default'}
        title={
          <div className="qb-card-title">
            <Space size={8}>
              <span>K 线</span>
              {fromCache && <Tag color="orange">本地缓存</Tag>}
              {loading && <Spin size="small" />}
            </Space>
            <Space size={8} wrap>
              <Segmented
                size="small"
                value={period}
                onChange={(value) => setPeriod(value as KlinePeriod)}
                options={PERIODS}
              />
            </Space>
          </div>
        }
        extra={
          <Space size={8} wrap>
            <Segmented
              size="small"
              value={adjust}
              onChange={(value) => setAdjust(value as KlineAdjust)}
              options={ADJUSTS}
            />
            <Button size="small" icon={<ReloadOutlined />} onClick={() => void loadBars()} />
          </Space>
        }
      >
        {error ? (
          <Alert type="error" showIcon message="K 线加载失败" description={error} />
        ) : (
          <>
            <KlineChart bars={bars} loading={loading && bars.length === 0} height={isMobile ? 340 : 460} />
            {updatedAt && (
              <Text type="secondary" style={{ fontSize: 11 }}>
                数据时间 {new Date(updatedAt).toLocaleString('zh-CN')} · 已缓存到本地
              </Text>
            )}
          </>
        )}
      </Card>

      <Card size={isMobile ? 'small' : 'default'} title="公司概况">
        {profile ? (
          <Descriptions size="small" column={isMobile ? 1 : 2} bordered>
            <Descriptions.Item label="股票代码">
              <span className="qb-mono">{profile.symbol}</span>
            </Descriptions.Item>
            <Descriptions.Item label="股票简称">{profile.name || '—'}</Descriptions.Item>
            <Descriptions.Item label="所属行业">{profile.industry || '—'}</Descriptions.Item>
            <Descriptions.Item label="上市日期">{profile.list_date || '—'}</Descriptions.Item>
            <Descriptions.Item label="总市值">
              {profile.total_market_cap ? formatAmount(profile.total_market_cap) : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="流通市值">
              {profile.float_market_cap ? formatAmount(profile.float_market_cap) : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="总股本">
              {profile.total_shares ? formatAmount(profile.total_shares) : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="流通股">
              {profile.float_shares ? formatAmount(profile.float_shares) : '—'}
            </Descriptions.Item>
          </Descriptions>
        ) : (
          <Space>
            <Spin size="small" />
            <Text type="secondary">加载中或数据源暂不可用</Text>
          </Space>
        )}
      </Card>

      {bars.length === 0 && !loading && !error && (
        <Empty description="该标的暂无 K 线数据" />
      )}
    </Space>
  )
}
