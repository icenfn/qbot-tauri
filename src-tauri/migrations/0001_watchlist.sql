-- 自选标的（A股 / 基金 / 指数）
CREATE TABLE IF NOT EXISTS watchlist (
    symbol     TEXT PRIMARY KEY,
    name       TEXT NOT NULL DEFAULT '',
    kind       TEXT NOT NULL DEFAULT 'stock',
    grp        TEXT NOT NULL DEFAULT 'default',
    sort       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_watchlist_kind ON watchlist (kind);
CREATE INDEX IF NOT EXISTS idx_watchlist_sort ON watchlist (sort);
