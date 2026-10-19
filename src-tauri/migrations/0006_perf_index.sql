-- 第五阶段：查询索引与清理辅助。
--
-- 为什么需要这批索引：
-- 1. 交易日志页支持「日期区间 + 方向 + 状态 + 标的」的组合过滤。
--    `orders.created_at` 是 ISO 字符串，按前缀比较即可命中索引；
--    原先只有 (created_at DESC) 单列索引，加上方向/状态过滤后仍需回表扫描较多行。
-- 2. 条件单轮询每秒级扫描 `state = 'armed'`，已有单列索引，补充
--    `(state, trade_date)` 复合索引可直接定位「当日待评估」的行。
-- 3. 第四阶段迁移里 `orders` 只有 symbol 与 created_at 单列索引，
--    按「状态」查「风控拒绝 / 失败」记录时会全表扫。

CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_side_created ON orders (side, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_source ON orders (source);

CREATE INDEX IF NOT EXISTS idx_conditional_state_date ON conditional_orders (state, trade_date);

-- 第四阶段已建 idx_fills_order，这里补一个按成交时间排序的索引，
-- 便于「最近成交」类查询在成交记录变多后仍然快。
CREATE INDEX IF NOT EXISTS idx_fills_time ON fills (filled_at DESC);
