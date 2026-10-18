/**
 * 本地 SQLite 访问层。
 *
 * 使用 @tauri-apps/plugin-sql（底层 sqlx + bundled sqlite），三端均支持：
 *   Windows / Linux -> 应用数据目录下的 qbot.db
 *   Android         -> 应用私有数据目录下的 qbot.db
 *
 * 表结构由 Rust 侧 tauri-plugin-sql 的迁移统一创建（见 src-tauri/migrations），
 * 前端只负责加载连接，避免两处建表定义漂移。
 *
 * 浏览器预览环境没有 SQLite，业务层自动回退到 localStorage。
 */
import { isTauri } from '@/lib/tauri/env'

export interface ExecuteResult {
  rowsAffected: number
  lastInsertId?: number
}

export interface SqlDatabase {
  execute(query: string, values?: unknown[]): Promise<ExecuteResult>
  select<T>(query: string, values?: unknown[]): Promise<T>
}

let dbPromise: Promise<SqlDatabase> | null = null

async function openDatabase(): Promise<SqlDatabase> {
  const { default: Database } = await import('@tauri-apps/plugin-sql')
  const db = await Database.load('sqlite:qbot.db')
  return db as unknown as SqlDatabase
}

export function getDatabase(): Promise<SqlDatabase> {
  if (!dbPromise) {
    dbPromise = openDatabase()
  }
  return dbPromise
}

/** 应用启动时调用；失败不阻断 UI，仅记录日志 */
export async function ensureDatabase(): Promise<void> {
  if (!isTauri()) {
    console.info('[db] 浏览器预览环境，使用 localStorage 回退存储')
    return
  }
  try {
    await getDatabase()
    console.info('[db] SQLite 连接就绪（迁移由 Rust 侧执行）')
  } catch (error) {
    console.error('[db] SQLite 初始化失败，自选等功能将不可用', error)
  }
}

export function nowIso(): string {
  return new Date().toISOString()
}
