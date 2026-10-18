-- K 线 / 净值离线缓存，减少对后端与 AkShare 的重复请求
CREATE TABLE IF NOT EXISTS kline_cache (
    symbol     TEXT NOT NULL,
    period     TEXT NOT NULL,
    adjust     TEXT NOT NULL,
    payload    TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (symbol, period, adjust)
);

CREATE INDEX IF NOT EXISTS idx_kline_cache_updated ON kline_cache (updated_at);
