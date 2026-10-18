//! 数据库迁移定义。
//!
//! 由 tauri-plugin-sql 在首次 `Database.load("sqlite:qbot.db")` 时自动执行，
//! 通过 `_sqlx_migrations` 表记录版本，保证幂等。

use tauri_plugin_sql::{Migration, MigrationKind};

pub fn all() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "create_watchlist",
            sql: include_str!("../migrations/0001_watchlist.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "create_kline_cache",
            sql: include_str!("../migrations/0002_kline_cache.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "create_trade_log",
            sql: include_str!("../migrations/0003_trade_log.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "create_app_meta",
            sql: include_str!("../migrations/0004_app_meta.sql"),
            kind: MigrationKind::Up,
        },
    ]
}
