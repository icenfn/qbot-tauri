-- 交易日志：只保留交易相关日志（下单 / 成交 / 撤单 / 风控拦截 / 异常）
CREATE TABLE IF NOT EXISTS trade_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    account    TEXT NOT NULL DEFAULT 'default',
    symbol     TEXT NOT NULL,
    name       TEXT NOT NULL DEFAULT '',
    side       TEXT NOT NULL,
    price      REAL NOT NULL DEFAULT 0,
    volume     REAL NOT NULL DEFAULT 0,
    amount     REAL NOT NULL DEFAULT 0,
    status     TEXT NOT NULL DEFAULT 'created',
    source     TEXT NOT NULL DEFAULT 'manual',
    message    TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trade_log_created ON trade_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trade_log_symbol ON trade_log (symbol);
