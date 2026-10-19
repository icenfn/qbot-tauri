import { lazy, Suspense } from 'react'
import { createHashRouter } from 'react-router-dom'
import { Spin } from 'antd'
import AppLayout from '@/layouts/AppLayout'

/**
 * 路由级代码分割。
 *
 * 为什么必须做：此前所有页面静态导入，构建产物是单个 2.5 MB 的 chunk
 * （gzip 后仍有 808 KB）。三个后果都很实际：
 * 1. 移动端首次冷启动要等整包下载完才能看到界面，弱网下非常明显；
 * 2. 只打开行情页的用户也要下载回测、交易、资金等页面的代码；
 * 3. WebView 解析 2.5 MB JS 的耗时会被计入首屏，低端安卓机上有感。
 *
 * 改为 lazy 之后，首屏只加载「布局 + 首页」，其余页面按进入时拉取。
 * 每个页面保持独立 import 声明而不是集中在一处 map 里，
 * 这样 Vite 能静态分析出依赖边界，分包才不会互相牵连。
 */
const DashboardPage = lazy(() => import('@/pages/DashboardPage'))
const MarketPage = lazy(() => import('@/pages/MarketPage'))
const StockDetailPage = lazy(() => import('@/pages/StockDetailPage'))
const BacktestPage = lazy(() => import('@/pages/BacktestPage'))
const TradePage = lazy(() => import('@/pages/TradePage'))
const TradeLogPage = lazy(() => import('@/pages/TradeLogPage'))
const FundPage = lazy(() => import('@/pages/FundPage'))
const FundDetailPage = lazy(() => import('@/pages/FundDetailPage'))
const SettingsPage = lazy(() => import('@/pages/SettingsPage'))

/**
 * 路由切换时的占位。
 *
 * 用固定高度的居中 Spin 而不是骨架屏：懒加载通常只有几十到几百毫秒，
 * 骨架屏反而会造成「闪一下骨架再闪一下内容」的观感。
 */
function RouteFallback() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '45vh',
      }}
    >
      <Spin size="large" tip="加载中…">
        <div style={{ width: 80, height: 40 }} />
      </Spin>
    </div>
  )
}

/** 统一包裹：避免每个页面重复写 Suspense */
function withSuspense(element: React.ReactNode) {
  return <Suspense fallback={<RouteFallback />}>{element}</Suspense>
}

// 使用 Hash 路由：桌面端走 file:// 协议、Android 走 WebView 资源协议时都能稳定工作
// （History 路由在 file:// 下刷新会 404，移动端 WebView 亦不稳定）
export const router = createHashRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: withSuspense(<DashboardPage />) },
      { path: 'market', element: withSuspense(<MarketPage />) },
      { path: 'market/:symbol', element: withSuspense(<StockDetailPage />) },
      { path: 'backtest', element: withSuspense(<BacktestPage />) },
      { path: 'trade', element: withSuspense(<TradePage />) },
      { path: 'trade-log', element: withSuspense(<TradeLogPage />) },
      { path: 'fund', element: withSuspense(<FundPage />) },
      { path: 'fund/:code', element: withSuspense(<FundDetailPage />) },
      { path: 'settings', element: withSuspense(<SettingsPage />) },
    ],
  },
])
