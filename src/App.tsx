import { useEffect } from 'react'
import { App as AntdApp, ConfigProvider, theme as antdTheme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { RouterProvider } from 'react-router-dom'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import { router } from '@/router'
import { useThemeStore } from '@/stores/theme'
import { ensureDatabase } from '@/lib/db'

dayjs.locale('zh-cn')

export default function App() {
  const mode = useThemeStore((s) => s.mode)

  useEffect(() => {
    void ensureDatabase()
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = mode
  }, [mode])

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: mode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: {
          colorPrimary: '#1677ff',
          borderRadius: 8,
          fontSize: 14,
        },
      }}
    >
      <AntdApp>
        <RouterProvider router={router} />
      </AntdApp>
    </ConfigProvider>
  )
}
