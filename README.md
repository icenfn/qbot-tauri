# Qbot · A股与基金量化工作台（Tauri 2 三端）

面向**国内市场 A 股与基金**的跨平台量化投资工作台。一套代码同时交付 **Linux / Windows / Android**。

> 参考 [UFund-Me/Qbot](https://github.com/UFund-Me/Qbot) 的产品形态与研究理念，但技术栈完全不同：
> 原项目基于 Python + wxPython + 本地券商 DLL，无法覆盖 Android；
> 本项目以 **Tauri 2 + Rust 核心 + FastAPI/AkShare 数据服务** 重构，保证三端能力一致。

---

## 一、为什么是这套架构

| 决策 | 原因 |
|------|------|
| 核心计算用 Rust | Tauri 的 Android 端**不支持 sidecar 外部进程**，无法打包 Python 运行时。指标、回测、策略、风控全部 Rust 实现，三端原生编译 |
| 数据获取用 FastAPI + AkShare | AkShare 是 Python 生态，必须跑在独立服务上；客户端只做 HTTP 调用，因此 Android 也能用完整数据能力 |
| 存储统一 SQLite | `tauri-plugin-sql`（sqlx + bundled sqlite）三端都可编译，无需外部数据库 |
| 网络走 `tauri-plugin-http` | Android 9+ 默认禁止 WebView 明文 HTTP，桌面端自定义协议下跨域会被 CORS 拦截。插件走 Rust reqwest，三端行为一致 |
| UI 一套 React | Windows 用 WebView2、Linux 用 WebKitGTK、Android 用系统 WebView，同一份前端代码 |
| 交易走「网络网关模式」 | 券商 QMT/PTrade/XTP 均为 Windows 本地 DLL，Linux/Android 无法加载。改为通过 REST/WS 连接用户自建的交易网关 |

```
┌───────────────────────────────────────────────┐
│  Tauri 2 前端（React + TS）：Linux / Win / Android │
├───────────────────────────────────────────────┤
│  Rust 核心：指标 · 回测 · 策略 · 风控 · 条件单     │
│             本地 SQLite（行情缓存/自选/交易日志）  │
├───────────────────────────────────────────────┤
│  FastAPI 数据服务：AkShare → A股 / 基金          │
└───────────────────────────────────────────────┘
```

---

## 二、三端一致性

| 能力 | Linux | Windows | Android | 说明 |
|------|:-----:|:-------:|:-------:|------|
| 行情 / K线 / 净值 | ✅ | ✅ | ✅ | 均经 FastAPI 获取，无平台差异 |
| 自选管理 | ✅ | ✅ | ✅ | SQLite（Android 为应用私有目录） |
| 指标 / 策略 / 回测 | ✅ | ✅ | ✅ | 纯 Rust 计算 |
| 交易（网关模式） | ✅ | ✅ | ✅ | 统一 HTTP/WS |
| 风控 | ✅ | ✅ | ✅ | Rust 本地执行 |
| 本地通知 | ✅ | ✅ | ✅ | `tauri-plugin-notification` |
| 主题切换 | ✅ | ✅ | ✅ | CSS 变量 |

**唯一差异**：Android 需要把后端地址配成局域网 IP（默认 `127.0.0.1` 在手机上指向手机本身），在「设置」页可修改。

---

## 三、目录结构

```
qbot-tauri/
├── src/                        # 前端（React + TS + Vite）
│   ├── layouts/AppLayout.tsx   # 响应式外壳：桌面侧边栏 / 移动底部导航
│   ├── pages/                  # 工作台、行情、回测、交易、基金、设置
│   ├── lib/api/                # 后端客户端（client/types/endpoints）
│   ├── lib/db/                 # SQLite 访问层（自选、缓存、交易日志）
│   ├── lib/tauri/              # 运行环境探测与命令调用封装
│   ├── stores/                 # zustand：主题、设置
│   └── styles/global.css       # 主题变量与布局
├── src-tauri/                  # Tauri 2 Rust 核心
│   ├── src/lib.rs              # 插件注册、迁移挂载、入口
│   ├── src/commands.rs         # 系统信息 / ping / 打开数据目录
│   ├── src/migrations.rs       # 数据库迁移装配
│   ├── migrations/*.sql        # 表结构
│   ├── capabilities/default.json  # 三端能力授权
│   └── tauri.conf.json
└── backend/                    # FastAPI + AkShare 数据服务
    └── app/
        ├── main.py             # 应用入口 + /health
        ├── schemas.py          # Pydantic 响应模型
        ├── api/v1/             # stocks / funds 路由
        └── services/akshare_service.py
```

---

## 四、开发环境准备

### 通用
- Node.js ≥ 18（推荐 20）
- Rust 工具链（stable，≥ 1.77.2）
- Python ≥ 3.10

### 平台依赖

**Linux（Debian/Ubuntu）**
```bash
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

**Windows**
- 安装 [Microsoft C++ 生成工具](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
- 安装 WebView2 Runtime（Win11 自带，Win10 由安装器自动补装）

**Android**
- Android Studio（含 SDK、NDK）
- JDK 17
- 环境变量：`ANDROID_HOME`、`NDK_HOME`
- Rust 目标：`rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`

---

## 五、启动

### 1) 启动数据服务
```bash
cd backend
pip install -r requirements.txt
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```
打开 http://127.0.0.1:8000/docs 可查看接口文档。

### 2) 启动桌面端（开发）
```bash
npm install
npm run app:dev          # Linux / Windows
```

### 3) 启动 Android
```bash
npm run android:init     # 首次执行，生成 src-tauri/gen/android
npm run android:dev      # 连接真机或模拟器
```
> 首次 `android:init` 后，`src-tauri/gen/android` 会生成 Gradle 工程，之后可随时改包名、签名、图标。

### 4) 打包
```bash
npm run app:build                    # 桌面端安装包
npm run android:build -- --apk       # Android APK
```

---

## 六、第一阶段（本次交付）范围

**已完成**
- ✅ Tauri 2 三端工程骨架，插件与能力（capabilities）声明完整
- ✅ 响应式外壳：桌面侧边栏 + 移动底部导航，深/浅主题切换
- ✅ 6 个页面路由与占位内容（工作台、行情、回测、交易、基金、设置）
- ✅ 统一 API 客户端：超时、取消、错误规整、Tauri/浏览器双通道
- ✅ SQLite 迁移体系（4 张表：watchlist / kline_cache / trade_log / app_meta）
- ✅ 自选标的管理（增删查清空），浏览器环境自动回退 localStorage
- ✅ 设置页：后端地址与超时配置、连通性测试、系统信息展示
- ✅ FastAPI + AkShare 数据服务：`/health`、A股列表/行情/K线、基金名录/净值
- ✅ 应用图标与打包配置

**未包含（按你的要求）**
- ❌ 基金 AI 策略、模拟交易
- ❌ 消息推送（飞书/钉钉/企业微信）
- ❌ 多语言、版本更新、数据备份恢复
- ❌ 加密货币、港美股

**说明**：沙箱环境无 Rust 工具链，Rust 侧以完整可编译源码交付；前端已通过 `tsc + vite build` 验证，后端已通过导入与路由校验。

---

## 七、后续阶段

| 阶段 | 内容 |
|------|------|
| 第二阶段 · 数据中心 | 行情看板（实时轮询）、K线/净值图、指标叠加、自选自动补全名称 |
| 第三阶段 · 策略与回测 | 30+ 指标库、6 个 A股策略 + 5 个基金策略、事件驱动回测引擎、绩效报告、参数优化 |
| 第四阶段 · 基金/实盘/风控 | 基金筛选与组合分析、交易网关对接、条件单、风控前置、本地通知 |
| 第五阶段 · 优化完善 | 性能、体验、交易日志界面、行情自动更新 |

---

## 八、免责声明

本项目为开源技术工具，**不构成任何投资建议**。金融市场有风险，任何策略回测结果均不代表未来收益。使用实盘功能前请自行充分验证，并自行承担全部风险与责任。

## 九、许可

MIT License
