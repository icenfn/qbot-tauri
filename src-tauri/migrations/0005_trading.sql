-- 交易落地记录：委托 / 成交 / 条件单。
--
-- 设计说明：
-- 1. 这三张表是「本地账本」，记录本机发出的每一笔委托与成交，便于复盘与风控统计
--    （今日笔数、今日成交额都从这里聚合）。真实持仓以交易网关为准，本地不重复记账。
-- 2. `orders.id` 用客户端生成的 ID（client_order_id），保证「本地先落库、再发网关」时
--    不会因为网络重试产生重复委托：网关侧按该 ID 做幂等。
-- 3. 条件单与订单分表：条件单是被动等待触发的规则，生命周期（armed/triggered/…）
--    与委托状态机不同，混在一张表会让查询与状态迁移都变复杂。

CREATE TABLE IF NOT EXISTS orders (
    id               TEXT PRIMARY KEY,
    gateway_order_id TEXT NOT NULL DEFAULT '',
    account          TEXT NOT NULL DEFAULT 'default',
    symbol           TEXT NOT NULL,
    name             TEXT NOT NULL DEFAULT '',
    side             TEXT NOT NULL,
    order_type       TEXT NOT NULL DEFAULT 'limit',
    price            REAL NOT NULL DEFAULT 0,
    volume           REAL NOT NULL DEFAULT 0,
    amount           REAL NOT NULL DEFAULT 0,
    status           TEXT NOT NULL DEFAULT 'pending',
    source           TEXT NOT NULL DEFAULT 'manual',
    conditional_id   TEXT,
    message          TEXT NOT NULL DEFAULT '',
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_created ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_symbol ON orders (symbol);

CREATE TABLE IF NOT EXISTS fills (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id  TEXT NOT NULL,
    price     REAL NOT NULL DEFAULT 0,
    volume    REAL NOT NULL DEFAULT 0,
    amount    REAL NOT NULL DEFAULT 0,
    fee       REAL NOT NULL DEFAULT 0,
    filled_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fills_order ON fills (order_id);

CREATE TABLE IF NOT EXISTS conditional_orders (
    id              TEXT PRIMARY KEY,
    account         TEXT NOT NULL DEFAULT 'default',
    symbol          TEXT NOT NULL,
    name            TEXT NOT NULL DEFAULT '',
    trigger_type    TEXT NOT NULL,
    threshold       REAL NOT NULL DEFAULT 0,
    reference_price REAL NOT NULL DEFAULT 0,
    side            TEXT NOT NULL,
    volume          REAL NOT NULL DEFAULT 0,
    limit_price     REAL,
    order_type      TEXT NOT NULL DEFAULT 'limit',
    state           TEXT NOT NULL DEFAULT 'armed',
    trade_date      TEXT NOT NULL,
    fired_today     INTEGER NOT NULL DEFAULT 0,
    note            TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conditional_state ON conditional_orders (state);
CREATE INDEX IF NOT EXISTS idx_conditional_symbol ON conditional_orders (symbol);
