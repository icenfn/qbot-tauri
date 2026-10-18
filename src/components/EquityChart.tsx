import { useMemo } from 'react'
import ReactECharts from 'echarts-for-react'
import type { EChartsOption } from 'echarts'
import type { EquityPoint } from '@/lib/quant/types'

export interface EquityChartProps {
  points: EquityPoint[]
  height?: number
  /** 初始资金，用于画基准线 */
  initialCash?: number
  /** 是否叠加「买入持有」基准（用收盘价归一化） */
  showBenchmark?: boolean
}

/**
 * 权益 / 回撤双联图。
 *
 * 上图：策略总资产曲线（可叠加买入持有基准，都已归一化为初始资金的倍数收益）；
 * 下图：回撤曲线（负值填充）。
 *
 * 基准归一化处理：直接用 `close[0]` 做分母换算成「同样投入初始资金」的资产，
 * 这样两条线的纵轴单位一致，比较才成立。
 */
export default function EquityChart({
  points,
  height = 320,
  initialCash,
  showBenchmark = true,
}: EquityChartProps) {
  const option = useMemo<EChartsOption>(() => {
    const dates = points.map((p) => p.date)
    const equity = points.map((p) => Number(p.equity.toFixed(2)))
    const drawdown = points.map((p) => Number((p.drawdown * 100).toFixed(3)))

    const base = initialCash ?? points[0]?.equity ?? 1

    // 买入持有基准：以首根收盘价为基准折算成同一起始资金
    let benchmark: number[] = []
    if (showBenchmark && points.length > 0) {
      const firstClose = points[0].close
      if (firstClose > 0) {
        benchmark = points.map((p) => Number(((p.close / firstClose) * base).toFixed(2)))
      }
    }

    const series: EChartsOption['series'] = [
      {
        name: '策略权益',
        type: 'line',
        data: equity,
        smooth: false,
        showSymbol: false,
        lineStyle: { width: 2, color: '#1677ff' },
        areaStyle: { color: 'rgba(22,119,255,0.08)' },
      },
    ]

    if (benchmark.length > 0) {
      series.push({
        name: '买入持有',
        type: 'line',
        data: benchmark,
        smooth: false,
        showSymbol: false,
        lineStyle: { width: 1, color: '#8c8c8c', type: 'dashed' },
      })
    }

    series.push({
      name: '回撤',
      type: 'line',
      xAxisIndex: 1,
      yAxisIndex: 1,
      data: drawdown,
      smooth: false,
      showSymbol: false,
      lineStyle: { width: 1, color: '#e5484d' },
      areaStyle: { color: 'rgba(229,72,77,0.15)' },
    })

    return {
      animation: false,
      backgroundColor: 'transparent',
      legend: {
        top: 0,
        left: 0,
        itemWidth: 12,
        itemHeight: 8,
        textStyle: { fontSize: 11 },
        data: showBenchmark ? ['策略权益', '买入持有'] : ['策略权益'],
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        confine: true,
        textStyle: { fontSize: 12 },
      },
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      grid: [
        { left: 56, right: 16, top: 30, height: '52%' },
        { left: 56, right: 16, top: '72%', height: '18%' },
      ],
      xAxis: [
        {
          type: 'category',
          data: dates,
          boundaryGap: false,
          axisLine: { lineStyle: { color: 'rgba(128,128,128,0.35)' } },
          axisLabel: { fontSize: 10 },
          splitLine: { show: false },
        },
        {
          type: 'category',
          gridIndex: 1,
          data: dates,
          boundaryGap: false,
          axisLine: { lineStyle: { color: 'rgba(128,128,128,0.35)' } },
          axisLabel: { show: false },
          axisTick: { show: false },
          splitLine: { show: false },
        },
      ],
      yAxis: [
        {
          type: 'value',
          scale: true,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: {
            fontSize: 10,
            formatter: (v: number) => (v >= 10000 ? `${(v / 10000).toFixed(0)}万` : `${v}`),
          },
          splitLine: { lineStyle: { color: 'rgba(128,128,128,0.15)' } },
        },
        {
          type: 'value',
          gridIndex: 1,
          scale: false,
          min: -100,
          max: 0,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { fontSize: 10, formatter: '{value}%' },
          splitLine: { lineStyle: { color: 'rgba(128,128,128,0.15)' } },
        },
      ],
      series,
    }
  }, [points, initialCash, showBenchmark])

  if (points.length === 0) {
    return (
      <div
        style={{
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--qb-text-secondary)',
          fontSize: 13,
        }}
      >
        暂无回测结果
      </div>
    )
  }

  return (
    <ReactECharts
      option={option}
      style={{ height, width: '100%' }}
      notMerge
      lazyUpdate
      opts={{ renderer: 'canvas' }}
    />
  )
}
