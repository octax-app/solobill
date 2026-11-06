import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.ts'

export function getSettings(ws: number) {
  const row = db.select().from(schema.settings).where(eq(schema.settings.workspaceId, ws)).get()
  if (!row) throw new Error(`Settings are missing for workspace ${ws}`)
  return row
}
