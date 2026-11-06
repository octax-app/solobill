import { and, asc, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.ts'
import { buildSystemTemplatePdf, SYSTEM_REGIONS } from '../pdf/system-template.ts'
import { removeFile, saveFile } from '../storage.ts'

const {
  fonts,
  invoices,
  memberships,
  originalInvoices,
  providers,
  settings,
  templateRegions,
  templates,
  workspaces,
} = schema

export type Role = (typeof memberships.$inferSelect)['role']

/** Settings and the system template, which every workspace needs. Safe to run again. */
export async function provisionWorkspace(ws: number) {
  if (!db.select().from(settings).where(eq(settings.workspaceId, ws)).get()) {
    db.insert(settings).values({ workspaceId: ws }).run()
  }
  const hasSystem = db
    .select({ id: templates.id })
    .from(templates)
    .where(and(eq(templates.workspaceId, ws), eq(templates.kind, 'system')))
    .get()
  if (hasSystem) return
  // Each workspace gets its own copy of the file, so deleting one workspace never touches another.
  const pdfFile = await saveFile('templates', await buildSystemTemplatePdf(), 'pdf')
  db.transaction((tx) => {
    const template = tx
      .insert(templates)
      .values({
        workspaceId: ws,
        name: 'System template',
        kind: 'system',
        isDefault: true,
        pdfFile,
      })
      .returning()
      .get()
    tx.insert(templateRegions)
      .values(
        SYSTEM_REGIONS.map((region) => ({ ...region, workspaceId: ws, templateId: template.id })),
      )
      .run()
  })
}

/** A new workspace with `userId` as its owner. */
export async function createWorkspace(name: string, ownerUserId: number) {
  const workspace = db.transaction((tx) => {
    const row = tx.insert(workspaces).values({ name }).returning().get()
    tx.insert(memberships).values({ workspaceId: row.id, userId: ownerUserId, role: 'owner' }).run()
    return row
  })
  await provisionWorkspace(workspace.id)
  return workspace
}

/** The workspace a user signs in to. One per user for now; teams will pick one. */
export function defaultWorkspaceFor(userId: number) {
  return (
    db
      .select({ workspaceId: memberships.workspaceId })
      .from(memberships)
      .where(eq(memberships.userId, userId))
      .orderBy(asc(memberships.id))
      .get()?.workspaceId ?? null
  )
}

export function membership(ws: number, userId: number) {
  return (
    db
      .select()
      .from(memberships)
      .where(and(eq(memberships.workspaceId, ws), eq(memberships.userId, userId)))
      .get() ?? null
  )
}

export function getWorkspace(ws: number) {
  return db.select().from(workspaces).where(eq(workspaces.id, ws)).get() ?? null
}

/** Every stored file the workspace's rows point at. */
function workspaceFiles(ws: number): string[] {
  const keys = [
    ...db
      .select({ a: templates.pdfFile, b: templates.companyLogoFile })
      .from(templates)
      .where(eq(templates.workspaceId, ws))
      .all()
      .flatMap((r) => [r.a, r.b]),
    ...db
      .select({ a: fonts.regularFile, b: fonts.boldFile })
      .from(fonts)
      .where(eq(fonts.workspaceId, ws))
      .all()
      .flatMap((r) => [r.a, r.b]),
    ...db
      .select({ a: providers.logoFile })
      .from(providers)
      .where(eq(providers.workspaceId, ws))
      .all()
      .map((r) => r.a),
    ...db
      .select({ a: originalInvoices.pdfFile })
      .from(originalInvoices)
      .where(eq(originalInvoices.workspaceId, ws))
      .all()
      .map((r) => r.a),
    ...db
      .select({ a: invoices.pdfFile })
      .from(invoices)
      .where(eq(invoices.workspaceId, ws))
      .all()
      .map((r) => r.a),
  ]
  return [...new Set(keys.filter((k): k is string => Boolean(k)))]
}

/**
 * Deletes the workspace, every row in it (by cascade) and its stored files. Files go after the
 * rows, so a failure part way leaves orphan files rather than rows pointing at missing files.
 */
export async function deleteWorkspace(ws: number) {
  const files = workspaceFiles(ws)
  db.delete(workspaces).where(eq(workspaces.id, ws)).run()
  for (const key of files) {
    try {
      await removeFile(key)
    } catch (error) {
      console.error('Could not delete a stored file of a deleted workspace', error)
    }
  }
}
