import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { workspaceInput } from '../../shared/auth.ts'
import type { AuthEnv } from '../auth.ts'
import { db, schema } from '../db/index.ts'
import { ApiError } from '../errors.ts'
import { membership } from '../services/workspaces.ts'
import { body } from './util.ts'

const { workspaces } = schema

export const workspaceRoutes = new Hono<AuthEnv>()

/** Renames the caller's workspace. Owners only. */
workspaceRoutes.put('/workspace', async (c) => {
  const { name } = await body(c, workspaceInput)
  const ws = c.get('workspaceId')
  if (membership(ws, c.get('userId'))?.role !== 'owner') {
    throw new ApiError(403, 'Only the owner can rename the workspace')
  }
  const row = db
    .update(workspaces)
    .set({ name })
    .where(eq(workspaces.id, ws))
    .returning({ id: workspaces.id, name: workspaces.name })
    .get()
  if (!row) throw new ApiError(404, 'Workspace not found')
  return c.json(row)
})
