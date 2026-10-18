import { Card, Space, Tag, Typography } from 'antd'
import { usePlatform } from '@/hooks/usePlatform'

const { Paragraph } = Typography

export default function FundPage() {
  const { isMobile } = usePlatform()

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        size={isMobile ? 'small' : 'default'}
        title={
          <div className="qb-card-title">
            <span>基金分析</span>
            <Tag color="orange">第四阶段交付</Tag>
          </div>
        }
      >
        <Paragraph style={{ color: 'var(--qb-text-secondary)', marginBottom: 0 }}>
          覆盖场外与场内基金：基金筛选、净值走势、持仓与经理信息、组合相关性与风险分析、定投回测、综合评级与排行榜。数据统一由 FastAPI + AkShare 提供，三端一致。
        </Paragraph>
      </Card>

      <Card size={isMobile ? 'small' : 'default'} title="第四阶段交付清单">
        <ul className="qb-roadmap">
          <li>基金筛选：按类型、规模、区间收益、最大回撤、费率筛选</li>
          <li>基金详情：净值曲线、阶段业绩、持仓明细、基金经理、规模变动</li>
          <li>组合分析：多基金组合收益、波动、相关性矩阵、资产配置</li>
          <li>定投回测：定期定额、均线偏离法、估值分位法</li>
          <li>基金评级与排行榜：夏普、回撤、收益综合打分</li>
        </ul>
      </Card>
    </Space>
  )
}
