import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Input,
  Row,
  Segmented,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd'
import { ReloadOutlined, SearchOutlined, StarOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { api } from '@/lib/api/endpoints'
import type { FundInfo } from '@/lib/api/types'
import { usePlatform } from '@/hooks/usePlatform'
import { listWatchlist } from '@/lib/db/watchlist'

const { Text } = Typography

/** 基金类型筛选：按名称关键字归类，避免依赖后端返回的口径差异 */
const TYPE_FILTERS = [
  { label: '全部', value: 'all' },
  { label: '股票型', value: '股票' },
  { label: '混合型', value: '混合' },
  { label: '债券型', value: '债券' },
  { label: '指数型', value: '指数' },
  { label: '货币型', value: '货币' },
  { label: 'QDII', value: 'QDII' },
]

export default function FundPage() {
  const { isMobile } = usePlatform()
  const navigate = useNavigate()

  const [keyword, setKeyword] = useState('')
  const [applied, setApplied] = useState('')
  const [funds, setFunds] = useState<FundInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState('all')
  const [watchCodes, setWatchCodes] = useState<Set<string>>(new Set())

  const load = useCallback(async (kw: string) => {
    setLoading(true)
    setError(null)
    try {
      const rows = await api.fundList(kw || undefined, { timeoutMs: 30000 })
      setFunds(rows)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setFunds([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load('')
  }, [load])

  useEffect(() => {
    listWatchlist()
      .then((rows) => setWatchCodes(new Set(rows.filter((r) => r.kind === 'fund').map((r) => r.symbol))))
      .catch(() => undefined)
  }, [])

  const visible = useMemo(() => {
    if (typeFilter === 'all') return funds
    return funds.filter((f) => {
      const typeText = `${f.type ?? ''}${f.name}`
      return typeText.includes(typeFilter)
    })
  }, [funds, typeFilter])

  const stats = useMemo(() => {
    const total = funds.length
    const watched = funds.filter((f) => watchCodes.has(f.code)).length
    return { total, watched }
  }, [funds, watchCodes])

  const columns = [
    {
      title: '代码',
      dataIndex: 'code',
      key: 'code',
      width: 100,
      render: (value: string) => (
        <a className="qb-mono" onClick={() => navigate(`/fund/${value}`)}>
          {value}
        </a>
      ),
    },
    {
      title: '基金简称',
      dataIndex: 'name',
      key: 'name',
      render: (value: string) => <span>{value || '—'}</span>,
    },
    {
      title: '类型',
      dataIndex: 'type',
      key: 'type',
      width: 120,
      render: (value: string | null) => (value ? <Tag color="blue">{value}</Tag> : <Text type="secondary">—</Text>),
    },
    {
      title: '状态',
      key: 'watch',
      width: 90,
      render: (_: unknown, record: FundInfo) =>
        watchCodes.has(record.code) ? (
          <Tag icon={<StarOutlined />} color="gold">
            自选
          </Tag>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: '操作',
      key: 'action',
      width: 90,
      render: (_: unknown, record: FundInfo) => (
        <Button type="link" size="small" onClick={() => navigate(`/fund/${record.code}`)}>
          净值
        </Button>
      ),
    },
  ]

  return (
    <Space direction="vertical" size={isMobile ? 12 : 16} style={{ width: '100%' }}>
      <Row gutter={[12, 12]}>
        <Col xs={12} sm={8}>
          <Card size="small">
            <Statistic title="当前列表" value={stats.total} suffix="只" />
          </Card>
        </Col>
        <Col xs={12} sm={8}>
          <Card size="small">
            <Statistic title="已自选" value={stats.watched} suffix="只" />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card size="small">
            <Statistic title="数据源" value="AkShare" valueStyle={{ fontSize: 18 }} />
          </Card>
        </Col>
      </Row>

      <Card
        size={isMobile ? 'small' : 'default'}
        title="基金列表"
        extra={
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load(applied)}>
            刷新
          </Button>
        }
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space.Compact style={{ width: '100%' }}>
            <Input
              placeholder="输入基金代码或简称，如 110022 / 易方达"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onPressEnter={() => {
                setApplied(keyword)
                void load(keyword)
              }}
              allowClear
            />
            <Button
              type="primary"
              icon={<SearchOutlined />}
              loading={loading}
              onClick={() => {
                setApplied(keyword)
                void load(keyword)
              }}
            >
              搜索
            </Button>
          </Space.Compact>

          <Segmented
            size="small"
            value={typeFilter}
            onChange={(value) => setTypeFilter(value as string)}
            options={TYPE_FILTERS}
          />

          {error && <Alert type="error" showIcon message="基金列表加载失败" description={error} />}

          {isMobile ? (
            visible.length === 0 ? (
              <Empty
                description={loading ? '加载中…' : '暂无基金数据'}
                image={Empty.PRESENTED_IMAGE_SIMPLE}
              />
            ) : (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                {visible.slice(0, 100).map((fund) => (
                  <Card
                    key={fund.code}
                    size="small"
                    styles={{ body: { padding: 12 } }}
                    onClick={() => navigate(`/fund/${fund.code}`)}
                    style={{ cursor: 'pointer' }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {fund.name}
                        </div>
                        <Space size={6} style={{ marginTop: 2 }}>
                          <span className="qb-mono" style={{ fontSize: 11, color: 'var(--qb-text-secondary)' }}>
                            {fund.code}
                          </span>
                          {fund.type && (
                            <Tag style={{ margin: 0, fontSize: 10 }} color="blue">
                              {fund.type}
                            </Tag>
                          )}
                          {watchCodes.has(fund.code) && (
                            <Tag style={{ margin: 0, fontSize: 10 }} color="gold">
                              自选
                            </Tag>
                          )}
                        </Space>
                      </div>
                      <Button type="link" size="small" style={{ flex: '0 0 auto' }}>
                        净值
                      </Button>
                    </div>
                  </Card>
                ))}
                {visible.length > 100 && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    仅展示前 100 条，请使用搜索缩小范围
                  </Text>
                )}
              </Space>
            )
          ) : (
            <Table
              size="small"
              rowKey="code"
              loading={loading}
              dataSource={visible}
              columns={columns}
              pagination={{ pageSize: 20, showSizeChanger: false, size: 'small' }}
              locale={{ emptyText: <Empty description="暂无基金数据" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
              scroll={{ x: 640 }}
            />
          )}

          <Text type="secondary" style={{ fontSize: 12 }}>
            数据来自 AkShare 场外基金名录，包含 1 万余只基金。点击任意基金查看净值走势与详情。
          </Text>
        </Space>
      </Card>

      {loading && isMobile && (
        <div style={{ textAlign: 'center' }}>
          <Spin />
        </div>
      )}
    </Space>
  )
}
