import { useMemo } from 'react'
import ReactECharts from 'echarts-for-react'
import type { EChartsOption } from 'echarts'
import type { FundNavPoint } from '@/lib/api/types'

export interface NavChartProps {
  points: FundNavPoint[]
  height?: number
  loading?: boolean
}

/**
 * 基金净值走势图。
 *
 * 与 K 线图分开实现的原因：
 * 基金只有单一净值序列，没有开高低收与成交量，
 * 强行复用蜡烛图组件会留下空白副图与误导性的图例。
 */
export default function NavChart({ points, height = 360, loading = false }: NavChartProps) {
  const option = useMemo<EChartsOption>(() => {
    const dates = points.map((p) => p.date)
    const navs = points.map((p) => p.nav)
    const accNavs = points.map((p) => p.acc_nav)

    const hasAcc = accNavs.some((v) => v !== null && v !== undefined)

    const series: EChartsOption['series'] = [
      {
        name: '单位净值',
        type: 'line',
        data: navs,
        smooth: false,
        showSymbol: false,
        lineStyle: { width: 1.8, color: '#1677ff' },
        areaStyle: { color: 'rgba(22,119,255,0.10)' },
      },
    ]

    if (hasAcc) {
      series.push({
        name: '累计净值',
        type: 'line',
        data: accNavs,
        smooth: false,
        showSymbol: false,
        lineStyle: { width: 1.4, color: '#f5a524' },
      })
    }

    return {
      animation: false,
      backgroundColor: 'transparent',
      legend: {
        top: 0,
        left: 0,
        itemWidth: 12,
        itemHeight: 8,
        textStyle: { fontSize: 11, color: 'rgba(128,128,128,0.95)' },
      },
      tooltip: {
        trigger: 'axis',
        confine: true,
        valueFormatter: (value) => (typeof value === 'number' ? value.toFixed(4) : String(value)),
        textStyle: { fontSize: 12 },
      },
      grid: { left: 56, right: 16, top: 30, bottom: 44 },
      xAxis: {
        type: 'category',
        data: dates,
        boundaryGap: false,
        axisLine: { lineStyle: { color: 'rgba(128,128,128,0.35)' } },
        axisLabel: { fontSize: 10, color: 'rgba(128,128,128,0.9)' },
        splitLine: { show: false },
      },
      yAxis: {
        scale: true,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { fontSize: 10, color: 'rgba(128,128,128,0.9)' },
        splitLine: { lineStyle: { color: 'rgba(128,128,128,0.15)' } },
      },
      dataZoom: [
        { type: 'inside', start: 70, end: 100 },
        {
          type: 'slider',
          bottom: 4,
          height: 16,
          start: 70,
          end: 100,
          borderColor: 'transparent',
          textStyle: { fontSize: 10 },
        },
      ],
      series,
    }
  }, [points])

  if (!loading && points.length === 0) {
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
        暂无净值数据
      </div>
    )
  }

  return (
    <ReactECharts
      option={option}
      style={{ height, width: '100%' }}
      showLoading={loading}
      loadingOption={{
        text: '加载中…',
        color: '#1677ff',
        maskColor: 'transparent',
      }}
      notMerge
      lazyUpdate
    />
  )
}
