import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

// Tauri injects TAURI_DEV_HOST when developing against a physical mobile device.
const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: {
      // Rust 侧由 tauri cli 自己监听，避免重复触发前端热更新
      ignored: ['**/src-tauri/**', '**/backend/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    // Android 使用系统 WebView(Chromium)，Windows 使用 WebView2，Linux 使用 WebKitGTK
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: process.env.TAURI_ENV_DEBUG ? false : 'esbuild',
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        /**
         * 手工分包。
         *
         * 路由懒加载只能解决「不同页面」之间的切分，但 echarts、antd 这些
         * 体积大且几乎每页都用到的依赖会被重复打进多个页面 chunk，或者
         * 全部挤进最大的那个页面 —— 两种都不理想。
         *
         * 这里按「升级频率」而不是「功能归属」分层：
         * - charts（echarts，最重，约 1 MB）：只有详情页/回测页需要，
         *   单独成块后首页完全不加载它；
         * - antd：版本升级时才变，日常开发改动不污染它的缓存；
         * - react：几乎不变，缓存命中率最高；
         * - vendor：其余第三方依赖（dayjs、zustand、axios 等）。
         *
         * 分包粒度不宜过分细碎：每个 chunk 都是一次请求，移动端弱网下
         * 过多小文件反而更慢，所以只切这四层。
         */
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined

          // echarts + 其渲染内核 zrender 必须同块，否则 zrender 会被拉进 vendor，
          // 与实际使用 echarts 的页面形成跨块双向依赖
          if (id.includes('echarts') || id.includes('zrender')) return 'charts'

          // react 全家桶连同路由的运行时依赖（@remix-run/router、cookie 系列）一起收进来。
          // 只放 /react/ 会让 react-router 把 @remix-run/router 留在 vendor，
          // 于是出现 react -> vendor -> react 的环。
          if (
            id.includes('/react/') ||
            id.includes('/react-dom/') ||
            id.includes('/react-router') ||
            id.includes('/scheduler/') ||
            id.includes('@remix-run') ||
            id.includes('/use-sync-external-store/') ||
            id.includes('/cookie/') ||
            id.includes('/set-cookie-parser/')
          ) {
            return 'react'
          }

          // antd 与 rc-* 组件族、样式工具统一进 ui 块，和其余三方依赖分开。
          // 之前把 antd 单独切开、其余进 vendor，但 antd 内部依赖了若干三方小包，
          // 反过来某些三方包又依赖 rc-*，于是形成 antd <-> vendor 环。
          // 这里把 rc-* / @ant-design 全归 ui，边就只剩下 ui -> vendor 单向。
          if (
            id.includes('/antd/') ||
            id.includes('@ant-design') ||
            id.includes('/rc-') ||
            id.includes('@rc-component')
          ) {
            return 'ui'
          }
          return 'vendor'
        },
        // 让 chunk 名带内容哈希，便于 WebView 缓存命中与失效判断
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})
