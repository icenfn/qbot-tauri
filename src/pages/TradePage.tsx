import { Card, Descriptions, Space, Tag, Typography } from 'antd'
import { usePlatform } from '@/hooks/usePlatform'

const { Paragraph, Text } = Typography

export default function TradePage() {
  const { isMobile } = usePlatform()

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        size={isMobile ? 'small' : 'default'}
        title={
          <div className="qb-card-title">
            <span>交易中心</span>
            <Tag color="orange">第四阶段交付</Tag>
          </div>
        }
      >
        <Paragraph style={{ color: 'var(--qb-text-secondary)' }}>
          采用「网络网关模式」：三端统一通过 REST / WebSocket 连接用户自建的交易网关服务，不在本地加载券商
          DLL，因此 Linux、Windows、Android 能力一致。
        </Paragraph>
        <Descriptions size="small" column={1} bordered>
          <Descriptions.Item label="A股通道">交易网关 HTTP API（vnpy 网关或自建服务）</Descriptions.Item>
          <Descriptions.Item label="基金通道">基金销售 / 定投服务 API</Descriptions.Item>
          <Descriptions.Item label="委托类型">限价单、市价单、撤单、条件单</Descriptions.Item>
          <Descriptions.Item label="风控前置">仓位上限、止损止盈、回撤熔断、频率限制、黑名单</Descriptions.Item>
        </Descriptions>
      </Card>

      <Card size={isMobile ? 'small' : 'default'} title="账户状态">
        <Text type="secondary">
          尚未配置交易网关。第四阶段将提供：网关地址与密钥配置、账户与持仓同步、下单与撤单、条件单监控、策略自动交易开关、完整交易日志。
        </Text>
      </Card>
    </Space>
  )
}
