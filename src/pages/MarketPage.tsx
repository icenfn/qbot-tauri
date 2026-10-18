import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  AutoComplete,
  Button,
  Card,
  Col,
  Empty,
  Popconfirm,
  Row,
  Segmented,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import {
  DeleteOutlined,
  LineChartOutlined,
  PlusOutlined,
  ReloadOutlined,
  StarOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import {
  addWatchItem,
  clearWatchlist,
  listWatchlist,
  removeWatchItem,
  type WatchItem,
} from '@/lib/db/watchlist'
import { api } from '@/lib/api/endpoints'
import type { Quote, SearchResult, SymbolKind } from '@/lib/api/types'
import { usePlatform } from '@/hooks/usePlatform'
import { usePolling } from '@/hooks/usePolling'
import ChangeText from '@/components/ChangeText'
import { formatAmount, formatPrice, formatVolume, changeColor } from '@/lib/format'

const { Text } = Typography

const KIND_LABEL: Record<SymbolKind, string> = {
  stock: 'A股',
  fund: '基金',
  index: '指数',
}

interface FundSnapshot {
  nav: number
  date: string
  dailyReturn: number | null
}

/** 轮询间隔：交易时段 10 秒，其余时间拉长到 60 秒，降低数据源压力 */
function pollInterval(): number {
  const now = new Date()
  const day = now.getDay()
  const minutes = now.getHours() * 60 + now.getMinutes()
  const isTradingDay = day >= 1 && day <= 5
  const inSession = (minutes >= 9 * 60 + 15 && minutes <= 11 * 60 + 30) ||
    (minutes >= 13 * 60 && minutes <= 15 * 60 + 5)
  return isTradingDay && inSession ? 10000 : 60000
}

export default function MarketPage() {
  const { isMobile } = usePlatform()
  const navigate = useNavigate()

  const [items, setItems] = useState<WatchItem[]>([])
  const [listError, setListError] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | SymbolKind>('all')
  const [open, setOpen] = useState(false)

  const [draftSymbol, setDraftSymbol] = useState('')
  const [draftName, setDraftName] = useState('')
  const [draftKind, setDraftKind] = useState<SymbolKind>('stock')
  const [options, setOptions] = useState<{ value: string; label: string; kind: SymbolKind }[]>([])
  const [searching, setSearching] = useState(false)

  const loadList = useCallback(async () => {
    try {
      const rows = await listWatchlist()
      setItems(rows)
      setListError(null)
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void loadList()
  }, [loadList])

  // ---------------- 行情轮询
  const stockSymbols = useMemo(
    () => items.filter((it) => it.kind === 'stock').map((it) => it.symbol),
    [items],
  )
  const fundCodes = useMemo(
    () => items.filter((it) => it.kind === 'fund').map((it) => it.symbol),
    [items],
  )
  const symbolsKey = stockSymbols.join(',')
  const fundsKey = fundCodes.join(',')

  const interval = pollInterval()

  const quotesState = usePolling<Quote[]>(
    () => (stockSymbols.length ? api.quotes(stockSymbols) : Promise.resolve([])),
    { intervalMs: interval, enabled: stockSymbols.length > 0, deps: [symbolsKey] },
  )

  const fundState = usePolling<Record<string, FundSnapshot>>(
    async () => {
      if (fundCodes.length === 0) return {}
      const entries = await Promise.all(
        fundCodes.map(async (code) => {
          try {
            const res = await api.fundNav({ code })
            const last = res.points[res.points.length - 1]
            if (!last) return [code, null] as const
            return [code, { nav: last.nav, date: last.date, dailyReturn: last.daily_return }] as const
          } catch {
            return [code, null] as const
          }
        }),
      )
      const map: Record<string, FundSnapshot> = {}
      entries.forEach(([code, snap]) => {
        if (snap) map[code] = snap
      })
      return map
    },
    { intervalMs: 180000, enabled: fundCodes.length > 0, deps: [fundsKey] },
  )

  const quoteMap = useMemo(() => {
    const map: Record<string, Quote> = {}
    ;(quotesState.data ?? []).forEach((q) => {
      map[q.symbol] = q
    })
    return map
  }, [quotesState.data])

  const overviewState = usePolling(() => api.marketOverview(6), { intervalMs: interval })

  // 行情拿到名称后回填到本地自选，减少下次手动输入
  useEffect(() => {
    const missing = items.filter((it) => !it.name && quoteMap[it.symbol]?.name)
    if (missing.length === 0) return
    void (async () => {
      for (const item of missing) {
        const name = quoteMap[item.symbol].name
        try {
          await addWatchItem({ symbol: item.symbol, name, kind: item.kind, group: item.group })
        } catch {
          // 回填失败不影响展示
        }
      }
      await loadList()
    })()
  }, [items, quoteMap, loadList])

  // ---------------- 搜索自动补全
  const handleSearch = useCallback(async (value: string) => {
    const keyword = value.trim()
    if (!keyword) {
      setOptions([])
      return
    }
    setSearching(true)
    try {
      const results = await api.search(keyword, 15, { timeoutMs: 12000 })
      setOptions(
        results.map((r: SearchResult) => ({
          value: r.symbol,
          label: `${r.symbol}  ${r.name}`,
          kind: r.kind,
        })),
      )
    } catch {
      setOptions([])
    } finally {
      setSearching(false)
    }
  }, [])

  const handlePick = (symbol: string) => {
    const hit = options.find((opt) => opt.value === symbol)
    setDraftSymbol(symbol)
    if (hit) {
      const name = hit.label.replace(`${hit.value}`, '').trim()
      setDraftName(name)
      setDraftKind(hit.kind)
    }
  }

  const handleAdd = async () => {
    if (!draftSymbol.trim()) {
      message.warning('请输入或选择标的代码')
      return
    }
    try {
      await addWatchItem({ symbol: draftSymbol, name: draftName, kind: draftKind })
      message.success('已加入自选')
      setOpen(false)
      setDraftSymbol('')
      setDraftName('')
      setOptions([])
      await loadList()
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleRemove = async (symbol: string) => {
    await removeWatchItem(symbol)
    await loadList()
  }

  const handleClear = async () => {
    await clearWatchlist()
    await loadList()
    message.success('已清空自选')
  }

  const visible = filter === 'all' ? items : items.filter((it) => it.kind === filter)

  const dataError = quotesState.error ?? fundState.error ?? listError
  const refreshAll = () => {
    quotesState.refresh()
    fundState.refresh()
    overviewState.refresh()
    void loadList()
  }

  // ---------------- 表格列
  const columns = [
    {
      title: '代码',
      dataIndex: 'symbol',
      key: 'symbol',
      width: 100,
      render: (value: string, record: WatchItem) => (
        <a className="qb-mono" onClick={() => openDetail(record)}>
          {value}
        </a>
      ),
    },
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      render: (value: string, record: WatchItem) => (
        <Space size={6}>
          <span>{value || quoteMap[record.symbol]?.name || '—'}</span>
          <Tag style={{ margin: 0 }}>{KIND_LABEL[record.kind]}</Tag>
        </Space>
      ),
    },
    {
      title: '最新价',
      key: 'price',
      width: 110,
      align: 'right' as const,
      render: (_: unknown, record: WatchItem) => {
        if (record.kind === 'fund') {
          const snap = fundState.data?.[record.symbol]
          return <span className="qb-mono">{snap ? formatPrice(snap.nav, 4) : '—'}</span>
        }
        const q = quoteMap[record.symbol]
        return (
          <span className="qb-mono" style={{ color: changeColor(q?.change_pct), fontWeight: 600 }}>
            {q ? formatPrice(q.price) : '—'}
          </span>
        )
      },
    },
    {
      title: '涨跌',
      key: 'change',
      width: 130,
      align: 'right' as const,
      render: (_: unknown, record: WatchItem) => {
        if (record.kind === 'fund') {
          const snap = fundState.data?.[record.symbol]
          if (!snap) return '—'
          return <ChangeText changePct={snap.dailyReturn} percentOnly />
        }
        const q = quoteMap[record.symbol]
        if (!q) return '—'
        return <ChangeText change={q.change} changePct={q.change_pct} />
      },
    },
    {
      title: '成交额',
      key: 'amount',
      width: 100,
      align: 'right' as const,
      responsive: ['lg' as const],
      render: (_: unknown, record: WatchItem) => {
        if (record.kind === 'fund') return <Text type="secondary">—</Text>
        const q = quoteMap[record.symbol]
        return <span className="qb-mono">{q ? formatAmount(q.amount) : '—'}</span>
      },
    },
    {
      title: '成交量',
      key: 'volume',
      width: 100,
      align: 'right' as const,
      responsive: ['xl' as const],
      render: (_: unknown, record: WatchItem) => {
        if (record.kind === 'fund') return <Text type="secondary">—</Text>
        const q = quoteMap[record.symbol]
        return <span className="qb-mono">{q ? formatVolume(q.volume) : '—'}</span>
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 96,
      render: (_: unknown, record: WatchItem) => (
        <Space size={0}>
          <Tooltip title="查看图表">
            <Button type="link" size="small" icon={<LineChartOutlined />} onClick={() => openDetail(record)} />
          </Tooltip>
          <Popconfirm title="移出自选？" onConfirm={() => handleRemove(record.symbol)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  function openDetail(record: WatchItem) {
    if (record.kind === 'fund') navigate(`/fund/${record.symbol}`)
    else navigate(`/market/${record.symbol}`)
  }

  const overview = overviewState.data?.indices ?? []

  return (
    <Space direction="vertical" size={isMobile ? 12 : 16} style={{ width: '100%' }}>
      {/* 指数概览 */}
      <Card
        size={isMobile ? 'small' : 'default'}
        title="主要指数"
        extra={
          <Space size={8}>
            {overviewState.refreshing && <Spin size="small" />}
            <Button size="small" icon={<ReloadOutlined />} onClick={() => overviewState.refresh()} />
          </Space>
        }
        styles={{ body: { padding: isMobile ? 12 : 20 } }}
      >
        {overviewState.error ? (
          <Alert
            type="warning"
            showIcon
            message="指数数据暂不可用"
            description={overviewState.error}
          />
        ) : overviewState.loading && overview.length === 0 ? (
          <div style={{ padding: '12px 0' }}>
            <Spin size="small" /> <Text type="secondary">加载中…</Text>
          </div>
        ) : (
          <Row gutter={[12, 12]}>
            {overview.map((idx) => (
              <Col xs={12} sm={8} md={4} key={idx.symbol}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: 'var(--qb-text-secondary)' }}>{idx.name}</div>
                  <div
                    className="qb-mono"
                    style={{ fontSize: 18, fontWeight: 700, color: changeColor(idx.change_pct) }}
                  >
                    {formatPrice(idx.price)}
                  </div>
                  <ChangeText change={idx.change} changePct={idx.change_pct} size={12} />
                </div>
              </Col>
            ))}
          </Row>
        )}
      </Card>

      {/* 自选标的 */}
      <Card
        size={isMobile ? 'small' : 'default'}
        title={
          <div className="qb-card-title">
            <Space size={6}>
              <StarOutlined />
              <span>自选标的</span>
              <Tag color="default">{items.length}</Tag>
            </Space>
          </div>
        }
        extra={
          <Space size={8}>
            {quotesState.refreshing && <Spin size="small" />}
            <Tooltip title="刷新全部">
              <Button size="small" icon={<ReloadOutlined />} onClick={refreshAll} />
            </Tooltip>
            <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
              添加
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space wrap size={8}>
            <Segmented
              size="small"
              value={filter}
              onChange={(value) => setFilter(value as 'all' | SymbolKind)}
              options={[
                { label: '全部', value: 'all' },
                { label: 'A股', value: 'stock' },
                { label: '基金', value: 'fund' },
              ]}
            />
            {items.length > 0 && (
              <Popconfirm title="确认清空全部自选？" onConfirm={handleClear}>
                <Button size="small" danger type="text">
                  清空
                </Button>
              </Popconfirm>
            )}
            {quotesState.updatedAt && (
              <Text type="secondary" style={{ fontSize: 11 }}>
                行情更新 {new Date(quotesState.updatedAt).toLocaleTimeString('zh-CN')}
              </Text>
            )}
          </Space>

          {dataError && (
            <Alert type="error" showIcon message="数据加载失败" description={dataError} />
          )}

          {isMobile ? (
            visible.length === 0 ? (
              <Empty description="暂无自选标的" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                {visible.map((item) => {
                  const q = quoteMap[item.symbol]
                  const snap = fundState.data?.[item.symbol]
                  const pct = item.kind === 'fund' ? snap?.dailyReturn : q?.change_pct
                  const price =
                    item.kind === 'fund'
                      ? snap
                        ? formatPrice(snap.nav, 4)
                        : '—'
                      : q
                        ? formatPrice(q.price)
                        : '—'
                  return (
                    <Card
                      key={item.symbol}
                      size="small"
                      styles={{ body: { padding: 12 } }}
                      onClick={() => openDetail(item)}
                      style={{ cursor: 'pointer' }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: 8,
                        }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {item.name || q?.name || item.symbol}
                          </div>
                          <Space size={6} style={{ marginTop: 2 }}>
                            <span className="qb-mono" style={{ fontSize: 11, color: 'var(--qb-text-secondary)' }}>
                              {item.symbol}
                            </span>
                            <Tag style={{ margin: 0, fontSize: 10 }}>{KIND_LABEL[item.kind]}</Tag>
                          </Space>
                        </div>
                        <div style={{ textAlign: 'right', flex: '0 0 auto' }}>
                          <div className="qb-mono" style={{ fontSize: 16, fontWeight: 700, color: changeColor(pct) }}>
                            {price}
                          </div>
                          <ChangeText changePct={pct} percentOnly size={12} />
                        </div>
                        <Popconfirm
                          title="移出自选？"
                          onConfirm={(e) => {
                            e?.stopPropagation()
                            void handleRemove(item.symbol)
                          }}
                        >
                          <Button
                            type="text"
                            danger
                            size="small"
                            icon={<DeleteOutlined />}
                            onClick={(e) => e.stopPropagation()}
                          />
                        </Popconfirm>
                      </div>
                    </Card>
                  )
                })}
              </Space>
            )
          ) : (
            <Table
              size="small"
              rowKey="symbol"
              loading={quotesState.loading && items.length > 0}
              dataSource={visible}
              columns={columns}
              pagination={false}
              locale={{
                emptyText: <Empty description="暂无自选标的" image={Empty.PRESENTED_IMAGE_SIMPLE} />,
              }}
              scroll={{ x: 720 }}
            />
          )}
        </Space>
      </Card>

      {/* 添加自选：带搜索自动补全 */}
      <Card
        size={isMobile ? 'small' : 'default'}
        title="添加自选"
        style={open ? undefined : { display: 'none' }}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Segmented
            block
            value={draftKind}
            onChange={(value) => setDraftKind(value as SymbolKind)}
            options={[
              { label: 'A股', value: 'stock' },
              { label: '基金', value: 'fund' },
            ]}
          />
          <AutoComplete
            style={{ width: '100%' }}
            value={draftSymbol}
            options={options}
            onSearch={handleSearch}
            onSelect={handlePick}
            onChange={(value) => {
              setDraftSymbol(value)
              if (!value) setOptions([])
            }}
            notFoundContent={searching ? <Spin size="small" /> : null}
          >
            <input
              placeholder="输入代码或名称搜索，如 600519 / 贵州茅台 / 110022"
              style={{
                width: '100%',
                padding: '6px 11px',
                borderRadius: 8,
                border: '1px solid var(--qb-border)',
                background: 'var(--qb-bg-elevated)',
                color: 'var(--qb-text)',
                outline: 'none',
              }}
            />
          </AutoComplete>
          <Text type="secondary" style={{ fontSize: 12 }}>
            名称可留空，加入后会自动从行情补全。
          </Text>
          <Space>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
              加入自选
            </Button>
            <Button onClick={() => setOpen(false)}>关闭</Button>
          </Space>
        </Space>
      </Card>

      <Card size={isMobile ? 'small' : 'default'} title="数据说明">
        <Space direction="vertical" size={6}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            行情与指数来自 AkShare（经 FastAPI 转发），交易时段每 10 秒刷新，非交易时段每 60 秒刷新。
          </Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            基金净值为日频数据，每 3 分钟刷新一次；净值更新通常滞后至交易日 20:00 之后。
          </Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            点击任意标的可进入详情页查看 K 线或净值走势。
          </Text>
        </Space>
      </Card>

      {/* 移动端悬浮添加按钮 */}
      {isMobile && (
        <Button
          type="primary"
          shape="circle"
          size="large"
          icon={<PlusOutlined />}
          onClick={() => setOpen(true)}
          style={{
            position: 'fixed',
            right: 18,
            bottom: 'calc(72px + env(safe-area-inset-bottom, 0px))',
            zIndex: 40,
            boxShadow: '0 6px 16px rgba(0,0,0,0.25)',
          }}
        />
      )}

    </Space>
  )
}
