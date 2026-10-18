import { useMemo } from 'react'
import { Layout, Menu, Segmented, Space, Tooltip, Tag, Button } from 'antd'
import {
  AppstoreOutlined,
  LineChartOutlined,
  ExperimentOutlined,
  SwapOutlined,
  FundOutlined,
  SettingOutlined,
  BulbOutlined,
  MoonOutlined,
  SunOutlined,
} from '@ant-design/icons'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { usePlatform } from '@/hooks/usePlatform'
import { useThemeStore } from '@/stores/theme'

const { Sider, Content } = Layout

interface NavItem {
  key: string
  path: string
  label: string
  shortLabel: string
  icon: React.ReactNode
}

const NAV_ITEMS: NavItem[] = [
  { key: 'dashboard', path: '/', label: '工作台', shortLabel: '工作台', icon: <AppstoreOutlined /> },
  { key: 'market', path: '/market', label: '行情中心', shortLabel: '行情', icon: <LineChartOutlined /> },
  { key: 'backtest', path: '/backtest', label: '策略回测', shortLabel: '回测', icon: <ExperimentOutlined /> },
  { key: 'trade', path: '/trade', label: '交易中心', shortLabel: '交易', icon: <SwapOutlined /> },
  { key: 'fund', path: '/fund', label: '基金分析', shortLabel: '基金', icon: <FundOutlined /> },
  { key: 'settings', path: '/settings', label: '设置', shortLabel: '设置', icon: <SettingOutlined /> },
]

function currentNav(pathname: string): NavItem {
  const matched = [...NAV_ITEMS]
    .sort((a, b) => b.path.length - a.path.length)
    .find((item) => (item.path === '/' ? pathname === '/' : pathname.startsWith(item.path)))
  return matched ?? NAV_ITEMS[0]
}

function BrandBlock({ compact = false }: { compact?: boolean }) {
  return (
    <div className="qb-brand" style={compact ? { padding: '0', gap: 8 } : undefined}>
      <div className="qb-brand-logo">Q</div>
      <div>
        <div style={{ lineHeight: 1.2 }}>Qbot</div>
        {!compact && <div className="qb-brand-sub">A股 · 基金 量化工作台</div>}
      </div>
    </div>
  )
}

function RuntimeTag({ text }: { text: string }) {
  return (
    <Tag color="blue" style={{ margin: 0, fontSize: 11 }}>
      {text}
    </Tag>
  )
}

export default function AppLayout() {
  const { isMobile, runtimeText } = usePlatform()
  const navigate = useNavigate()
  const location = useLocation()
  const mode = useThemeStore((s) => s.mode)
  const setMode = useThemeStore((s) => s.setMode)

  const active = currentNav(location.pathname)
  const selectedKey = active.key

  const themeControl = useMemo(
    () => (
      <Segmented
        size="small"
        value={mode}
        onChange={(value) => setMode(value as 'light' | 'dark')}
        options={[
          { value: 'light', icon: <SunOutlined /> },
          { value: 'dark', icon: <MoonOutlined /> },
        ]}
      />
    ),
    [mode, setMode],
  )

  if (isMobile) {
    return (
      <div className="qb-shell qb-mobile">
        <div className="qb-mobile-topbar">
          <BrandBlock compact />
          <Space size={8}>
            <RuntimeTag text={runtimeText} />
            {themeControl}
          </Space>
        </div>

        <div className="qb-content">
          <Outlet />
        </div>

        <nav className="qb-bottom-nav">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`qb-bottom-nav-item${item.key === selectedKey ? ' is-active' : ''}`}
              onClick={() => navigate(item.path)}
            >
              {item.icon}
              <span>{item.shortLabel}</span>
            </button>
          ))}
        </nav>
      </div>
    )
  }

  return (
    <Layout className="qb-shell" style={{ minHeight: '100vh' }}>
      <Sider
        width={220}
        theme={mode === 'dark' ? 'dark' : 'light'}
        style={{
          background: 'var(--qb-sider-bg)',
          borderRight: '1px solid var(--qb-border)',
        }}
      >
        <BrandBlock />
        <Menu
          mode="inline"
          theme={mode === 'dark' ? 'dark' : 'light'}
          selectedKeys={[selectedKey]}
          onClick={({ key }) => {
            const target = NAV_ITEMS.find((item) => item.key === key)
            if (target) navigate(target.path)
          }}
          style={{ background: 'transparent', borderInlineEnd: 'none' }}
          items={NAV_ITEMS.map((item) => ({
            key: item.key,
            icon: item.icon,
            label: item.label,
          }))}
        />
        <div style={{ padding: '12px 16px 20px', marginTop: 'auto' }}>
          <Tooltip title={`当前运行环境：${runtimeText}`}>
            <div>
              <RuntimeTag text={runtimeText} />
            </div>
          </Tooltip>
        </div>
      </Sider>

      <Layout style={{ background: 'var(--qb-bg)' }}>
        <div className="qb-topbar">
          <div className="qb-topbar-title">{active.label}</div>
          <div className="qb-topbar-actions">
            <Button
              type="text"
              size="small"
              icon={<BulbOutlined />}
              onClick={() => navigate('/settings')}
            >
              后端连接
            </Button>
            {themeControl}
          </div>
        </div>
        <Content className="qb-content">
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}
