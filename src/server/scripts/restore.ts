/**
 * Restores the database. Stop the app first.
 *   pnpm restore                 newest backup in R2
 *   pnpm restore path/to/x.db.gz a local archive
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.ts'

// Imported after the file is replaced would be too late, so load the backup through a
// path that never opens the live database.
process.env.DATABASE_PATH = ':memory:'
const { loadBackup } = await import('../backup.ts')
const bytes = await loadBackup(process.argv[2])
await fs.mkdir(path.dirname(config.databasePath), { recursive: true })
for (const suffix of ['', '-wal', '-shm']) {
  await fs.rm(`${config.databasePath}${suffix}`, { force: true })
}
await fs.writeFile(config.databasePath, bytes)
console.log(`Restored ${bytes.byteLength} bytes to ${config.databasePath}`)
