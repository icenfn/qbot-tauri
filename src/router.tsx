import { createHashRouter } from 'react-router-dom'
import AppLayout from '@/layouts/AppLayout'
import DashboardPage from '@/pages/DashboardPage'
import MarketPage from '@/pages/MarketPage'
import StockDetailPage from '@/pages/StockDetailPage'
import BacktestPage from '@/pages/BacktestPage'
import TradePage from '@/pages/TradePage'
import FundPage from '@/pages/FundPage'
import FundDetailPage from '@/pages/FundDetailPage'
import SettingsPage from '@/pages/SettingsPage'

// 使用 Hash 路由：桌面端走 file:// 协议、Android 走 WebView 资源协议时都能稳定工作
// （History 路由在 file:// 下刷新会 404，移动端 WebView 亦不稳定）
export const router = createHashRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'market', element: <MarketPage /> },
      { path: 'market/:symbol', element: <StockDetailPage /> },
      { path: 'backtest', element: <BacktestPage /> },
      { path: 'trade', element: <TradePage /> },
      { path: 'fund', element: <FundPage /> },
      { path: 'fund/:code', element: <FundDetailPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
])
