import { Card, List, Space, Tag, Typography } from 'antd'
import { usePlatform } from '@/hooks/usePlatform'

const { Paragraph, Text } = Typography

const STRATEGIES = [
  { name: '双均线策略', target: 'A股', desc: '快慢均线金叉买入、死叉卖出' },
  { name: 'MACD 策略', target: 'A股', desc: 'DIF 上穿 DEA 买入，下穿卖出' },
  { name: 'KDJ 策略', target: 'A股', desc: '超卖区金叉买入，超买区死叉卖出' },
  { name: '布林带策略', target: 'A股', desc: '触下轨买入，触上轨卖出' },
  { name: '海龟交易法则', target: 'A股', desc: '唐奇安通道突破 + ATR 仓位管理' },
  { name: '网格交易', target: 'A股', desc: '区间内按网格分批低买高卖' },
  { name: '定期定额定投', target: '基金', desc: '固定周期固定金额申购' },
  { name: '智能定投', target: '基金', desc: '均线偏离或估值分位动态调整投入金额' },
]

export default function BacktestPage() {
  const { isMobile } = usePlatform()

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card size={isMobile ? 'small' : 'default'} title="策略回测工作台">
        <Paragraph style={{ color: 'var(--qb-text-secondary)', marginBottom: 0 }}>
          第一阶段完成页面骨架与导航占位。第三阶段将落地 Rust 事件驱动回测引擎（逐 Bar
          撮合、手续费与滑点模拟）、30+ 技术指标、绩效指标计算与可视化报告。
        </Paragraph>
      </Card>

      <Card size={isMobile ? 'small' : 'default'} title="规划中的策略模板">
        <List
          dataSource={STRATEGIES}
          renderItem={(item) => (
            <List.Item>
              <List.Item.Meta
                title={
                  <Space size={8} wrap>
                    <span>{item.name}</span>
                    <Tag color={item.target === '基金' ? 'green' : 'blue'}>{item.target}</Tag>
                    <Tag color="default">待实现</Tag>
                  </Space>
                }
                description={<Text type="secondary">{item.desc}</Text>}
              />
            </List.Item>
          )}
        />
      </Card>

      <Card size={isMobile ? 'small' : 'default'} title="第三阶段交付清单">
        <ul className="qb-roadmap">
          <li>技术指标库：EMA / MACD / KDJ / RSI / BOLL / OBV / SAR / DMI / CCI / ROC 等</li>
          <li>事件驱动回测引擎：日线 / 分钟线逐 Bar 撮合，支持佣金、印花税、过户费、滑点</li>
          <li>绩效报告：年化收益、累计收益、最大回撤、夏普、索提诺、胜率、盈亏比</li>
          <li>可视化：资金曲线、回撤曲线、收益分布、K 线买卖点标记</li>
          <li>参数优化：网格搜索 + 并行计算（移动端限流）</li>
        </ul>
      </Card>
    </Space>
  )
}
