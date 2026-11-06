import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { config } from '../config.ts'
import * as schema from './schema.ts'

if (config.databasePath !== ':memory:') {
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true })
}

export const sqlite = new Database(config.databasePath)
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('foreign_keys = ON')
sqlite.pragma('busy_timeout = 5000')

export const db = drizzle(sqlite, { schema })
export { schema }

/**
 * Foreign keys are off while migrating, as SQLite's table-rebuild procedure requires: with them
 * on, dropping a parent table during a rebuild would cascade-delete its children. The check
 * afterwards fails the start if a migration left a dangling reference.
 */
export function runMigrations() {
  sqlite.pragma('foreign_keys = OFF')
  try {
    migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '../../../drizzle') })
    const broken = sqlite.pragma('foreign_key_check') as unknown[]
    if (broken.length > 0) {
      throw new Error(`Migration left broken references: ${JSON.stringify(broken.slice(0, 5))}`)
    }
  } finally {
    sqlite.pragma('foreign_keys = ON')
  }
}
