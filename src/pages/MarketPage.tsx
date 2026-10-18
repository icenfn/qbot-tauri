import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd'
import { DeleteOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import {
  addWatchItem,
  clearWatchlist,
  listWatchlist,
  removeWatchItem,
  type WatchItem,
} from '@/lib/db/watchlist'
import type { SymbolKind } from '@/lib/api/types'
import { usePlatform } from '@/hooks/usePlatform'

const { Text } = Typography

const KIND_LABEL: Record<SymbolKind, string> = {
  stock: 'A股',
  fund: '基金',
  index: '指数',
}

export default function MarketPage() {
  const { isMobile } = usePlatform()
  const [items, setItems] = useState<WatchItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | SymbolKind>('all')
  const [open, setOpen] = useState(false)
  const [draftSymbol, setDraftSymbol] = useState('')
  const [draftName, setDraftName] = useState('')
  const [draftKind, setDraftKind] = useState<SymbolKind>('stock')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const rows = await listWatchlist()
      setItems(rows)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleAdd = async () => {
    if (!draftSymbol.trim()) {
      message.warning('请输入标的代码')
      return
    }
    try {
      await addWatchItem({
        symbol: draftSymbol,
        name: draftName,
        kind: draftKind,
      })
      message.success('已加入自选')
      setOpen(false)
      setDraftSymbol('')
      setDraftName('')
      await refresh()
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleRemove = async (symbol: string) => {
    await removeWatchItem(symbol)
    await refresh()
  }

  const handleClear = async () => {
    await clearWatchlist()
    await refresh()
    message.success('已清空自选')
  }

  const visible = filter === 'all' ? items : items.filter((it) => it.kind === filter)

  const columns = [
    {
      title: '代码',
      dataIndex: 'symbol',
      key: 'symbol',
      render: (value: string) => <span className="qb-mono">{value}</span>,
    },
    { title: '名称', dataIndex: 'name', key: 'name', render: (v: string) => v || '—' },
    {
      title: '类型',
      dataIndex: 'kind',
      key: 'kind',
      width: 90,
      render: (v: SymbolKind) => <Tag>{KIND_LABEL[v]}</Tag>,
    },
    { title: '分组', dataIndex: 'group', key: 'group', width: 100 },
    {
      title: '操作',
      key: 'action',
      width: 90,
      render: (_: unknown, record: WatchItem) => (
        <Popconfirm title="移出自选？" onConfirm={() => handleRemove(record.symbol)}>
          <Button type="link" size="small" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      ),
    },
  ]

  return (
    <Space direction="vertical" size={isMobile ? 12 : 16} style={{ width: '100%' }}>
      <Card
        size={isMobile ? 'small' : 'default'}
        title={
          <div className="qb-card-title">
            <span>自选标的</span>
            <Tag color="default">{items.length} 个</Tag>
          </div>
        }
        extra={
          <Space size={8}>
            <Button size="small" icon={<ReloadOutlined />} onClick={refresh} loading={loading} />
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
                { label: '指数', value: 'index' },
              ]}
            />
            {items.length > 0 && (
              <Popconfirm title="确认清空全部自选？" onConfirm={handleClear}>
                <Button size="small" danger type="text">
                  清空
                </Button>
              </Popconfirm>
            )}
          </Space>

          {error && (
            <Alert type="error" showIcon message="读取本地自选失败" description={error} />
          )}

          <Alert
            type="info"
            showIcon
            message="行情与 K 线将在第二阶段接入"
            description={
              <Text type="secondary">
                第一阶段已完成自选标的的本地持久化（SQLite / 浏览器回退）。第二阶段将对接 FastAPI + AkShare
                实时行情、历史 K 线与指标图表。
              </Text>
            }
          />

          {isMobile ? (
            visible.length === 0 ? (
              <Empty description="暂无自选标的" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                {visible.map((item) => (
                  <Card key={item.symbol} size="small" styles={{ body: { padding: 12 } }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <div style={{ fontWeight: 600 }}>
                          <span className="qb-mono">{item.symbol}</span>
                          <span style={{ marginLeft: 8 }}>{item.name || '—'}</span>
                        </div>
                        <Space size={6} style={{ marginTop: 4 }}>
                          <Tag style={{ margin: 0 }}>{KIND_LABEL[item.kind]}</Tag>
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {item.group}
                          </Text>
                        </Space>
                      </div>
                      <Popconfirm title="移出自选？" onConfirm={() => handleRemove(item.symbol)}>
                        <Button type="text" danger size="small" icon={<DeleteOutlined />} />
                      </Popconfirm>
                    </div>
                  </Card>
                ))}
              </Space>
            )
          ) : (
            <Table
              size="small"
              rowKey="symbol"
              loading={loading}
              dataSource={visible}
              columns={columns}
              pagination={false}
              locale={{ emptyText: <Empty description="暂无自选标的" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
            />
          )}
        </Space>
      </Card>

      <Modal
        title="添加自选"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={handleAdd}
        okText="添加"
        cancelText="取消"
        destroyOnClose
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Segmented
            block
            value={draftKind}
            onChange={(value) => setDraftKind(value as SymbolKind)}
            options={[
              { label: 'A股', value: 'stock' },
              { label: '基金', value: 'fund' },
              { label: '指数', value: 'index' },
            ]}
          />
          <Input
            placeholder="标的代码，如 600519 / 000001 / 110022"
            value={draftSymbol}
            onChange={(e) => setDraftSymbol(e.target.value)}
            allowClear
          />
          <Input
            placeholder="名称（可留空，第二阶段将自动补全）"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            allowClear
          />
        </Space>
      </Modal>
    </Space>
  )
}
