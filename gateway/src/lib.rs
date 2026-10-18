//! 交易网关接入层（`qbot-gateway`）。
//!
//! 为什么是「网关模式」而不是本地直连券商：
//! - 券商柜台 SDK 通常是 Windows 专用 DLL，Android / Linux 无法加载，与三端一致目标冲突；
//! - 把柜台差异收敛到用户自建的一个 HTTP 服务里，客户端只需实现一套 REST 契约；
//! - 客户端侧因此可以完全用 Rust 写风控，三端行为一致。
//!
//! 为什么单独成 crate：本层只依赖 `reqwest` / `serde` / `chrono`，**不依赖 Tauri**。
//! 这样可以在任意机器上用 `cargo test` 验证契约解析、配置校验、风控编排，
//! 而不需要安装 WebKitGTK 之类的桌面运行时依赖。Tauri 侧只是薄薄一层适配。
//!
//! 分层：
//! - [`GatewayConfig`] / [`RiskLimitsConfig`]：落盘配置（JSON 文件），不放 SQLite，
//!   因为它是「设备级连接参数」而不是业务数据，且需要在数据库就绪前读取；
//! - [`Store`]：配置文件与本地状态（净值峰值）的读写位置；
//! - [`Gateway`]：只做 HTTP，不包含任何业务判断；
//! - [`build_context`]：把网关快照转换成 `qbot_core::risk::RiskContext`；
//! - [`place_order`]：串起「取快照 → 风控 → 下单」，风控拒绝时不发请求。

use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{Datelike, FixedOffset, Timelike, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use qbot_core::conditional::{
    self as cond, ConditionalOrder, ConditionalState, Tick, TriggerKind, TriggerOutcome,
};
use qbot_core::risk::{self, OrderRequest, RiskContext, RiskDecision, RiskLimits, Session};
use qbot_core::types::Side;

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/// 风控限制的前端配置形态：时段用 `HH:MM-HH:MM` 字符串，便于表单编辑。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RiskLimitsConfig {
    pub max_position_pct: f64,
    pub max_single_order_amount: f64,
    pub min_single_order_amount: f64,
    pub max_daily_orders: usize,
    pub max_daily_turnover: f64,
    pub max_drawdown_pct: f64,
    pub blacklist: Vec<String>,
    pub enforce_session: bool,
    pub sessions: Vec<String>,
    pub lot_size: f64,
    pub allow_sell_when_halted: bool,
}

impl Default for RiskLimitsConfig {
    fn default() -> Self {
        let base = RiskLimits::default();
        Self {
            max_position_pct: base.max_position_pct,
            max_single_order_amount: base.max_single_order_amount,
            min_single_order_amount: base.min_single_order_amount,
            max_daily_orders: base.max_daily_orders,
            max_daily_turnover: base.max_daily_turnover,
            max_drawdown_pct: base.max_drawdown_pct,
            blacklist: base.blacklist,
            enforce_session: base.enforce_session,
            sessions: base
                .sessions
                .iter()
                .map(|s| {
                    format!(
                        "{:02}:{:02}-{:02}:{:02}",
                        s.start_minute / 60,
                        s.start_minute % 60,
                        s.end_minute / 60,
                        s.end_minute % 60
                    )
                })
                .collect(),
            lot_size: base.lot_size,
            allow_sell_when_halted: base.allow_sell_when_halted,
        }
    }
}

impl RiskLimitsConfig {
    /// 转成核心库配置；时段字符串解析失败时给出明确错误而不是静默丢弃。
    pub fn to_core(&self) -> Result<RiskLimits, String> {
        let mut sessions = Vec::new();
        for item in &self.sessions {
            let text = item.trim();
            if text.is_empty() {
                continue;
            }
            let (start, end) = text
                .split_once('-')
                .ok_or_else(|| format!("交易时段格式应为 HH:MM-HH:MM，收到 {text}"))?;
            let session =
                Session::from_hm(start, end).ok_or_else(|| format!("交易时段 {text} 解析失败"))?;
            sessions.push(session);
        }
        let limits = RiskLimits {
            max_position_pct: self.max_position_pct,
            max_single_order_amount: self.max_single_order_amount,
            min_single_order_amount: self.min_single_order_amount,
            max_daily_orders: self.max_daily_orders,
            max_daily_turnover: self.max_daily_turnover,
            max_drawdown_pct: self.max_drawdown_pct,
            blacklist: self.blacklist.clone(),
            enforce_session: self.enforce_session,
            sessions,
            lot_size: self.lot_size,
            allow_sell_when_halted: self.allow_sell_when_halted,
        };
        limits.validate()?;
        Ok(limits)
    }
}

/// 网关连接配置。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GatewayConfig {
    /// 例如 http://127.0.0.1:8001
    pub base_url: String,
    /// 放在 `X-API-Key` 头里；网关侧自行校验
    pub api_key: String,
    /// 默认资金账号
    pub account: String,
    pub timeout_ms: u64,
    pub risk: RiskLimitsConfig,
}

impl Default for GatewayConfig {
    fn default() -> Self {
        Self {
            base_url: String::new(),
            api_key: String::new(),
            account: "default".into(),
            timeout_ms: 8000,
            risk: RiskLimitsConfig::default(),
        }
    }
}

impl GatewayConfig {
    /// 端点配置是否已完成（地址是唯一必填项）。
    pub fn is_configured(&self) -> bool {
        !self.base_url.trim().is_empty()
    }

    pub fn normalized_base(&self) -> String {
        self.base_url.trim().trim_end_matches('/').to_string()
    }
}

/// 本地状态：净值峰值。
///
/// 为什么单独存：回撤熔断需要「历史峰值」，而网关通常只给当前净值。
/// 峰值必须跨会话保留，否则每次重启都从当前净值重新起算，熔断形同虚设。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalState {
    /// account -> 历史净值峰值
    #[serde(default)]
    pub peak_equity: std::collections::BTreeMap<String, f64>,
}

/// 配置与本地状态的存放目录。
///
/// 由调用方（Tauri 侧）传入应用数据目录；测试里传入临时目录即可。
#[derive(Debug, Clone)]
pub struct Store {
    dir: PathBuf,
}

impl Store {
    /// 目录不存在时自动创建。
    pub fn new(dir: impl Into<PathBuf>) -> Result<Self, String> {
        let dir = dir.into();
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败：{e}"))?;
        Ok(Self { dir })
    }

    pub fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    /// 读取网关配置；文件缺失或损坏时返回默认值（首次运行即此情形）。
    pub fn load_config(&self) -> Result<GatewayConfig, String> {
        let cfg = read_json::<GatewayConfig>(&self.path("trade_gateway.json"));
        Ok(GatewayConfig {
            account: if cfg.account.trim().is_empty() {
                "default".into()
            } else {
                cfg.account
            },
            ..cfg
        })
    }

    /// 保存网关配置；保存前校验风控规则，避免非法规则被持久化后难以排查。
    pub fn save_config(&self, config: &GatewayConfig) -> Result<(), String> {
        config.risk.to_core()?;
        if config.timeout_ms < 500 || config.timeout_ms > 60_000 {
            return Err("超时时间应在 500 - 60000 毫秒之间".into());
        }
        write_json(&self.path("trade_gateway.json"), config)
    }

    /// 本地状态（净值峰值等）。
    pub fn state(&self) -> LocalState {
        read_json::<LocalState>(&self.path("trade_state.json"))
    }

    pub fn save_state(&self, state: &LocalState) {
        let _ = write_json(&self.path("trade_state.json"), state);
    }
}

fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> T {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value).map_err(|e| format!("序列化失败：{e}"))?;
    std::fs::write(path, text).map_err(|e| format!("写入 {} 失败：{e}", path.display()))
}

// ---------------------------------------------------------------------------
// 时间工具
// ---------------------------------------------------------------------------

/// 交易所时区的「现在」：距零点分钟数 + 交易日字符串 + 是否周末。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClockInfo {
    pub trade_date: String,
    pub minute: u32,
    pub weekday: u32,
    pub is_weekend: bool,
    pub hhmm: String,
}

/// A 股用北京时间（UTC+8），不能用设备本地时区：手机在海外时区时按本地时间判断会错。
pub fn clock_now() -> ClockInfo {
    let offset = FixedOffset::east_opt(8 * 3600).expect("UTC+8 偏移恒合法");
    let now = Utc::now().with_timezone(&offset);
    let minute = now.hour() * 60 + now.minute();
    let weekday = now.weekday().num_days_from_monday();
    ClockInfo {
        trade_date: now.format("%Y-%m-%d").to_string(),
        minute,
        weekday,
        is_weekend: weekday >= 5,
        hhmm: now.format("%H:%M").to_string(),
    }
}

// ---------------------------------------------------------------------------
// HTTP 客户端
// ---------------------------------------------------------------------------

/// 网关返回的业务错误（与网络错误区分，便于前端提示「改单」还是「查网络」）。
#[derive(Debug, Clone)]
pub struct GatewayError {
    pub kind: &'static str,
    pub message: String,
}

impl GatewayError {
    fn network(msg: impl Into<String>) -> Self {
        Self {
            kind: "network",
            message: msg.into(),
        }
    }
    fn http(msg: impl Into<String>) -> Self {
        Self {
            kind: "http",
            message: msg.into(),
        }
    }
    fn decode(msg: impl Into<String>) -> Self {
        Self {
            kind: "decode",
            message: msg.into(),
        }
    }
    fn rejected(msg: impl Into<String>) -> Self {
        Self {
            kind: "rejected",
            message: msg.into(),
        }
    }

    pub fn to_message(&self) -> String {
        self.message.clone()
    }
}

fn truncate(text: &str, max: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max {
        text.to_string()
    } else {
        let head: String = chars.iter().take(max).collect();
        format!("{head}…")
    }
}

/// 解开 `{code, message, data}` 信封。
///
/// 兼容三种风格：裸数据、`{code:0,data:...}`、`{success:true,data:...}`。
/// 自建网关常见这几种封装，客户端统一处理可以省掉用户改造网关。
fn extract_payload(value: Value) -> Result<Value, GatewayError> {
    let Some(obj) = value.as_object() else {
        return Ok(value);
    };

    if let Some(success) = obj.get("success").and_then(|v| v.as_bool()) {
        if !success {
            let msg = obj
                .get("message")
                .or_else(|| obj.get("error"))
                .and_then(|v| v.as_str())
                .unwrap_or("网关返回失败");
            return Err(GatewayError::rejected(msg));
        }
    }

    if let Some(code) = obj.get("code") {
        let ok = match code {
            Value::Number(n) => n.as_i64().map(|v| v == 0).unwrap_or(true),
            Value::String(s) => s == "0" || s.eq_ignore_ascii_case("ok"),
            _ => true,
        };
        if !ok {
            let msg = obj
                .get("message")
                .or_else(|| obj.get("msg"))
                .and_then(|v| v.as_str())
                .unwrap_or("网关返回失败");
            return Err(GatewayError::rejected(format!("[{code}] {msg}")));
        }
    }

    if let Some(data) = obj.get("data") {
        return Ok(data.clone());
    }
    Ok(value)
}

pub struct Gateway {
    client: reqwest::Client,
    base: String,
    api_key: String,
}

impl Gateway {
    pub fn new(cfg: &GatewayConfig) -> Result<Self, String> {
        if !cfg.is_configured() {
            return Err("尚未配置交易网关地址".into());
        }
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(cfg.timeout_ms.clamp(500, 60_000)))
            .build()
            .map_err(|e| format!("创建 HTTP 客户端失败：{e}"))?;
        Ok(Self {
            client,
            base: cfg.normalized_base(),
            api_key: cfg.api_key.trim().to_string(),
        })
    }

    fn url(&self, path: &str) -> String {
        if path.starts_with("http") {
            path.to_string()
        } else {
            format!("{}{}", self.base, path)
        }
    }

    async fn send(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
        query: &[(&str, String)],
    ) -> Result<Value, GatewayError> {
        let url = self.url(path);
        let mut req = self.client.request(method, &url);
        if !query.is_empty() {
            req = req.query(query);
        }
        if !self.api_key.is_empty() {
            req = req.header("X-API-Key", &self.api_key);
        }
        if let Some(b) = body {
            req = req.json(&b);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| GatewayError::network(format!("无法访问交易网关 {url}：{e}")))?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(GatewayError::http(format!(
                "网关返回 HTTP {}：{}",
                status.as_u16(),
                truncate(&text, 200)
            )));
        }
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        let value: Value = serde_json::from_str(&text)
            .map_err(|e| GatewayError::decode(format!("网关响应不是合法 JSON：{e}")))?;
        extract_payload(value)
    }

    async fn get(&self, path: &str, query: &[(&str, String)]) -> Result<Value, GatewayError> {
        self.send(reqwest::Method::GET, path, None, query).await
    }

    async fn post(&self, path: &str, body: Value) -> Result<Value, GatewayError> {
        self.send(reqwest::Method::POST, path, Some(body), &[])
            .await
    }

    async fn delete(&self, path: &str, query: &[(&str, String)]) -> Result<Value, GatewayError> {
        self.send(reqwest::Method::DELETE, path, None, query).await
    }
}

fn parse<T: for<'de> Deserialize<'de>>(value: Value, what: &str) -> Result<T, GatewayError> {
    serde_json::from_value(value).map_err(|e| GatewayError::decode(format!("{what}解析失败：{e}")))
}

/// 网关可能返回 `{items:[...]}` 或裸数组，两种都接受。
fn parse_list<T: for<'de> Deserialize<'de>>(
    value: Value,
    what: &str,
) -> Result<Vec<T>, GatewayError> {
    if value.is_array() {
        return parse(value, what);
    }
    if let Some(obj) = value.as_object() {
        for key in ["items", "list", "rows", "positions", "accounts", "orders"] {
            if let Some(inner) = obj.get(key) {
                if inner.is_array() {
                    return parse(inner.clone(), what);
                }
            }
        }
    }
    if value.is_null() {
        return Ok(Vec::new());
    }
    Err(GatewayError::decode(format!("{what}结构无法识别")))
}

// ---------------------------------------------------------------------------
// 网关数据结构（同时兼容 camelCase 与 snake_case）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    #[serde(default)]
    pub account: String,
    #[serde(
        default,
        alias = "total_equity",
        alias = "netAsset",
        alias = "net_asset",
        alias = "equity"
    )]
    pub total_equity: f64,
    #[serde(default, alias = "totalCash", alias = "total_cash")]
    pub cash: f64,
    #[serde(
        default,
        alias = "available_cash",
        alias = "availCash",
        alias = "avail_cash",
        alias = "available"
    )]
    pub available_cash: f64,
    #[serde(default, alias = "market_value", alias = "marketValueTotal")]
    pub market_value: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionInfo {
    pub symbol: String,
    #[serde(default, alias = "symbol_name", alias = "stockName")]
    pub name: String,
    #[serde(default, alias = "qty", alias = "quantity", alias = "totalVolume")]
    pub volume: f64,
    #[serde(
        default,
        alias = "available_volume",
        alias = "availVolume",
        alias = "canUseVolume"
    )]
    pub available_volume: f64,
    #[serde(default, alias = "cost_price", alias = "avgPrice", alias = "openPrice")]
    pub cost_price: f64,
    #[serde(default, alias = "last_price", alias = "price", alias = "lastPriceRaw")]
    pub last_price: f64,
    #[serde(default, alias = "market_value", alias = "marketVal")]
    pub market_value: f64,
}

impl PositionInfo {
    /// 市值缺失时按「最新价 × 数量」补算，避免仓位上限因缺字段失效。
    pub fn effective_market_value(&self) -> f64 {
        if self.market_value > 0.0 {
            self.market_value
        } else if self.last_price > 0.0 {
            self.last_price * self.volume
        } else {
            0.0
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteInfo {
    pub symbol: String,
    #[serde(default, alias = "last_price", alias = "price", alias = "close")]
    pub last_price: f64,
    #[serde(
        default,
        alias = "prev_close",
        alias = "preClose",
        alias = "previousClose"
    )]
    pub prev_close: f64,
    #[serde(
        default,
        alias = "change_pct",
        alias = "changePercent",
        alias = "pctChg"
    )]
    pub change_pct: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenOrderInfo {
    #[serde(default, alias = "order_id", alias = "id")]
    pub order_id: String,
    #[serde(default)]
    pub symbol: String,
    #[serde(default)]
    pub side: String,
    #[serde(default, alias = "order_type", alias = "type")]
    pub order_type: String,
    #[serde(default)]
    pub price: f64,
    #[serde(default, alias = "qty", alias = "quantity")]
    pub volume: f64,
    #[serde(default, alias = "status", alias = "state")]
    pub status: String,
    #[serde(default, alias = "created_at", alias = "createdAt", alias = "time")]
    pub created_at: String,
}

// ---------------------------------------------------------------------------
// 快照与风控上下文
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub account: String,
    pub total_equity: f64,
    pub available_cash: f64,
    pub market_value: f64,
    pub positions: Vec<PositionInfo>,
    pub peak_equity: f64,
    pub drawdown: f64,
    /// 单标的最大可用买入金额（按仓位上限折算），供前端提示
    pub position_cap: f64,
    pub clock: ClockInfo,
}

pub async fn fetch_snapshot(
    store: &Store,
    cfg: &GatewayConfig,
) -> Result<Snapshot, String> {
    let gw = Gateway::new(cfg)?;
    let account = if cfg.account.trim().is_empty() {
        "default".to_string()
    } else {
        cfg.account.clone()
    };

    let accounts = gw
        .get("/api/v1/accounts", &[])
        .await
        .map_err(|e| e.to_message())
        .and_then(|v| parse_list::<AccountInfo>(v, "账户列表").map_err(|e| e.to_message()))?
        .into_iter()
        .map(|a| AccountInfo {
            account: if a.account.trim().is_empty() {
                account.clone()
            } else {
                a.account
            },
            ..a
        })
        .collect::<Vec<_>>();

    let positions = gw
        .get("/api/v1/positions", &[("account", account.clone())])
        .await
        .map_err(|e| e.to_message())
        .and_then(|v| parse_list::<PositionInfo>(v, "持仓列表").map_err(|e| e.to_message()))?;

    let current = accounts
        .iter()
        .find(|a| a.account == account)
        .or_else(|| accounts.first());

    let positions_value: f64 = positions.iter().map(|p| p.effective_market_value()).sum();
    let (total_equity, available_cash, market_value) = match current {
        Some(a) => {
            let cash = if a.cash > 0.0 {
                a.cash
            } else {
                a.available_cash
            };
            let total = if a.total_equity > 0.0 {
                a.total_equity
            } else {
                cash + if a.market_value > 0.0 {
                    a.market_value
                } else {
                    positions_value
                }
            };
            let mv = if a.market_value > 0.0 {
                a.market_value
            } else {
                positions_value
            };
            (total, a.available_cash, mv)
        }
        // 网关未提供账户接口时，用持仓市值兜底，至少让风控有数可用
        None => (positions_value, 0.0, positions_value),
    };

    // 更新历史峰值：只在净值创新高时写盘，减少 IO
    let mut state = store.state();
    let peak = state.peak_equity.get(&account).copied().unwrap_or(0.0);
    let new_peak = if total_equity > peak {
        total_equity
    } else {
        peak
    };
    if new_peak > peak {
        state.peak_equity.insert(account.clone(), new_peak);
        store.save_state(&state);
    }

    let limits = cfg.risk.to_core()?;
    let position_cap = if limits.max_position_pct > 0.0 && total_equity > 0.0 {
        total_equity * limits.max_position_pct
    } else {
        0.0
    };

    Ok(Snapshot {
        account,
        total_equity,
        available_cash,
        market_value,
        positions,
        peak_equity: new_peak,
        drawdown: risk::current_drawdown(total_equity, new_peak),
        position_cap,
        clock: clock_now(),
    })
}

fn build_context(
    snap: &Snapshot,
    symbol: &str,
    today_order_count: usize,
    today_turnover: f64,
) -> RiskContext {
    let key = symbol.trim().to_uppercase();
    let pos = snap
        .positions
        .iter()
        .find(|p| p.symbol.trim().to_uppercase() == key);
    RiskContext {
        total_equity: snap.total_equity,
        available_cash: snap.available_cash,
        position_value: pos.map(|p| p.effective_market_value()).unwrap_or(0.0),
        position_volume: pos.map(|p| p.volume).unwrap_or(0.0),
        today_order_count,
        today_turnover,
        peak_equity: if snap.peak_equity > 0.0 {
            snap.peak_equity
        } else {
            snap.total_equity
        },
        current_minute: snap.clock.minute,
        is_trading_day: !snap.clock.is_weekend,
    }
}

fn side_from_str(text: &str) -> Result<Side, String> {
    match text.trim().to_lowercase().as_str() {
        "buy" | "b" | "买入" => Ok(Side::Buy),
        "sell" | "s" | "卖出" => Ok(Side::Sell),
        other => Err(format!("未知买卖方向：{other}")),
    }
}

fn normalize_order_type(text: &str) -> String {
    match text.trim().to_lowercase().as_str() {
        "market" | "m" | "市价" => "market".into(),
        _ => "limit".into(),
    }
}

// ---------------------------------------------------------------------------
// 下单 / 撤单
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RiskReport {
    pub approved: bool,
    pub code: Option<String>,
    pub reason: String,
    pub warnings: Vec<String>,
    pub amount: f64,
    pub drawdown: f64,
    pub total_equity: f64,
    pub available_cash: f64,
    pub position_value: f64,
    pub position_cap: f64,
    pub today_order_count: usize,
    pub today_turnover: f64,
    pub trade_date: String,
    pub minute: u32,
}

fn risk_report(
    decision: &RiskDecision,
    order: &OrderRequest,
    snap: &Snapshot,
    ctx: &RiskContext,
) -> RiskReport {
    RiskReport {
        approved: decision.is_approved(),
        code: decision.reject_code().map(|c| c.as_str().to_string()),
        reason: match decision {
            RiskDecision::Approved { .. } => "风控校验通过".to_string(),
            RiskDecision::Rejected { reason, .. } => reason.clone(),
        },
        warnings: decision.warnings().to_vec(),
        amount: order.amount(),
        drawdown: risk::current_drawdown(ctx.total_equity, ctx.peak_equity),
        total_equity: ctx.total_equity,
        available_cash: ctx.available_cash,
        position_value: ctx.position_value,
        position_cap: snap.position_cap,
        today_order_count: ctx.today_order_count,
        today_turnover: ctx.today_turnover,
        trade_date: snap.clock.trade_date.clone(),
        minute: ctx.current_minute,
    }
}

/// 市价单没有价格，用最新价估算金额供风控使用；拿不到最新价则拒绝。
async fn resolve_price(
    gw: &Gateway,
    symbol: &str,
    order_type: &str,
    price: Option<f64>,
) -> Result<f64, String> {
    if order_type == "limit" {
        let p = price.unwrap_or(0.0);
        if p <= 0.0 {
            return Err("限价单必须填写委托价".into());
        }
        return Ok(p);
    }
    let quotes = gw
        .get("/api/v1/quotes", &[("symbols", symbol.to_string())])
        .await
        .map_err(|e| e.to_message())
        .and_then(|v| parse_list::<QuoteInfo>(v, "行情").map_err(|e| e.to_message()))?;
    quotes
        .iter()
        .find(|q| q.symbol.trim().to_uppercase() == symbol.trim().to_uppercase())
        .map(|q| q.last_price)
        .filter(|p| *p > 0.0)
        .ok_or_else(|| "市价单需要最新价参与风控，但未能获取到该标的最新价".to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaceOrderResult {
    pub accepted: bool,
    pub client_order_id: String,
    pub gateway_order_id: String,
    pub status: String,
    pub message: String,
    pub risk: RiskReport,
}

fn new_client_order_id() -> String {
    let now = Utc::now();
    format!("qb{}", now.timestamp_millis())
}

/// 下单编排：取快照 → 解析价格 → 风控 → 通过才发网关。
///
/// 注意这里**没有「跳过风控」开关**：一旦提供，风控就成了摆设。
/// 需要人工放行时应调整风控配置（可审计），而不是在调用侧绕过。
pub async fn place_order(
    store: &Store,
    cfg: &GatewayConfig,
    symbol: &str,
    side_text: &str,
    order_type_text: &str,
    price: Option<f64>,
    volume: f64,
    client_order_id: Option<String>,
    today_order_count: usize,
    today_turnover: f64,
) -> Result<PlaceOrderResult, String> {
    let side = side_from_str(side_text)?;
    let order_type = normalize_order_type(order_type_text);
    let cid = client_order_id
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(new_client_order_id);

    let gw = Gateway::new(cfg)?;
    let snap = fetch_snapshot(store, cfg).await?;
    let price_used = resolve_price(&gw, symbol, &order_type, price).await?;
    let order = OrderRequest {
        symbol: symbol.to_string(),
        side,
        price: price_used,
        volume,
    };

    let limits = cfg.risk.to_core()?;
    let ctx = build_context(&snap, symbol, today_order_count, today_turnover);
    let decision = risk::check_order(&limits, &ctx, &order);
    let report = risk_report(&decision, &order, &snap, &ctx);

    if !decision.is_approved() {
        return Ok(PlaceOrderResult {
            accepted: false,
            client_order_id: cid,
            gateway_order_id: String::new(),
            status: "rejected".into(),
            message: report.reason.clone(),
            risk: report,
        });
    }

    let body = serde_json::json!({
        "account": snap.account,
        "symbol": symbol,
        "side": side.as_str(),
        "orderType": order_type,
        "price": if order_type == "limit" { serde_json::json!(price_used) } else { serde_json::Value::Null },
        "volume": volume,
        "clientOrderId": cid,
    });

    let ack = gw
        .post("/api/v1/orders", body)
        .await
        .map_err(|e| e.to_message())?;
    let order_id = ack
        .get("orderId")
        .or_else(|| ack.get("order_id"))
        .or_else(|| ack.get("id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let status = ack
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("submitted")
        .to_string();

    Ok(PlaceOrderResult {
        accepted: true,
        client_order_id: cid,
        gateway_order_id: order_id,
        status,
        message: if report.warnings.is_empty() {
            "委托已提交".into()
        } else {
            format!("委托已提交（{}）", report.warnings.join("；"))
        },
        risk: report,
    })
}

/// 连通性探测。
///
/// 先试 `/api/v1/ping`（约定端点，最轻量）；网关未实现时退化为拉账户列表，
/// 这样用户自建网关只要实现了业务接口就能通过探测，不必额外加 ping。
pub async fn probe(cfg: &GatewayConfig) -> Result<String, String> {
    if !cfg.is_configured() {
        return Err("尚未配置交易网关地址".into());
    }
    let gw = Gateway::new(cfg)?;
    match gw.get("/api/v1/ping", &[]).await {
        Ok(_) => Ok("ping 正常".into()),
        Err(first) => match gw.get("/api/v1/accounts", &[]).await {
            Ok(v) => {
                let n = parse_list::<AccountInfo>(v, "账户列表")
                    .map(|l| l.len())
                    .unwrap_or(0);
                Ok(format!("ping 未实现，已通过账户接口连通（{n} 个账户）"))
            }
            Err(_) => Err(format!(
                "网关不可用：{}（账户接口同样失败）",
                first.to_message()
            )),
        },
    }
}

/// 风控预检：不发委托，只返回报告。
pub async fn precheck(
    store: &Store,
    cfg: &GatewayConfig,
    symbol: &str,
    side_text: &str,
    order_type_text: &str,
    price: Option<f64>,
    volume: f64,
    today_order_count: usize,
    today_turnover: f64,
) -> Result<RiskReport, String> {
    let side = side_from_str(side_text)?;
    let order_type = normalize_order_type(order_type_text);
    let gw = Gateway::new(cfg)?;
    let snap = fetch_snapshot(store, cfg).await?;
    let price_used = resolve_price(&gw, symbol, &order_type, price).await?;
    let order = OrderRequest {
        symbol: symbol.to_string(),
        side,
        price: price_used,
        volume,
    };
    let limits = cfg.risk.to_core()?;
    let ctx = build_context(&snap, symbol, today_order_count, today_turnover);
    let decision = risk::check_order(&limits, &ctx, &order);
    Ok(risk_report(&decision, &order, &snap, &ctx))
}

pub async fn cancel_order(cfg: &GatewayConfig, order_id: &str) -> Result<String, String> {
    let gw = Gateway::new(cfg)?;
    let account = if cfg.account.trim().is_empty() {
        "default".to_string()
    } else {
        cfg.account.clone()
    };
    gw.delete(
        &format!("/api/v1/orders/{}", order_id),
        &[("account", account)],
    )
    .await
    .map_err(|e| e.to_message())?;
    Ok(format!("已请求撤销委托 {order_id}"))
}

pub async fn open_orders(cfg: &GatewayConfig) -> Result<Vec<OpenOrderInfo>, String> {
    let gw = Gateway::new(cfg)?;
    let account = if cfg.account.trim().is_empty() {
        "default".to_string()
    } else {
        cfg.account.clone()
    };
    gw.get("/api/v1/orders", &[("account", account.clone())])
        .await
        .map_err(|e| e.to_message())
        .and_then(|v| parse_list::<OpenOrderInfo>(v, "委托列表").map_err(|e| e.to_message()))
}

// ---------------------------------------------------------------------------
// 条件单
// ---------------------------------------------------------------------------

/// 前端从 SQLite 读出的条件单（camelCase，与 TS 类型一致）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConditionalInput {
    pub id: String,
    pub account: String,
    pub symbol: String,
    #[serde(default)]
    pub name: String,
    /// price_above | price_below | change_up | change_down | time_reached
    pub trigger_type: String,
    pub threshold: f64,
    #[serde(default)]
    pub reference_price: f64,
    pub side: String,
    pub volume: f64,
    #[serde(default)]
    pub limit_price: Option<f64>,
    #[serde(default)]
    pub order_type: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub trade_date: String,
    #[serde(default)]
    pub fired_today: bool,
    #[serde(default)]
    pub note: String,
}

impl ConditionalInput {
    fn to_core(&self) -> Result<ConditionalOrder, String> {
        let kind = TriggerKind::from_str(&self.trigger_type)
            .ok_or_else(|| format!("未知触发类型：{}", self.trigger_type))?;
        let side = side_from_str(&self.side)?;
        let state = ConditionalState::from_str(&self.state).unwrap_or(ConditionalState::Armed);
        let order = ConditionalOrder {
            id: self.id.clone(),
            symbol: self.symbol.clone(),
            kind,
            threshold: self.threshold,
            reference_price: self.reference_price,
            side,
            volume: self.volume,
            limit_price: self.limit_price,
            state,
            trade_date: self.trade_date.clone(),
            fired_today: self.fired_today,
            note: self.note.clone(),
        };
        Ok(order)
    }
}

/// 单张条件单的检查结果，前端据此更新 SQLite 与提示。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConditionalCheckResult {
    pub id: String,
    pub symbol: String,
    /// armed / triggered / filled / failed / cancelled
    pub state: String,
    pub fired_today: bool,
    pub triggered: bool,
    pub message: String,
    pub client_order_id: String,
    pub gateway_order_id: String,
    /// 触发后下单被风控拦截时，把风险原因带回来
    pub risk: Option<RiskReport>,
}

/// 评估并执行条件单。
///
/// 只处理属于当前交易日的 `armed` 条件单；跨日条件单直接标记为 `cancelled`（与
/// `qbot_core::conditional::rollover` 语义一致），避免隔夜单意外成交。
pub async fn check_conditionals(
    store: &Store,
    cfg: &GatewayConfig,
    items: Vec<ConditionalInput>,
    today_order_count: usize,
    today_turnover: f64,
) -> Result<Vec<ConditionalCheckResult>, String> {
    let clock = clock_now();
    let gw = Gateway::new(cfg)?;

    // 批量取价：一次请求拿全，避免逐单请求
    let symbols: Vec<String> = items
        .iter()
        .map(|i| i.symbol.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();

    let quotes: Vec<QuoteInfo> = if symbols.is_empty() {
        Vec::new()
    } else {
        gw.get("/api/v1/quotes", &[("symbols", symbols.join(","))])
            .await
            .map_err(|e| e.to_message())
            .and_then(|v| parse_list::<QuoteInfo>(v, "行情").map_err(|e| e.to_message()))?
    };

    // 上一价：用最新价缓存近似。网关若提供 prevClose，则优先用它做「跨越」的另一端，
    // 这样「开盘价已在阈值上方」的情况不会因为缺历史 tick 而永远不触发。
    let price_of = |symbol: &str, fallback: f64| -> (f64, f64) {
        let key = symbol.trim().to_uppercase();
        quotes
            .iter()
            .find(|q| q.symbol.trim().to_uppercase() == key)
            .map(|q| {
                let prev = if q.prev_close > 0.0 {
                    q.prev_close
                } else {
                    q.last_price
                };
                (
                    prev,
                    if q.last_price > 0.0 {
                        q.last_price
                    } else {
                        fallback
                    },
                )
            })
            .unwrap_or((fallback, fallback))
    };

    let mut results = Vec::new();
    let mut orders_used = today_order_count;
    let mut turnover = today_turnover;

    for item in &items {
        let mut core = match item.to_core() {
            Ok(o) => o,
            Err(e) => {
                results.push(ConditionalCheckResult {
                    id: item.id.clone(),
                    symbol: item.symbol.clone(),
                    state: "failed".into(),
                    fired_today: false,
                    triggered: false,
                    message: e,
                    client_order_id: String::new(),
                    gateway_order_id: String::new(),
                    risk: None,
                });
                continue;
            }
        };

        // 跨日失效
        if !core.trade_date.is_empty() && core.trade_date != clock.trade_date {
            results.push(ConditionalCheckResult {
                id: item.id.clone(),
                symbol: item.symbol.clone(),
                state: ConditionalState::Cancelled.as_str().into(),
                fired_today: false,
                triggered: false,
                message: format!("跨日失效：条件单只对 {} 生效", core.trade_date),
                client_order_id: String::new(),
                gateway_order_id: String::new(),
                risk: None,
            });
            continue;
        }

        let (prev, last) = price_of(
            &core.symbol,
            core.effective_price_threshold().unwrap_or(core.threshold),
        );
        let tick = Tick {
            prev_price: prev,
            last_price: last,
            current_minute: clock.minute,
            trade_date: clock.trade_date.clone(),
        };
        let outcome = cond::evaluate(&core, &tick);

        match outcome {
            TriggerOutcome::NotTriggered { reason } => {
                results.push(ConditionalCheckResult {
                    id: item.id.clone(),
                    symbol: item.symbol.clone(),
                    state: core.state.as_str().into(),
                    fired_today: core.fired_today,
                    triggered: false,
                    message: reason,
                    client_order_id: String::new(),
                    gateway_order_id: String::new(),
                    risk: None,
                });
            }
            TriggerOutcome::Skipped { reason } => {
                results.push(ConditionalCheckResult {
                    id: item.id.clone(),
                    symbol: item.symbol.clone(),
                    state: core.state.as_str().into(),
                    fired_today: core.fired_today,
                    triggered: false,
                    message: reason,
                    client_order_id: String::new(),
                    gateway_order_id: String::new(),
                    risk: None,
                });
            }
            TriggerOutcome::Triggered { reason } => {
                cond::mark_triggered(&mut core);
                // 触发后立即下单，仍然走完整风控
                let placed = place_order(
                    store,
                    cfg,
                    &core.symbol,
                    core.side.as_str(),
                    if core.limit_price.is_some() {
                        "limit"
                    } else {
                        "market"
                    },
                    core.limit_price,
                    core.volume,
                    None,
                    orders_used,
                    turnover,
                )
                .await;

                match placed {
                    Ok(res) => {
                        if res.accepted {
                            orders_used += 1;
                            turnover += res.risk.amount;
                            results.push(ConditionalCheckResult {
                                id: item.id.clone(),
                                symbol: core.symbol.clone(),
                                state: ConditionalState::Filled.as_str().into(),
                                fired_today: true,
                                triggered: true,
                                message: format!(
                                    "{reason}；已下单（委托号 {}）",
                                    res.client_order_id
                                ),
                                client_order_id: res.client_order_id,
                                gateway_order_id: res.gateway_order_id,
                                risk: Some(res.risk),
                            });
                        } else {
                            // 风控拦截：条件单进入 failed，等用户改配置后手动重置
                            results.push(ConditionalCheckResult {
                                id: item.id.clone(),
                                symbol: core.symbol.clone(),
                                state: ConditionalState::Failed.as_str().into(),
                                fired_today: true,
                                triggered: true,
                                message: format!("{reason}；但风控拒绝：{}", res.risk.reason),
                                client_order_id: res.client_order_id,
                                gateway_order_id: String::new(),
                                risk: Some(res.risk),
                            });
                        }
                    }
                    Err(e) => {
                        results.push(ConditionalCheckResult {
                            id: item.id.clone(),
                            symbol: core.symbol.clone(),
                            state: ConditionalState::Failed.as_str().into(),
                            fired_today: true,
                            triggered: true,
                            message: format!("{reason}；下单失败：{e}"),
                            client_order_id: String::new(),
                            gateway_order_id: String::new(),
                            risk: None,
                        });
                    }
                }
            }
        }
    }

    Ok(results)
}

/// 供前端展示的条件单合法性问题（保存前自查）。
pub fn validate_conditional(item: &ConditionalInput) -> Result<(), String> {
    item.to_core()?.validate()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_raw_passthrough() {
        let v = serde_json::json!([{"symbol": "600519"}]);
        assert!(extract_payload(v.clone()).is_ok());
        assert_eq!(
            extract_payload(v).unwrap(),
            serde_json::json!([{"symbol": "600519"}])
        );
    }

    #[test]
    fn envelope_code_zero() {
        let v = serde_json::json!({"code": 0, "message": "ok", "data": {"a": 1}});
        assert_eq!(extract_payload(v).unwrap(), serde_json::json!({"a": 1}));
    }

    #[test]
    fn envelope_code_error() {
        let v = serde_json::json!({"code": 4001, "message": "资金不足"});
        let err = extract_payload(v).unwrap_err();
        assert_eq!(err.kind, "rejected");
        assert!(err.message.contains("资金不足"));
    }

    #[test]
    fn envelope_success_false() {
        let v = serde_json::json!({"success": false, "error": "账户未登录"});
        assert!(extract_payload(v).is_err());
    }

    #[test]
    fn list_accepts_items_wrapper() {
        let v = serde_json::json!({"items": [{"symbol": "000001"}]});
        let out = parse_list::<PositionInfo>(v, "持仓").unwrap();
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn position_alias_and_fallback_value() {
        let p: PositionInfo =
            serde_json::from_str(r#"{"symbol":"600519","qty":100,"last_price":20.0}"#).unwrap();
        assert_eq!(p.volume, 100.0);
        assert!((p.effective_market_value() - 2000.0).abs() < 1e-9);
    }

    #[test]
    fn risk_config_roundtrip() {
        let cfg = RiskLimitsConfig::default();
        let core = cfg.to_core().unwrap();
        assert_eq!(core.sessions.len(), 2);
        assert_eq!(core.lot_size, 100.0);
    }

    #[test]
    fn risk_config_rejects_bad_session() {
        let mut cfg = RiskLimitsConfig::default();
        cfg.sessions = vec!["9:30".into()];
        assert!(cfg.to_core().is_err());
    }

    #[test]
    fn side_parsing() {
        assert_eq!(side_from_str("buy"), Ok(Side::Buy));
        assert_eq!(side_from_str("卖出"), Ok(Side::Sell));
        assert!(side_from_str("x").is_err());
    }

    #[test]
    fn order_type_normalization() {
        assert_eq!(normalize_order_type("MKT"), "limit");
        assert_eq!(normalize_order_type("market"), "market");
        assert_eq!(normalize_order_type("限价"), "limit");
    }

    #[test]
    fn conditional_input_maps_to_core() {
        let item = ConditionalInput {
            id: "c1".into(),
            account: "default".into(),
            symbol: "600519".into(),
            name: "贵州茅台".into(),
            trigger_type: "price_below".into(),
            threshold: 1500.0,
            reference_price: 0.0,
            side: "sell".into(),
            volume: 100.0,
            limit_price: None,
            order_type: "market".into(),
            state: "armed".into(),
            trade_date: "2026-10-18".into(),
            fired_today: false,
            note: String::new(),
        };
        let core = item.to_core().unwrap();
        assert_eq!(core.kind, TriggerKind::PriceBelow);
        assert_eq!(core.side, Side::Sell);
        assert!(validate_conditional(&item).is_ok());
    }

    #[test]
    fn conditional_input_rejects_unknown_trigger() {
        let mut item = ConditionalInput {
            id: "c1".into(),
            account: "default".into(),
            symbol: "600519".into(),
            name: String::new(),
            trigger_type: "moon_phase".into(),
            threshold: 1.0,
            reference_price: 0.0,
            side: "buy".into(),
            volume: 100.0,
            limit_price: None,
            order_type: "limit".into(),
            state: "armed".into(),
            trade_date: "2026-10-18".into(),
            fired_today: false,
            note: String::new(),
        };
        assert!(item.to_core().is_err());
        item.trigger_type = "price_above".into();
        assert!(item.to_core().is_ok());
    }

    #[test]
    fn clock_is_sane() {
        let c = clock_now();
        assert!(c.minute < 24 * 60);
        assert_eq!(c.trade_date.len(), 10);
    }
}
