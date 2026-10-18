import { useEffect, useState } from 'react'
import { Alert, Badge, Card, Col, Descriptions, Row, Space, Spin, Statistic, Tag, Typography } from 'antd'
import { api } from '@/lib/api/endpoints'
import type { HealthResponse } from '@/lib/api/types'
import { useSettingsStore } from '@/stores/settings'
import { usePlatform } from '@/hooks/usePlatform'

const { Paragraph, Text } = Typography

const STAGES = [
  { key: 'Phase 1', title: '基础框架', desc: 'Tauri 2 三端骨架 · FastAPI 服务 · SQLite 存储 · 导航与主题', done: true },
  { key: 'Phase 2', title: '数据中心', desc: 'AkShare 接入 · 行情看板 · K线/净值图 · 自选管理', done: false },
  { key: 'Phase 3', title: '策略与回测', desc: '指标库 · 策略模板 · 回测引擎 · 绩效分析 · 参数优化', done: false },
  { key: 'Phase 4', title: '基金 · 实盘 · 风控', desc: '基金分析 · 交易网关 · 条件单 · 风控 · 本地通知', done: false },
  { key: 'Phase 5', title: '优化完善', desc: '性能 · 体验 · 交易日志 · 行情自动更新', done: false },
]

export default function DashboardPage() {
  const backendBaseUrl = useSettingsStore((s) => s.backendBaseUrl)
  const { runtimeText, isMobile } = usePlatform()
  const [loading, setLoading] = useState(false)
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .health({ timeoutMs: 6000 })
      .then((res) => {
        if (!cancelled) setHealth(res)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [backendBaseUrl])

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        size={isMobile ? 'small' : 'default'}
        title={
          <div className="qb-card-title">
            <span>Qbot 量化工作台</span>
            <Tag color="processing">第一阶段 · 基础框架</Tag>
          </div>
        }
      >
        <Paragraph style={{ marginBottom: 12, color: 'var(--qb-text-secondary)' }}>
          面向国内市场 A 股与基金的跨平台量化工作台，Tauri 2 统一交付
          Linux / Windows / Android 三端。当前为第一阶段交付：应用骨架、导航、主题、后端连通性与本地存储。
        </Paragraph>
        <Descriptions size="small" column={isMobile ? 1 : 2} bordered>
          <Descriptions.Item label="运行环境">{runtimeText}</Descriptions.Item>
          <Descriptions.Item label="后端地址">{backendBaseUrl}</Descriptions.Item>
          <Descriptions.Item label="数据源">AkShare（经 FastAPI 转发）</Descriptions.Item>
          <Descriptions.Item label="覆盖市场">A 股 · 场内/场外基金</Descriptions.Item>
        </Descriptions>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} md={12}>
          <Card size={isMobile ? 'small' : 'default'} title="后端服务状态">
            {loading ? (
              <Space>
                <Spin size="small" />
                <Text type="secondary">正在连接 FastAPI 服务…</Text>
              </Space>
            ) : health ? (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Badge status="success" text={`服务正常 · ${health.service} v${health.version}`} />
                <Text type="secondary">
                  AkShare 可用性：
                  {health.akshare_available ? (
                    <Text type="success">已安装</Text>
                  ) : (
                    <Text type="warning">未安装（pip install akshare）</Text>
                  )}
                </Text>
                <Text type="secondary">服务器时间：{health.time}</Text>
              </Space>
            ) : (
              <Alert
                type="warning"
                showIcon
                message="无法连接后端服务"
                description={
                  <div>
                    <div>{error}</div>
                    <div style={{ marginTop: 6 }}>
                      请先启动后端：<Text code>python -m uvicorn app.main:app --app-dir backend --port 8000</Text>
                      ，或在「设置」中修改后端地址（Android 需填写局域网 IP）。
                    </div>
                  </div>
                }
              />
            )}
          </Card>
        </Col>

        <Col xs={24} md={12}>
          <Card size={isMobile ? 'small' : 'default'} title="第一阶段能力">
            <Row gutter={[12, 12]}>
              <Col span={12}>
                <Statistic title="目标平台" value={3} suffix="端" />
              </Col>
              <Col span={12}>
                <Statistic title="本地数据表" value={4} suffix="张" />
              </Col>
            </Row>
            <Paragraph style={{ marginTop: 12, marginBottom: 0, color: 'var(--qb-text-secondary)' }}>
              已启用插件：SQLite 存储、文件系统、对话框、通知、HTTP、外部打开。Rust 侧注册系统信息与本地健康检查命令。
            </Paragraph>
          </Card>
        </Col>
      </Row>

      <Card size={isMobile ? 'small' : 'default'} title="开发路线">
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          {STAGES.map((stage) => (
            <div key={stage.key} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <Tag color={stage.done ? 'success' : 'default'} style={{ minWidth: 68, textAlign: 'center' }}>
                {stage.key}
              </Tag>
              <div>
                <div style={{ fontWeight: 600 }}>
                  {stage.title}
                  {stage.done && <Tag color="success" style={{ marginLeft: 8 }}>已完成</Tag>}
                </div>
                <div style={{ fontSize: 12, color: 'var(--qb-text-secondary)' }}>{stage.desc}</div>
              </div>
            </div>
          ))}
        </Space>
      </Card>
    </Space>
  )
}
