import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { config } from './config.ts'
import { sqlite } from './db/index.ts'
import { r2 } from './r2.ts'

const KEEP_LOCAL = 3
const KEEP_REMOTE = 30
const PREFIX = 'backups/'

/**
 * Uploaded files already live in R2, so a backup is a consistent copy of the database.
 * The random part of the name means the key cannot be guessed from the date.
 */
export async function runBackup() {
  await fs.mkdir(config.backupsDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const name = `app-${stamp}-${randomBytes(16).toString('hex')}.db.gz`
  const copy = path.join(config.backupsDir, `${name}.tmp`)
  sqlite.prepare('VACUUM INTO ?').run(copy)
  const archive = path.join(config.backupsDir, name)
  const compressed = gzipSync(await fs.readFile(copy))
  await fs.writeFile(archive, compressed)
  await fs.rm(copy)

  const bucket = r2()
  if (bucket) {
    await bucket.client.send(
      new PutObjectCommand({ Bucket: bucket.bucket, Key: `${PREFIX}${name}`, Body: compressed }),
    )
    const listed = await bucket.client.send(
      new ListObjectsV2Command({ Bucket: bucket.bucket, Prefix: PREFIX }),
    )
    const keys = (listed.Contents ?? []).flatMap((item) => (item.Key ? [item.Key] : [])).sort()
    for (const key of keys.slice(0, -KEEP_REMOTE)) {
      await bucket.client.send(new DeleteObjectCommand({ Bucket: bucket.bucket, Key: key }))
    }
  }

  const local = (await fs.readdir(config.backupsDir)).filter((file) => file.endsWith('.db.gz'))
  for (const file of local.sort().slice(0, -KEEP_LOCAL)) {
    await fs.rm(path.join(config.backupsDir, file))
  }
  return archive
}

/** Returns the database bytes from a local archive, or the newest one in R2. */
export async function loadBackup(source?: string): Promise<Uint8Array> {
  if (source) return gunzipSync(await fs.readFile(source))
  const bucket = r2()
  if (!bucket) throw new Error('Give a backup file path, or set up R2 to restore the latest')
  const listed = await bucket.client.send(
    new ListObjectsV2Command({ Bucket: bucket.bucket, Prefix: PREFIX }),
  )
  const latest = (listed.Contents ?? [])
    .flatMap((item) => (item.Key ? [item.Key] : []))
    .sort()
    .pop()
  if (!latest) throw new Error('No backups found in R2')
  const result = await bucket.client.send(
    new GetObjectCommand({ Bucket: bucket.bucket, Key: latest }),
  )
  if (!result.Body) throw new Error('Backup is empty')
  return gunzipSync(await result.Body.transformToByteArray())
}
