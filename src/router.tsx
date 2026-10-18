import { createHashRouter } from 'react-router-dom'
import AppLayout from '@/layouts/AppLayout'
import DashboardPage from '@/pages/DashboardPage'
import MarketPage from '@/pages/MarketPage'
import BacktestPage from '@/pages/BacktestPage'
import TradePage from '@/pages/TradePage'
import FundPage from '@/pages/FundPage'
import SettingsPage from '@/pages/SettingsPage'

// 使用 Hash 路由：桌面端走 file:// 协议、Android 走 WebView 资源协议时都能稳定工作
export const router = createHashRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'market', element: <MarketPage /> },
      { path: 'backtest', element: <BacktestPage /> },
      { path: 'trade', element: <TradePage /> },
      { path: 'fund', element: <FundPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
])
