import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Divider,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Space,
  Tag,
  Typography,
  message,
} from 'antd'
import { CheckCircleOutlined, CloseCircleOutlined, ReloadOutlined } from '@ant-design/icons'
import { api } from '@/lib/api/endpoints'
import {
  DEFAULT_BACKEND_URL,
  DEFAULT_CACHE_KEEP_DAYS,
  DEFAULT_QUOTE_REFRESH_MS,
  DEFAULT_TRADE_POLL_MS,
  QUOTE_REFRESH_OPTIONS,
  TRADE_POLL_OPTIONS,
  useSettingsStore,
} from '@/stores/settings'
import { fetchSystemInfo, type SystemInfo } from '@/lib/tauri/invoke'
import { isTauri } from '@/lib/tauri/env'
import { usePlatform } from '@/hooks/usePlatform'
import { cacheStats, clearAllCache, pruneCache } from '@/lib/db/klineCache'

const { Text, Paragraph } = Typography

interface FormValues {
  backendBaseUrl: string
  requestTimeoutMs: number
  quoteRefreshMs: number
  tradePollMs: number
  cacheKeepDays: number
}

/** 把毫秒渲染成易读文案，用于表格与提示 */
function humanMs(ms: number): string {
  if (ms <= 0) return '关闭'
  if (ms < 1000) return `${ms} 毫秒`
  if (ms % 60000 === 0) return `${ms / 60000} 分钟`
  return `${ms / 1000} 秒`
}

export default function SettingsPage() {
  const { isMobile, runtimeText } = usePlatform()
  const backendBaseUrl = useSettingsStore((s) => s.backendBaseUrl)
  const setBackendBaseUrl = useSettingsStore((s) => s.setBackendBaseUrl)
  const requestTimeoutMs = useSettingsStore((s) => s.requestTimeoutMs)
  const setRequestTimeoutMs = useSettingsStore((s) => s.setRequestTimeoutMs)
  const quoteRefreshMs = useSettingsStore((s) => s.quoteRefreshMs)
  const setQuoteRefreshMs = useSettingsStore((s) => s.setQuoteRefreshMs)
  const tradePollMs = useSettingsStore((s) => s.tradePollMs)
  const setTradePollMs = useSettingsStore((s) => s.setTradePollMs)
  const cacheKeepDays = useSettingsStore((s) => s.cacheKeepDays)
  const setCacheKeepDays = useSettingsStore((s) => s.setCacheKeepDays)
  const reset = useSettingsStore((s) => s.reset)

  const [form] = Form.useForm<FormValues>()
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [sysInfo, setSysInfo] = useState<SystemInfo | null>(null)
  const [sysError, setSysError] = useState<string | null>(null)

  // 缓存统计
  const [cache, setCache] = useState<{ count: number; oldest: string | null } | null>(null)
  const [cacheBusy, setCacheBusy] = useState(false)

  useEffect(() => {
    form.setFieldsValue({
      backendBaseUrl,
      requestTimeoutMs,
      quoteRefreshMs,
      tradePollMs,
      cacheKeepDays,
    })
  }, [form, backendBaseUrl, requestTimeoutMs, quoteRefreshMs, tradePollMs, cacheKeepDays])

  useEffect(() => {
    if (!isTauri()) {
      setSysError('浏览器预览环境无系统信息')
      return
    }
    fetchSystemInfo()
      .then(setSysInfo)
      .catch((err: unknown) => setSysError(err instanceof Error ? err.message : String(err)))
  }, [])

  const refreshCacheStats = useCallback(async () => {
    try {
      setCache(await cacheStats())
    } catch {
      setCache(null)
    }
  }, [])

  useEffect(() => {
    void refreshCacheStats()
  }, [refreshCacheStats])

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await api.health({ timeoutMs: 6000 })
      setTestResult({
        ok: true,
        text: `连接成功 · ${res.service} v${res.version} · AkShare ${
          res.akshare_available ? '可用' : '未安装'
        }`,
      })
    } catch (err) {
      setTestResult({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    const values = await form.validateFields()
    setBackendBaseUrl(values.backendBaseUrl)
    setRequestTimeoutMs(values.requestTimeoutMs)
    setQuoteRefreshMs(values.quoteRefreshMs)
    setTradePollMs(values.tradePollMs)
    setCacheKeepDays(values.cacheKeepDays)
    message.success('设置已保存')
    // 保存后按新策略立刻清理一次，让「保留天数」马上生效而不是等下次启动
    if (values.cacheKeepDays > 0) {
      setCacheBusy(true)
      try {
        const removed = await pruneCache(values.cacheKeepDays)
        if (removed > 0) message.info(`已按新策略清理 ${removed} 条过期缓存`)
        await refreshCacheStats()
      } finally {
        setCacheBusy(false)
      }
    }
  }

  const handleReset = () => {
    reset()
    form.setFieldsValue({
      backendBaseUrl: DEFAULT_BACKEND_URL,
      requestTimeoutMs: 15000,
      quoteRefreshMs: DEFAULT_QUOTE_REFRESH_MS,
      tradePollMs: DEFAULT_TRADE_POLL_MS,
      cacheKeepDays: DEFAULT_CACHE_KEEP_DAYS,
    })
    message.success('已恢复默认设置')
  }

  const handlePrune = async () => {
    const days = form.getFieldValue('cacheKeepDays') as number
    if (!days || days <= 0) {
      message.warning('请先设置大于 0 的保留天数')
      return
    }
    setCacheBusy(true)
    try {
      const removed = await pruneCache(days)
      message.success(removed > 0 ? `已清理 ${removed} 条过期缓存` : '没有需要清理的缓存')
      await refreshCacheStats()
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setCacheBusy(false)
    }
  }

  const handleClearAll = async () => {
    setCacheBusy(true)
    try {
      await clearAllCache()
      message.success('行情缓存已清空，下次打开将重新拉取')
      await refreshCacheStats()
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setCacheBusy(false)
    }
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card size={isMobile ? 'small' : 'default'} title="后端服务">
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item
            label="FastAPI 服务地址"
            name="backendBaseUrl"
            extra="Windows / Linux 一般使用 http://127.0.0.1:8000；Android 真机需填写同一局域网内电脑的 IP，如 http://192.168.1.10:8000"
            rules={[{ required: true, message: '请输入后端地址' }]}
          >
            <Input placeholder="http://127.0.0.1:8000" allowClear />
          </Form.Item>
          <Form.Item
            label="请求超时（毫秒）"
            name="requestTimeoutMs"
            rules={[{ required: true, message: '请输入超时时间' }]}
            extra="AkShare 首次拉取历史数据可能较慢，局域网建议不低于 10000"
          >
            <InputNumber min={3000} max={120000} step={1000} style={{ width: '100%' }} />
          </Form.Item>
          <Space wrap>
            <Button type="primary" onClick={handleSave}>
              保存
            </Button>
            <Button icon={<ReloadOutlined />} loading={testing} onClick={handleTest}>
              测试连接
            </Button>
            <Button onClick={handleReset}>恢复默认</Button>
          </Space>
        </Form>

        {testResult && (
          <Alert
            style={{ marginTop: 12 }}
            type={testResult.ok ? 'success' : 'error'}
            showIcon
            icon={testResult.ok ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
            message={testResult.ok ? '连接正常' : '连接失败'}
            description={testResult.text}
          />
        )}

        <Paragraph style={{ marginTop: 12, marginBottom: 0, color: 'var(--qb-text-secondary)' }}>
          启动后端命令：<Text code>python -m uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port 8000</Text>
        </Paragraph>
      </Card>

      {/* 刷新策略：直接影响流量与电量，移动端尤其需要可调 */}
      <Card size={isMobile ? 'small' : 'default'} title="自动刷新">
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item
            label="行情刷新间隔"
            name="quoteRefreshMs"
            extra="仅交易时段按此间隔刷新；非交易时段行情不变，会自动放宽到 60 秒以省流量。页面切到后台时暂停，切回后立即补刷一次。"
          >
            <Select style={{ width: '100%' }} options={QUOTE_REFRESH_OPTIONS.map((o) => ({ ...o }))} />
          </Form.Item>
          <Form.Item
            label="条件单轮询间隔"
            name="tradePollMs"
            extra="交易中心按此间隔检查条件单是否触发。间隔越短越及时，但请求更频繁；「关闭」后仅在手动操作时评估。"
          >
            <Select style={{ width: '100%' }} options={TRADE_POLL_OPTIONS.map((o) => ({ ...o }))} />
          </Form.Item>
          <Space wrap>
            <Button type="primary" onClick={handleSave}>
              保存
            </Button>
            <Text type="secondary" style={{ fontSize: 12 }}>
              当前：行情 {humanMs(quoteRefreshMs)} · 条件单 {humanMs(tradePollMs)}
            </Text>
          </Space>
        </Form>
      </Card>

      {/* 缓存管理：K 线缓存会随浏览不断增长，需要可见的清理入口 */}
      <Card
        size={isMobile ? 'small' : 'default'}
        title="本地缓存"
        extra={
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void refreshCacheStats()}>
            刷新
          </Button>
        }
      >
        <Descriptions size="small" column={1} bordered>
          <Descriptions.Item label="缓存条数">
            {cache ? `${cache.count} 条` : '读取中…'}
          </Descriptions.Item>
          <Descriptions.Item label="最早缓存">
            {cache?.oldest ? cache.oldest.replace('T', ' ').slice(0, 19) : '—'}
          </Descriptions.Item>
          <Descriptions.Item label="存储位置">
            <span className="qb-mono" style={{ fontSize: 12 }}>
              {isTauri() ? 'SQLite · kline_cache 表' : '浏览器 localStorage'}
            </span>
          </Descriptions.Item>
        </Descriptions>

        <Divider style={{ margin: '12px 0' }} />

        <Form form={form} layout="inline" requiredMark={false}>
          <Form.Item label="保留天数" name="cacheKeepDays" style={{ marginBottom: 8 }}>
            <InputNumber min={0} max={365} step={1} style={{ width: 100 }} />
          </Form.Item>
          <Form.Item style={{ marginBottom: 8 }}>
            <Space wrap>
              <Button loading={cacheBusy} onClick={() => void handlePrune()}>
                按策略清理
              </Button>
              <Popconfirm
                title="清空全部行情缓存？"
                description="下次打开个股/基金详情会重新向后端拉取，首次会稍慢。"
                onConfirm={() => void handleClearAll()}
              >
                <Button danger loading={cacheBusy}>
                  清空全部
                </Button>
              </Popconfirm>
            </Space>
          </Form.Item>
        </Form>

        <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0, marginTop: 8 }}>
          填 0 表示不自动清理。K 线按「标的 × 周期 × 复权」组合缓存，长期使用后会积累较多陈旧记录，
          建议保留 7 天即可覆盖绝大多数回看需求。
        </Paragraph>
      </Card>

      <Card size={isMobile ? 'small' : 'default'} title="运行环境">
        <Descriptions size="small" column={1} bordered>
          <Descriptions.Item label="UI 环境">{runtimeText}</Descriptions.Item>
          {sysInfo ? (
            <>
              <Descriptions.Item label="应用">
                {sysInfo.appName} v{sysInfo.version}
              </Descriptions.Item>
              <Descriptions.Item label="Tauri 版本">{sysInfo.tauriVersion}</Descriptions.Item>
              <Descriptions.Item label="系统">
                {sysInfo.platform} / {sysInfo.arch} / {sysInfo.family}
              </Descriptions.Item>
              <Descriptions.Item label="移动端标识">
                <Tag color={sysInfo.isMobile ? 'green' : 'default'}>
                  {sysInfo.isMobile ? '移动端' : '桌面端'}
                </Tag>
                {sysInfo.debugBuild && <Tag color="blue">Debug</Tag>}
              </Descriptions.Item>
              <Descriptions.Item label="数据目录">
                <span className="qb-mono" style={{ fontSize: 12 }}>
                  {sysInfo.dataDir ?? '不可用'}
                </span>
              </Descriptions.Item>
            </>
          ) : (
            <Descriptions.Item label="系统信息">{sysError ?? '读取中…'}</Descriptions.Item>
          )}
        </Descriptions>

        <Divider style={{ margin: '12px 0' }} />
        <Text type="secondary" style={{ fontSize: 12 }}>
          三端统一：同一套前端代码 + 同一套 Rust 核心 + 同一个 FastAPI 数据服务。移动端与桌面端仅在后端地址与并发度上存在差异。
        </Text>
      </Card>
    </Space>
  )
}
