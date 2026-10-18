import { useEffect, useMemo, useRef } from 'react'
import ReactECharts from 'echarts-for-react'
import type { EChartsOption } from 'echarts'
import type { KlineBar } from '@/lib/api/types'

export interface KlineChartProps {
  bars: KlineBar[]
  height?: number
  /** 是否叠加 MA5 / MA10 / MA20 */
  showMA?: boolean
  /** 是否为基金净值模式（用折线代替蜡烛图） */
  mode?: 'candle' | 'line'
  loading?: boolean
}

/** 简单移动平均，仅在展示层使用；正式指标库在第三阶段由 Rust 实现 */
function movingAverage(values: number[], window: number): (number | null)[] {
  const result: (number | null)[] = []
  let sum = 0
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i]
    if (i >= window) sum -= values[i - window]
    result.push(i >= window - 1 ? sum / window : null)
  }
  return result
}

/**
 * K 线 / 净值图表。
 *
 * 使用 ECharts candlestick + 双联图（价格 + 成交量）。
 * 三端渲染一致：Windows/Android 为 Chromium 内核，Linux 为 WebKitGTK，
 * 因此不使用 WebGL 扩展，仅使用 Canvas 渲染器。
 */
export default function KlineChart({
  bars,
  height = 420,
  showMA = true,
  mode = 'candle',
  loading = false,
}: KlineChartProps) {
  const chartRef = useRef<ReactECharts>(null)

  const option = useMemo<EChartsOption>(() => {
    const dates = bars.map((b) => b.date)
    const closes = bars.map((b) => b.close)
    const volumes = bars.map((b, i) => ({
      value: b.volume,
      itemStyle: {
        color: i > 0 && b.close < bars[i - 1].close ? 'rgba(18,161,80,0.55)' : 'rgba(229,72,77,0.55)',
      },
    }))

    const ma5 = movingAverage(closes, 5)
    const ma10 = movingAverage(closes, 10)
    const ma20 = movingAverage(closes, 20)

    const upColor = '#e5484d'
    const downColor = '#12a150'

    const series: EChartsOption['series'] = []

    if (mode === 'candle') {
      series.push({
        name: 'K线',
        type: 'candlestick',
        data: bars.map((b) => [b.open, b.close, b.low, b.high]),
        itemStyle: {
          color: upColor,
          color0: downColor,
          borderColor: upColor,
          borderColor0: downColor,
        },
      })
    } else {
      series.push({
        name: '净值',
        type: 'line',
        data: closes,
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 2, color: '#1677ff' },
        areaStyle: { color: 'rgba(22,119,255,0.10)' },
      })
    }

    if (showMA && mode === 'candle') {
      series.push(
        {
          name: 'MA5',
          type: 'line',
          data: ma5,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 1, color: '#f5a524' },
        },
        {
          name: 'MA10',
          type: 'line',
          data: ma10,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 1, color: '#1677ff' },
        },
        {
          name: 'MA20',
          type: 'line',
          data: ma20,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 1, color: '#b45cff' },
        },
      )
    }

    series.push({
      name: '成交量',
      type: 'bar',
      xAxisIndex: 1,
      yAxisIndex: 1,
      data: volumes,
    })

    return {
      animation: false,
      backgroundColor: 'transparent',
      legend: {
        top: 0,
        left: 0,
        itemWidth: 12,
        itemHeight: 8,
        textStyle: { fontSize: 11, color: 'var(--qb-text-secondary)' as unknown as string },
        data: mode === 'candle' ? ['MA5', 'MA10', 'MA20'] : [],
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        confine: true,
        textStyle: { fontSize: 12 },
      },
      axisPointer: {
        link: [{ xAxisIndex: 'all' }],
      },
      grid: [
        { left: 52, right: 16, top: 28, height: '58%' },
        { left: 52, right: 16, top: '74%', height: '16%' },
      ],
      xAxis: [
        {
          type: 'category',
          data: dates,
          boundaryGap: true,
          axisLine: { lineStyle: { color: 'rgba(128,128,128,0.35)' } },
          axisLabel: { fontSize: 10, color: 'rgba(128,128,128,0.9)' },
          splitLine: { show: false },
        },
        {
          type: 'category',
          gridIndex: 1,
          data: dates,
          boundaryGap: true,
          axisLine: { lineStyle: { color: 'rgba(128,128,128,0.35)' } },
          axisLabel: { show: false },
          axisTick: { show: false },
          splitLine: { show: false },
        },
      ],
      yAxis: [
        {
          scale: true,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { fontSize: 10, color: 'rgba(128,128,128,0.9)' },
          splitLine: { lineStyle: { color: 'rgba(128,128,128,0.15)' } },
        },
        {
          gridIndex: 1,
          scale: true,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { show: false },
          splitLine: { show: false },
        },
      ],
      dataZoom: [
        { type: 'inside', xAxisIndex: [0, 1], start: 60, end: 100 },
        {
          type: 'slider',
          xAxisIndex: [0, 1],
          bottom: 0,
          height: 16,
          start: 60,
          end: 100,
          borderColor: 'transparent',
          textStyle: { fontSize: 10 },
        },
      ],
      series,
    }
  }, [bars, showMA, mode])

  // bars 变化时重置缩放窗口，避免从上个标的继承
  useEffect(() => {
    chartRef.current?.getEchartsInstance().resize()
  }, [bars])

  if (!loading && bars.length === 0) {
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
        暂无数据
      </div>
    )
  }

  return (
    <ReactECharts
      ref={chartRef}
      option={option}
      style={{ height, width: '100%' }}
      showLoading={loading}
      loadingOption={{
        text: '加载中…',
        color: '#1677ff',
        textColor: 'var(--qb-text-secondary)' as unknown as string,
        maskColor: 'transparent',
      }}
      notMerge
      lazyUpdate
    />
  )
}
