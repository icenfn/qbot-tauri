import { Typography } from 'antd'
import { changeClass, formatChange, formatPercent } from '@/lib/format'

const { Text } = Typography

export interface ChangeTextProps {
  change?: number | null
  changePct?: number | null
  /** 只显示百分比 */
  percentOnly?: boolean
  /** 字号，默认继承 */
  size?: number
  strong?: boolean
}

/** 统一的涨跌展示：A 股惯例「涨红跌绿」，并带正负号。 */
export default function ChangeText({
  change,
  changePct,
  percentOnly = false,
  size,
  strong = false,
}: ChangeTextProps) {
  const cls = changeClass(changePct ?? change)
  const content = percentOnly
    ? formatPercent(changePct)
    : `${formatChange(change)} ${formatPercent(changePct)}`

  return (
    <Text
      className={cls}
      strong={strong}
      style={size ? { fontSize: size } : undefined}
      // 使用 var 变量，跟随主题
    >
      {content}
    </Text>
  )
}
