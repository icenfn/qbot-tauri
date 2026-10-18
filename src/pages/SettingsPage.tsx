import { useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Divider,
  Form,
  Input,
  InputNumber,
  Space,
  Tag,
  Typography,
  message,
} from 'antd'
import { CheckCircleOutlined, CloseCircleOutlined, ReloadOutlined } from '@ant-design/icons'
import { api } from '@/lib/api/endpoints'
import { DEFAULT_BACKEND_URL, useSettingsStore } from '@/stores/settings'
import { fetchSystemInfo, type SystemInfo } from '@/lib/tauri/invoke'
import { isTauri } from '@/lib/tauri/env'
import { usePlatform } from '@/hooks/usePlatform'

const { Text, Paragraph } = Typography

interface FormValues {
  backendBaseUrl: string
  requestTimeoutMs: number
}

export default function SettingsPage() {
  const { isMobile, runtimeText } = usePlatform()
  const backendBaseUrl = useSettingsStore((s) => s.backendBaseUrl)
  const setBackendBaseUrl = useSettingsStore((s) => s.setBackendBaseUrl)
  const requestTimeoutMs = useSettingsStore((s) => s.requestTimeoutMs)
  const setRequestTimeoutMs = useSettingsStore((s) => s.setRequestTimeoutMs)
  const reset = useSettingsStore((s) => s.reset)

  const [form] = Form.useForm<FormValues>()
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [sysInfo, setSysInfo] = useState<SystemInfo | null>(null)
  const [sysError, setSysError] = useState<string | null>(null)

  useEffect(() => {
    form.setFieldsValue({ backendBaseUrl, requestTimeoutMs })
  }, [form, backendBaseUrl, requestTimeoutMs])

  useEffect(() => {
    if (!isTauri()) {
      setSysError('浏览器预览环境无系统信息')
      return
    }
    fetchSystemInfo()
      .then(setSysInfo)
      .catch((err: unknown) => setSysError(err instanceof Error ? err.message : String(err)))
  }, [])

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
    message.success('设置已保存')
  }

  const handleReset = () => {
    reset()
    form.setFieldsValue({ backendBaseUrl: DEFAULT_BACKEND_URL, requestTimeoutMs: 15000 })
    message.success('已恢复默认设置')
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
            <Descriptions.Item label="系统信息">
              {sysError ?? '读取中…'}
            </Descriptions.Item>
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
