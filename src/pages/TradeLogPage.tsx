/**
 * 交易日志页。
 *
 * 从交易中心里拆出来的原因：交易日志是**复盘**的主要入口，需要
 * 日期区间、方向、状态、来源、关键词的任意组合过滤，还要能导出留档；
 * 而交易中心页的主线是「下单」，把一大张可筛选的表格塞在下单表单下面，
 * 会让两件事互相干扰——用户下单时要滚动很久才能看到持仓，复盘时又要
 * 先滚过整个下单区。
 *
 * 拆开后两侧都变简单：交易中心专注「发起」，本页专注「回看」。
 *
 * 分页说明：日志量会随使用时间持续增长，一次全量加载在手机上会明显卡顿。
 * 这里采用「服务端过滤 + 前端分页」：筛选条件变化时重新查一次，
 * 但单次查询上限设为 1000 条并在超限时明确提示，而不是假装数据完整。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Input,
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
  DownloadOutlined,
  ReloadOutlined,
  SearchOutlined,
  DeleteOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import dayjs, { type Dayjs } from 'dayjs'
import { usePlatform } from '@/hooks/usePlatform'
import { formatAmount, formatPrice } from '@/lib/format'
import {
  downloadCsv,
  ordersToCsv,
  purgeOrdersBefore,
  queryOrders,
  summarize,
  type LogSummary,
} from '@/lib/trade/ledgerReport'
import {
  type OrderRecord,
  type OrderStatus,
  type TradeSide,
} from '@/lib/trade/types'

const { Text, Paragraph, Title } = Typography
const { RangePicker } = DatePicker

/** 单次查询上限。超过时提示用户缩小范围，而不是静默截断 */
const QUERY_LIMIT = 1000

const STATUS_COLOR: Record<string, string> = {
  pending: 'default',
  submitted: 'processing',
  partial: 'warning',
  filled: 'success',
  cancelled: 'default',
  rejected: 'error',
  failed: 'error',
}

const STATUS_TEXT: Record<string, string> = {
  pending: '待提交',
  submitted: '已报',
  partial: '部分成交',
  filled: '已成交',
  cancelled: '已撤',
  rejected: '风控拒绝',
  failed: '失败',
}

const SOURCE_TEXT: Record<string, string> = {
  manual: '手动',
  conditional: '条件单',
  strategy: '策略',
}

/** 快捷区间：复盘最常用的三个窗口 */
const QUICK_RANGES = [
  { label: '今日', days: 0 },
  { label: '近 7 天', days: 6 },
  { label: '近 30 天', days: 29 },
  { label: '全部', days: -1 },
]

export default function TradeLogPage() {
  const { isMobile } = usePlatform()

  const [range, setRange] = useState<[Dayjs, Dayjs] | null>(null)
  const [quick, setQuick] = useState<string>('近 30 天')
  const [keyword, setKeyword] = useState('')
  const [side, setSide] = useState<TradeSide | ''>('')
  const [status, setStatus] = useState<OrderStatus | ''>('')
  const [source, setSource] = useState('')

  const [rows, setRows] = useState<OrderRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /**
   * 把界面上的「本地日期」转成查询用的日期字符串。
   *
   * 关键点：`createdAt` 存的是 UTC ISO 串，而用户选择的是本地日期。
   * 若直接用本地日期去比较 UTC 前缀，在东八区会整体偏移 8 小时
   * （例如本地 10-19 07:00 的记录，UTC 是 10-18 23:00，会被算到前一天）。
   * 所以这里把本地日期的 00:00 和 23:59:59 分别转成 UTC 串再取日期部分，
   * 得到一个「略宽」的区间 —— 宁可多查一点在前端可见，也不要漏掉边界记录。
   */
  const toDateKey = useCallback((d: Dayjs): string => d.format('YYYY-MM-DD'), [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const from = range ? toDateKey(range[0]) : undefined
      const to = range ? toDateKey(range[1]) : undefined
      const data = await queryOrders({
        from,
        to,
        keyword: keyword.trim() || undefined,
        side: side || undefined,
        status: status || undefined,
        source: source || undefined,
        limit: QUERY_LIMIT,
      })
      setRows(data)
      setTruncated(data.length >= QUERY_LIMIT)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [range, keyword, side, status, source, toDateKey])

  // 快捷区间变化时同步到 RangePicker，保证两个控件语义一致
  useEffect(() => {
    const preset = QUICK_RANGES.find((r) => r.label === quick)
    if (!preset) return
    if (preset.days < 0) {
      setRange(null)
      return
    }
    const end = dayjs()
    const start = end.subtract(preset.days, 'day')
    setRange([start, end])
  }, [quick])

  useEffect(() => {
    void load()
  }, [load])

  const summary: LogSummary = useMemo(() => summarize(rows), [rows])

  const handleExport = () => {
    if (rows.length === 0) {
      message.warning('当前没有可导出的记录')
      return
    }
    const stamp = dayjs().format('YYYYMMDD-HHmmss')
    downloadCsv(`交易日志-${stamp}.csv`, ordersToCsv(rows))
    message.success(`已导出 ${rows.length} 条记录`)
  }

  const handlePurge = async () => {
    const cutoff = dayjs().subtract(90, 'day').format('YYYY-MM-DD')
    try {
      const n = await purgeOrdersBefore(cutoff)
      message.success(n > 0 ? `已清理 ${n} 条 90 天前的记录` : '没有需要清理的记录')
      await load()
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    }
  }

  const columns: ColumnsType<OrderRecord> = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 170,
      render: (v: string) => <span className="qb-mono">{v.replace('T', ' ').slice(0, 19)}</span>,
      sorter: (a, b) => (a.createdAt < b.createdAt ? -1 : 1),
      defaultSortOrder: 'descend',
    },
    {
      title: '代码',
      dataIndex: 'symbol',
      width: 110,
      render: (v: string, row) => (
        <Space direction="vertical" size={0}>
          <span className="qb-mono">{v}</span>
          {row.name ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {row.name}
            </Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: '方向',
      dataIndex: 'side',
      width: 80,
      filters: [
        { text: '买入', value: 'buy' },
        { text: '卖出', value: 'sell' },
      ],
      onFilter: (value, row) => row.side === value,
      render: (v: TradeSide) => (
        <Tag color={v === 'buy' ? 'red' : 'green'}>{v === 'buy' ? '买入' : '卖出'}</Tag>
      ),
    },
    {
      title: '类型',
      dataIndex: 'orderType',
      width: 80,
      render: (v: string) => (v === 'market' ? '市价' : '限价'),
    },
    {
      title: '委托价',
      dataIndex: 'price',
      width: 110,
      align: 'right',
      render: (v: number) => (v > 0 ? formatPrice(v, 3) : '—'),
    },
    { title: '数量', dataIndex: 'volume', width: 100, align: 'right' },
    {
      title: '金额',
      dataIndex: 'amount',
      width: 130,
      align: 'right',
      render: (v: number) => (v > 0 ? formatAmount(v) : '—'),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (v: string) => <Tag color={STATUS_COLOR[v] ?? 'default'}>{STATUS_TEXT[v] ?? v}</Tag>,
    },
    {
      title: '来源',
      dataIndex: 'source',
      width: 90,
      render: (v: string) => <Tag>{SOURCE_TEXT[v] ?? v}</Tag>,
    },
    {
      title: '说明',
      dataIndex: 'message',
      render: (v: string) => (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {v || '—'}
        </Text>
      ),
    },
  ]

  return (
    <div style={{ padding: isMobile ? 12 : 20 }}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>
            交易日志
          </Title>
          <Paragraph type="secondary" style={{ margin: '4px 0 0', fontSize: 13 }}>
            记录本机发起的每一笔委托（含被风控拦截的），用于复盘与对账。数据只存在本地。
          </Paragraph>
        </div>

        {/* 汇总统计：先看总量再翻明细，是最自然的复盘顺序 */}
        <Row gutter={[12, 12]}>
          <Col xs={12} md={5}>
            <Card size="small">
              <Statistic title="记录数" value={summary.total} suffix="笔" />
            </Card>
          </Col>
          <Col xs={12} md={5}>
            <Card size="small">
              <Statistic
                title="买入金额"
                value={summary.buyAmount}
                precision={2}
                valueStyle={{ color: 'var(--qb-up)' }}
              />
            </Card>
          </Col>
          <Col xs={12} md={5}>
            <Card size="small">
              <Statistic
                title="卖出金额"
                value={summary.sellAmount}
                precision={2}
                valueStyle={{ color: 'var(--qb-down)' }}
              />
            </Card>
          </Col>
          <Col xs={12} md={5}>
            <Card size="small">
              <Statistic title="有效成交额" value={summary.turnover} precision={2} />
            </Card>
          </Col>
          <Col xs={12} md={4}>
            <Card size="small">
              <Statistic
                title="风控拦截 / 失败"
                value={`${summary.rejectedCount} / ${summary.failedCount}`}
                valueStyle={{ fontSize: 20 }}
              />
            </Card>
          </Col>
        </Row>

        <Card size="small" title="筛选">
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Row gutter={[12, 12]} align="middle">
              <Col xs={24} md={7}>
                <Space direction="vertical" size={2} style={{ width: '100%' }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    快捷区间
                  </Text>
                  <Segmented
                    block
                    value={quick}
                    onChange={(v) => setQuick(v as string)}
                    options={QUICK_RANGES.map((r) => ({ label: r.label, value: r.label }))}
                  />
                </Space>
              </Col>
              <Col xs={24} md={7}>
                <Space direction="vertical" size={2} style={{ width: '100%' }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    日期区间
                  </Text>
                  <RangePicker
                    style={{ width: '100%' }}
                    value={range}
                    onChange={(v) => {
                      setRange(v as [Dayjs, Dayjs] | null)
                      setQuick('')
                    }}
                    allowClear
                  />
                </Space>
              </Col>
              <Col xs={24} md={6}>
                <Space direction="vertical" size={2} style={{ width: '100%' }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    代码 / 名称关键词
                  </Text>
                  <Input
                    placeholder="如 600519"
                    allowClear
                    value={keyword}
                    onChange={(e) => setKeyword(e.target.value)}
                    onPressEnter={() => void load()}
                  />
                </Space>
              </Col>
              <Col xs={24} md={4}>
                <Space direction="vertical" size={2} style={{ width: '100%' }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    &nbsp;
                  </Text>
                  <Button type="primary" block icon={<SearchOutlined />} loading={loading} onClick={() => void load()}>
                    查询
                  </Button>
                </Space>
              </Col>
            </Row>

            <Row gutter={[12, 12]}>
              <Col xs={8} md={5}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  方向
                </Text>
                <Select
                  style={{ width: '100%' }}
                  value={side || 'all'}
                  onChange={(v) => setSide(v === 'all' ? '' : (v as TradeSide))}
                  options={[
                    { value: 'all', label: '全部' },
                    { value: 'buy', label: '买入' },
                    { value: 'sell', label: '卖出' },
                  ]}
                />
              </Col>
              <Col xs={8} md={5}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  状态
                </Text>
                <Select
                  style={{ width: '100%' }}
                  value={status || 'all'}
                  onChange={(v) => setStatus(v === 'all' ? '' : (v as OrderStatus))}
                  options={[
                    { value: 'all', label: '全部' },
                    { value: 'submitted', label: '已报' },
                    { value: 'filled', label: '已成交' },
                    { value: 'partial', label: '部分成交' },
                    { value: 'cancelled', label: '已撤' },
                    { value: 'rejected', label: '风控拒绝' },
                    { value: 'failed', label: '失败' },
                  ]}
                />
              </Col>
              <Col xs={8} md={5}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  来源
                </Text>
                <Select
                  style={{ width: '100%' }}
                  value={source || 'all'}
                  onChange={(v) => setSource(v === 'all' ? '' : v)}
                  options={[
                    { value: 'all', label: '全部' },
                    { value: 'manual', label: '手动' },
                    { value: 'conditional', label: '条件单' },
                    { value: 'strategy', label: '策略' },
                  ]}
                />
              </Col>
              <Col xs={24} md={9}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  &nbsp;
                </Text>
                <Space wrap>
                  <Button icon={<ReloadOutlined />} onClick={() => void load()}>
                    刷新
                  </Button>
                  <Button icon={<DownloadOutlined />} onClick={handleExport} disabled={rows.length === 0}>
                    导出 CSV
                  </Button>
                  <Button icon={<DeleteOutlined />} danger onClick={() => void handlePurge()}>
                    清理 90 天前
                  </Button>
                </Space>
              </Col>
            </Row>
          </Space>
        </Card>

        {error ? <Alert type="error" showIcon message="读取交易日志失败" description={error} /> : null}

        {truncated ? (
          <Alert
            type="info"
            showIcon
            message={`结果已达 ${QUERY_LIMIT} 条上限`}
            description="为避免一次性加载过多数据导致卡顿，仅展示最近的部分记录。请缩小日期范围或精简筛选条件以查看更早的数据。"
          />
        ) : null}

        <Card size="small" bodyStyle={{ padding: isMobile ? 8 : 16 }}>
          <Table
            size="small"
            rowKey="id"
            loading={loading}
            columns={columns}
            dataSource={rows}
            scroll={{ x: 1100 }}
            pagination={{
              pageSize: 20,
              showSizeChanger: true,
              pageSizeOptions: ['20', '50', '100'],
              showTotal: (total) => `共 ${total} 条`,
              size: isMobile ? 'small' : 'default',
            }}
            locale={{
              emptyText: (
                <Empty description="没有符合条件的记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              ),
            }}
          />
        </Card>
      </Space>
    </div>
  )
}
