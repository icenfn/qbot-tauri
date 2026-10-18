# 第二阶段 · 数据中心交付说明

本阶段目标：把「能取到数据」升级为「能看懂数据」。交付行情看板、K 线与净值图表、
个股与基金详情页，并用进程内 TTL 缓存把上游压力控制在可接受范围。

---

## 一、交付清单

### 后端（FastAPI + AkShare）

| 文件 | 作用 |
|------|------|
| `app/core/cache.py` | 进程内 TTL 缓存：`get/set/invalidate/get_or_set/stats`，支持按前缀清理 |
| `app/services/akshare_service.py` | 取数层重写：列名集中映射、失败统一抛 `DataSourceError`、按标的缓存 |
| `app/api/v1/stocks.py` | 新增 `GET /stocks/{symbol}/profile` |
| `app/api/v1/funds.py` | 新增 `GET /funds/{code}/detail` |
| `app/api/v1/market.py` | 新增 `/market/overview`、`/search`、`/cache/stats`、`/cache/clear` |
| `app/schemas.py` | 新增 `StockProfile`、`IndexQuote`、`MarketOverview`、`FundDetail`、`SearchResult`、`CacheStats` |
| `scripts/contract_check.py` | 接口契约验证脚本（替身数据 + 参数校验 + 502 + 缓存行为） |

### 前端（React + TS）

| 文件 | 作用 |
|------|------|
| `src/lib/api/types.ts` | 扩展 `KlinePeriod/KlineAdjust/IndexQuote/MarketOverview/StockProfile/FundDetail/SearchResult` |
| `src/lib/api/endpoints.ts` | 新增 `stockProfile/marketOverview/fundDetail/search` |
| `src/lib/db/klineCache.ts` | K 线本地缓存（SQLite，浏览器回退 localStorage） |
| `src/hooks/usePolling.ts` | 通用轮询：可开关、依赖变更重启、后台标签页跳过 |
| `src/lib/format.ts` | 价格/涨跌/金额/成交量格式化与涨跌配色 |
| `src/components/KlineChart.tsx` | 蜡烛图 + MA5/10/20 + 成交量副图 + 缩放 |
| `src/components/NavChart.tsx` | 基金净值折线（单位净值 / 累计净值） |
| `src/components/ChangeText.tsx` | 涨红跌绿文本 |
| `src/pages/MarketPage.tsx` | 行情看板重写：指数概览、自选轮询、搜索补全、移动端卡片 |
| `src/pages/StockDetailPage.tsx` | 个股详情：K 线、周期/复权切换、公司概况、自选切换 |
| `src/pages/FundPage.tsx` | 基金列表：搜索、类型筛选、移动端卡片、自选标记 |
| `src/pages/FundDetailPage.tsx` | 基金详情：净值走势、区间绩效、基金信息 |
| `src/router.tsx` | 新增 `/market/:symbol`、`/fund/:code`（Hash 路由） |

---

## 二、接口总览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 服务状态 + AkShare 可用性 + 缓存条目数 |
| GET | `/api/v1/stocks` | A 股名录（keyword / limit） |
| GET | `/api/v1/stocks/quotes` | 批量行情快照（≤100 个标的） |
| GET | `/api/v1/stocks/kline` | 历史 K 线（daily/weekly/monthly × none/qfq/hfq） |
| GET | `/api/v1/stocks/{symbol}/profile` | 个股资料（行业、上市日、市值、股本） |
| GET | `/api/v1/market/overview` | 主要指数快照（默认 6 个） |
| GET | `/api/v1/funds` | 场外基金名录（keyword / limit） |
| GET | `/api/v1/funds/nav` | 基金单位净值序列 |
| GET | `/api/v1/funds/{code}/detail` | 基金详情（含净值序列） |
| GET | `/api/v1/search` | 股票与基金统一搜索 |
| GET | `/api/v1/cache/stats` | 缓存条目与键列表 |
| POST | `/api/v1/cache/clear` | 清空缓存（可按前缀） |

错误语义：数据源异常统一 **502**（明确是上游问题，不是服务 bug）；参数非法 **422**；
业务约束（如 symbols 为空/超 100）**400**。

---

## 三、缓存与刷新策略

| 数据 | 后端 TTL | 前端行为 |
|------|---------|---------|
| 实时行情快照 | 30s | 交易时段 10s 轮询，非交易 60s |
| K 线 | 300s | 本地缓存 5 分钟，命中先渲染再静默刷新 |
| 指数概览 | 30s | 随行情轮询 |
| 基金名录 | 3600s | 进入页面加载一次 |
| 基金净值 | 1800s | 3 分钟轮询（导航值日频） |
| 个股资料 | 86400s | 进入详情页加载一次 |

TTL 可通过环境变量覆盖：`QBOT_CACHE_TTL_SPOT=10`、`QBOT_CACHE_TTL_KLINE=60` 等。

---

## 四、验证结果

前端：

```
npx tsc --noEmit   → 无错误
npx vite build     → ✓ 3645 modules transformed，dist 产物生成成功
```

后端（`python scripts/contract_check.py`）：

```
通过 57 项，失败 0 项
```

覆盖：
1. 9 个业务接口的正常路径与响应字段完整性（与前端类型逐字段对齐）；
2. 参数校验：symbols 空/超限、period/adjust 枚举、limit 上限、search 空关键字；
3. TTL 缓存：统计、写入、按前缀清理、全量清空；
4. 数据源异常 → 9 个接口全部 502；
5. AkShare 未安装时 `/health` 仍 200 且 `akshare_available=false`。

> 说明：沙箱内未安装 AkShare（体积大且需要外网行情接口），因此接口验证使用替身函数驱动真实路由，
> 用于校验**契约、校验逻辑、错误映射与缓存行为**。真实取数需在已安装 AkShare 的机器上执行
> `pip install -r backend/requirements.txt` 后运行 `uvicorn app.main:app`。

---

## 五、已知限制

| 项 | 现状 | 后续 |
|----|------|------|
| 基金经理/规模/公司字段 | AkShare 场外基金通道不提供，返回 `null` | 数据源补齐后展示 |
| 区间绩效指标 | 前端展示层近似计算 | 第三阶段由 Rust 指标引擎统一计算 |
| 前端单包体积 | 2.3MB（echarts + antd） | 后续按路由做动态 import 拆包 |
| Rust 编译验证 | 沙箱无 Rust 工具链 | 需在本地 `npm run app:dev` 首次验证 |
