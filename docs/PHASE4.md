# 第四阶段 · 交易与风控交付说明

本阶段把「能验证想法」推进到「能执行并受约束」：在 `core/` 里加入**风控引擎**与**条件单引擎**，
新增一个不依赖 Tauri 的**交易网关客户端 crate**，配上本地账本表与交易中心页面。

三条不可让渡的原则决定了本阶段的全部设计：

1. **风控前置且不可绕过** —— 委托必须先过本地风控，通过才发往网关。
2. **三端行为一致** —— 风控与条件单判定放在 Rust，不依赖券商是否支持、不依赖设备时区。
3. **不做模拟交易** —— 按需求约定，本阶段只做真实网关接入与交易日志，不提供虚拟撮合。

---

## 一、架构决策

### 1.1 为什么交易走「网络网关模式」

券商柜台 SDK（QMT / PTrade / XTP）都是 **Windows 专用 DLL**，Linux 与 Android 无法加载。
若坚持本地直连，就必然出现「桌面能用、手机不能用」，与三端一致目标直接冲突。

因此改为：用户在任意一台机器（通常是常开的 Windows 或服务器）上跑一个自建 HTTP 网关，
客户端只实现一套 REST 契约。柜台差异被收敛到网关一侧，客户端保持三端同构。

### 1.2 为什么风控放在客户端本地

| 方案 | 问题 |
|------|------|
| 风控放在网关 | 网关若由第三方提供，规则口径不可控；用户换网关就换了一套风控 |
| 风控放在前端 TS | 前端可被绕过（改一行代码即可）；且「校验 → 下单」两级调用之间存在时间窗，并发下仓位上限会被击穿 |
| **风控放在 Rust，与下单同一调用内完成（本方案）** | 一次 `trade_place_order` 内部完成「取快照 → 校验 → 发单」，无时间窗；三端同一份二进制逻辑 |

关键细节：`place_order` **刻意不提供「跳过风控」参数**。一旦存在，风控就成了摆设。
需要人工放行时应修改风控配置（可审计），而不是在调用侧开口子。

### 1.3 为什么单独抽 `gateway/` crate

| 方案 | 问题 |
|------|------|
| 交易逻辑写在 `src-tauri/src/trade/` | `src-tauri` 依赖 GTK/WebKit，任何改动都要等整套桌面运行时编译；CI 里也无法轻量测 |
| **独立 crate + 薄适配（本方案）** | `cargo test` 即可验证契约解析、配置校验、编排逻辑；Tauri 侧只剩「注入应用数据目录」这一层 |

`gateway/` 只依赖 `reqwest` / `serde` / `chrono` / `qbot-core`，不依赖 Tauri。
`src-tauri/src/trade/mod.rs` 因此缩到约 30 行，仅做路径注入与类型重导出。

---

## 二、交付清单

### 2.1 风控引擎 `core/src/risk.rs`（零第三方依赖）

| 类型 | 作用 |
|------|------|
| `RiskLimits` | 11 项限制：单标的仓位、单笔金额上下限、每日笔数、每日成交额、回撤熔断、黑名单、交易时段、整手股数、熔断时是否允许卖出 |
| `RiskContext` | 账户快照输入：净值、可用资金、该标的持仓、今日笔数与成交额、历史净值峰值、当前分钟数、是否交易日 |
| `OrderRequest` | 委托输入，`amount()` 计算金额并对非法价格/数量返回 0 |
| `RejectCode` | **12 种可机读拒绝码**，前端据此映射文案与是否建议改单 |
| `RiskDecision` | `Approved { warnings }` / `Rejected { code, reason }`；`warnings` 用于「接近上限」这类不阻断但需提示的情况 |

校验顺序（从最便宜、最不可能误判的规则开始）：

```
参数合法性 → 黑名单 → 交易时段 → 回撤熔断 → 单笔金额上下限
→ 每日笔数/成交额 → 整手 → 单标的仓位上限 → 可用资金
```

顺序有实际意义：先拦「明显不可能成交」的单，避免用户因为一个笔误去改风控配置。

几个容易被做错的边界，均已按 A 股规则处理：

- **时段含首尾**：09:30 与 15:00 整点应放行，11:31、15:01 应拒绝；
- **熔断只拦买入**：止损卖出不该被回撤熔断挡住，否则熔断就变成了「锁死风险敞口」；
- **整手只约束买入**：A 股卖出允许零股；
- **回撤用历史峰值**：峰值低于当前净值时不产生负回撤。

`check_exit_trigger()` 单独实现持仓止损/止盈判定（返回触发说明），只做判断不下单 ——
真正的下单仍要走完整风控。

### 2.2 条件单引擎 `core/src/conditional.rs`

| 类型 | 作用 |
|------|------|
| `TriggerKind` | 5 种触发：价格上穿 / 下穿 / 涨幅达到 / 跌幅达到 / 到点触发 |
| `ConditionalState` | 状态机：`armed → triggered → filled / failed`，任意非终态可 `cancelled` |
| `ConditionalOrder` | 条件单定义 + `validate()` + `effective_price_threshold()`（把涨跌幅换算成绝对价格） |
| `Tick` / `evaluate()` | 纯函数评估：输入「上一价、最新价、当前分钟、交易日」，输出触发/未触发/跳过 |

**用「跨越」语义而非「状态」语义**，这是核心设计点：
只有当上一价在阈值一侧、当前价到另一侧时才触发。否则价格长期站在阈值上方时，
每一轮轮询都会重复下单。测试里专门覆盖了这一点（`price_above_crosses_only_once`）。

其他被显式处理的现实问题：

- **跨日失效**：条件单只在 `trade_date` 当天有效，避免隔夜挂单在次日开盘意外成交；
- **时间条件每日只触发一次**：靠 `fired_today` 标记，且「本轮直接跨过目标时间」也应触发；
- **默认拒绝非法输入**：缺参考价的涨跌幅单、数量非正、时间阈值越界，都返回 `Skipped` 并说明原因。

### 2.3 交易网关客户端 `gateway/`

| 模块 | 内容 |
|------|------|
| `Store` | 配置与本地状态落盘（JSON）。**不进 SQLite**：这是「设备级连接参数」，且需在数据库就绪前读取 |
| `Gateway` | 纯 HTTP 层，含超时、`X-API-Key` 头、错误分类 |
| `extract_payload` | 解 `{code, data}` / `{success, data}` / 裸数据三种信封，用户无需改造网关 |
| `parse_list` | 接受裸数组或 `{items/list/rows/positions/accounts/orders}` 包装 |
| `fetch_snapshot` | 账户 + 持仓合并，缺失账户接口时用持仓市值兜底 |
| `place_order` | 编排：快照 → 定价 → 风控 → 发单，返回含 `RiskReport` 的结果 |
| `check_conditionals` | 批量取价 → 逐张评估 → 触发即下单（同样过风控）|

字段兼容性：`PositionInfo` / `AccountInfo` / `QuoteInfo` 都带大量 `alias`，
能同时吃 `availVolume` / `available_volume` / `canUseVolume` 这类各家不同命名。

**净值峰值持久化**：网关通常只给当前净值，而回撤熔断需要历史峰值。
峰值单独存 `trade_state.json`，只在创新高时写盘。若每次重启都从当前净值重新起算，
熔断就等于永久失效。

**时区**：`clock_now()` 固定用 UTC+8，不看设备本地时区。
手机在海外时区时，按本地时间判断「是否交易时段」会整体错位。

### 2.4 数据库迁移 `0005_trading.sql`

| 表 | 用途 |
|----|------|
| `orders` | 本地委托账本，主键是**客户端生成的 `client_order_id`** |
| `fills` | 成交明细 |
| `conditional_orders` | 条件单规则与状态 |

两个设计点：

- `orders.id` 用客户端 ID 而非自增：网关按此做幂等，「本地先落库、再发网关」在重试时不会重复下单；
- 条件单与委托分表：条件单是被动等待触发的**规则**，状态机与委托完全不同，混表会让查询与迁移都变复杂。

### 2.5 Tauri 命令 `src-tauri/src/trade/`（10 个）

| 命令 | 作用 |
|------|------|
| `trade_get_config` / `trade_save_config` | 读写配置；保存前校验风控规则，非法直接拒绝 |
| `trade_health` | 连通性探测（`ping` 未实现时退化为拉账户） |
| `trade_snapshot` | 账户 + 持仓快照，同时刷新净值峰值 |
| `trade_precheck` | 只校验不下单，用于填单时实时提示 |
| `trade_place_order` | 下单（风控通过才发网关） |
| `trade_cancel_order` / `trade_open_orders` | 撤单 / 未成交委托 |
| `trade_validate_conditional` | 条件单配置校验（不联网） |
| `trade_check_conditionals` | 评估并执行条件单 |

错误统一为 `TradeError { kind, message }`，`kind` 取 `config` / `network` / `rejected`，
前端据此决定提示「改配置」「查网络」还是「改单」—— 而不是一律弹「失败」。

### 2.6 前端

| 文件 | 内容 |
|------|------|
| `src/lib/trade/types.ts` | 与 Rust 一一对应的类型；`REJECT_TEXT` / `TRIGGER_META` / `CONDITIONAL_STATE_TEXT` 集中文案 |
| `src/lib/trade/api.ts` | invoke 封装 + `TradeRequestError` 规范化 + 客户端委托号生成 |
| `src/lib/trade/ledger.ts` | 本地账本读写；浏览器环境退化到 localStorage |
| `src/pages/TradePage.tsx` | 五段式页面：配置 → 账户持仓 → 下单 → 条件单 → 交易日志 |

页面上的两个关键交互：

- **下单前强制预检**：把本地今日笔数/成交额一起带上，让「每日笔数/成交额」判断准确；
  被拦时直接显示原因码 + 中文说明 + 当前各项实际数值。
- **条件单 15 秒轮询**：行情本身是分钟级，更快没有意义；页面隐藏时暂停轮询。
  触发后同步落库并补记委托，保证今日统计与风控额度不被少算。

`client_order_id` 用「时间戳 + 随机后缀」而非纯自增：多端同时下单时纯自增会撞号，
撞号会让网关幂等判断把两笔单当成同一笔。

---

## 三、验证结果

| 检查项 | 结果 |
|--------|------|
| `core` 单元测试 | **107 项通过**（本阶段新增 risk 27 项、conditional 18 项） |
| `gateway` 单元测试 | **13 项通过**（信封解包、字段别名、配置校验、条件单映射、时钟） |
| `tsc --noEmit` | 通过，无类型错误 |
| `vite build` | 通过 |

未能在沙箱验证的部分：`src-tauri` 的完整 `cargo build` 需要 WebKitGTK / libsoup 等系统库，
当前环境无 root 权限无法安装。因此本阶段刻意把**所有可测逻辑下沉到不依赖 Tauri 的 crate**，
`src-tauri` 侧只剩路径注入与命令声明，风险面最小。桌面端联调仍需在本地执行 `npm run app:dev`。

`gateway` 的依赖在 Rust 1.85 下需要锁定两个版本（新版 ICU 组件要求更高工具链）：

```bash
cargo update -p encoding_rs --precise 0.8.35
cargo update -p idna_adapter --precise 1.1.0
```

---

## 四、网关契约（供自建网关实现）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/ping` | 可选，连通性探测 |
| GET | `/api/v1/accounts` | 账户列表（含 `totalEquity` / `availableCash` / `marketValue`） |
| GET | `/api/v1/positions?account=` | 持仓（`symbol` / `volume` / `availableVolume` / `costPrice` / `lastPrice` / `marketValue`） |
| GET | `/api/v1/quotes?symbols=a,b` | 行情（`lastPrice` / `prevClose`），市价单与条件单评估都依赖它 |
| GET | `/api/v1/orders?account=` | 未成交委托 |
| POST | `/api/v1/orders` | 下单，body 含 `clientOrderId`，**网关须按此幂等** |
| DELETE | `/api/v1/orders/{id}?account=` | 撤单 |

响应可以是裸数据，也可以包 `{code: 0, data: ...}` 或 `{success: true, data: ...}`。
请求头 `X-API-Key` 由网关自行校验。

---

## 五、已知限制

| 限制 | 说明 |
|------|------|
| 交易日判断只看周末 | 未接入节假日日历。遇节假日下单会被网关拒绝，但本地风控不会提前拦下 |
| 条件单依赖轮询 | 15 秒一轮，极端行情下触发点可能滞后于实际穿越时刻 |
| 上一价用 `prevClose` 近似 | 网关没有逐笔推送时，用昨收作为「跨越」的另一端；开盘价已在阈值上方的情况因此能正常触发 |
| 无成交回报推送 | 委托状态以网关查询为准，本地账本记录的是「客户端视角」的状态 |
| 未做策略自动交易 | 本阶段只做手动下单与条件单；策略信号自动下单留待后续 |

---

## 六、下一步建议

1. 接入交易日历（可从 FastAPI 侧提供，或本地放假表），让「非交易日」判断真正准确；
2. 若网关支持 WebSocket 推送，把条件单轮询改为订阅驱动，降低滞后；
3. 加入成交回报订阅，让本地 `fills` 表与券商流水对账；
4. 把「策略信号 → 条件单 → 委托」串成链路，实现信号自动执行（仍全程过风控）。
