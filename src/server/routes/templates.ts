import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { z } from 'zod'
import { percentText } from '../../shared/money.ts'
import { previewInput, templateDetailsInput, templateLayoutInput } from '../../shared/schemas.ts'
import type { AuthEnv } from '../auth.ts'
import { db, schema } from '../db/index.ts'
import { ApiError } from '../errors.ts'
import { inspectTemplate } from '../pdf/engine.ts'
import { samplePayload } from '../pdf/sample.ts'
import { assertFontsExist } from '../services/fonts.ts'
import { renderWithTemplate } from '../services/template-render.ts'
import { getRegions, getTemplate, templateProblems, templateUsage } from '../services/templates.ts'
import { removeFile, saveFile } from '../storage.ts'
import { body, hideWorkspaceId, idParam, uploaded } from './util.ts'

const { invoices, templateRegions, templates } = schema

function present(template: typeof templates.$inferSelect) {
  const regions = getRegions(template.workspaceId, template.id)
  const problems = templateProblems(template, regions)
  return { ...template, regions, problems, ready: problems.length === 0 }
}

export const templateRoutes = new Hono<AuthEnv>()
templateRoutes.use('*', hideWorkspaceId)

const byId = (ws: number, id: number) => and(eq(templates.workspaceId, ws), eq(templates.id, id))

templateRoutes.get('/', (c) =>
  c.json(
    db
      .select()
      .from(templates)
      .where(eq(templates.workspaceId, c.get('workspaceId')))
      .orderBy(templates.id)
      .all()
      .map(present),
  ),
)

templateRoutes.get('/:id', (c) => {
  const ws = c.get('workspaceId')
  const template = getTemplate(ws, idParam(c))
  return c.json({ ...present(template), usage: templateUsage(ws, template.id) })
})

templateRoutes.post('/', async (c) => {
  const form = await c.req.parseBody()
  const file = form.file
  if (!(file instanceof File)) throw new ApiError(422, 'Choose a PDF to upload')
  const name = typeof form.name === 'string' ? form.name.trim() : ''
  const bytes = new Uint8Array(await file.arrayBuffer())
  const pdfFile = await saveFile('templates', bytes, 'pdf')
  try {
    const info = await inspectTemplate(bytes)
    const created = db
      .insert(templates)
      .values({
        workspaceId: c.get('workspaceId'),
        name: name || file.name.replace(/\.pdf$/i, ''),
        kind: 'uploaded',
        pdfFile,
        pageCount: info.pageCount,
      })
      .returning()
      .get()
    return c.json(present(created), 201)
  } catch (error) {
    await removeFile(pdfFile)
    throw error
  }
})

templateRoutes.put('/:id', async (c) => {
  const ws = c.get('workspaceId')
  const id = idParam(c)
  getTemplate(ws, id)
  const input = await body(c, templateDetailsInput)
  return c.json(present(db.update(templates).set(input).where(byId(ws, id)).returning().get()))
})

const isUnique = (values: unknown[]) => new Set(values).size === values.length

/** Saving a layout and previewing an unsaved one refuse the same mistakes. */
function assertLayout(
  ws: number,
  template: typeof templates.$inferSelect,
  { regions, style, separators = [], customFields = [] }: z.infer<typeof templateLayoutInput>,
) {
  if (!isUnique(regions.map((region) => region.key))) {
    throw new ApiError(422, 'Each region can only be mapped once')
  }
  if (regions.some((region) => region.page >= template.pageCount)) {
    throw new ApiError(422, 'A region is on a page this PDF does not have')
  }
  if (separators.some((separator) => separator.page >= template.pageCount)) {
    throw new ApiError(422, 'A line is on a page this PDF does not have')
  }
  if (!isUnique(separators.map((separator) => separator.id))) {
    throw new ApiError(422, 'Each line needs its own id')
  }
  if (!isUnique(customFields.map((field) => field.id))) {
    throw new ApiError(422, 'Each custom item needs its own id')
  }
  assertFontsExist(ws, [style?.fontId, ...regions.map((region) => region.fontId)])
}

templateRoutes.put('/:id/regions', async (c) => {
  const ws = c.get('workspaceId')
  const id = idParam(c)
  const template = getTemplate(ws, id)
  const layout = await body(c, templateLayoutInput)
  assertLayout(ws, template, layout)
  const { regions, style, separators, customFields } = layout
  db.transaction((tx) => {
    tx.delete(templateRegions)
      .where(and(eq(templateRegions.workspaceId, ws), eq(templateRegions.templateId, id)))
      .run()
    if (regions.length) {
      tx.insert(templateRegions)
        .values(regions.map((region) => ({ ...region, workspaceId: ws, templateId: id })))
        .run()
    }
    if (style || separators || customFields) {
      tx.update(templates)
        .set({ ...style, separators, customFields })
        .where(byId(ws, id))
        .run()
    }
  })
  return c.json(present(getTemplate(ws, id)))
})

templateRoutes.post('/:id/default', (c) => {
  const ws = c.get('workspaceId')
  const id = idParam(c)
  getTemplate(ws, id)
  db.transaction((tx) => {
    tx.update(templates).set({ isDefault: false }).where(eq(templates.workspaceId, ws)).run()
    tx.update(templates).set({ isDefault: true }).where(byId(ws, id)).run()
  })
  return c.json(present(getTemplate(ws, id)))
})

templateRoutes.post('/:id/logo', async (c) => {
  const ws = c.get('workspaceId')
  const id = idParam(c)
  const template = getTemplate(ws, id)
  const companyLogoFile = await saveFile('logos', await uploaded(c), 'image')
  await removeFile(template.companyLogoFile)
  return c.json(
    present(db.update(templates).set({ companyLogoFile }).where(byId(ws, id)).returning().get()),
  )
})

templateRoutes.post('/:id/preview', async (c) => {
  const ws = c.get('workspaceId')
  const template = getTemplate(ws, idParam(c))
  const { layout, ...options } = await body(c, previewInput)
  if (layout) assertLayout(ws, template, layout)
  const bytes = await renderWithTemplate(
    ws,
    template,
    samplePayload(
      {
        name: template.companyName || 'Your company name',
        address: template.companyAddress,
        taxNumber: template.taxNumber,
      },
      template.bankDetails,
      percentText(template.defaultTaxRate),
      options,
      layout?.customFields ?? template.customFields,
    ),
    layout,
  )
  return c.body(Buffer.from(bytes), 200, { 'Content-Type': 'application/pdf' })
})

templateRoutes.delete('/:id', async (c) => {
  const ws = c.get('workspaceId')
  const id = idParam(c)
  const template = getTemplate(ws, id)
  if (template.kind === 'system') throw new ApiError(409, 'The system template cannot be deleted')
  if (template.isDefault) {
    throw new ApiError(409, 'Choose another default template before deleting this one')
  }
  const usage = templateUsage(ws, id)
  if (usage.providers.length || usage.services.length) {
    throw new ApiError(409, 'This template is assigned. Change those assignments first.')
  }
  const used = db
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.workspaceId, ws), eq(invoices.templateId, id)))
    .get()
  if (used) {
    throw new ApiError(409, 'Invoices use this template, so it cannot be deleted')
  }
  db.delete(templates).where(byId(ws, id)).run()
  await removeFile(template.pdfFile)
  await removeFile(template.companyLogoFile)
  return c.json({ ok: true })
})
