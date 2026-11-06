import { and, desc, eq, isNull, or } from 'drizzle-orm'
import { Hono } from 'hono'
import { todayISO } from '../../shared/dates.ts'
import { CURRENCIES } from '../../shared/money.ts'
import { deviceInput, settingsInput } from '../../shared/schemas.ts'
import type { AuthEnv } from '../auth.ts'
import { db, schema } from '../db/index.ts'
import { ApiError, notFound } from '../errors.ts'
import { hasFinancialData } from '../services/invoices.ts'
import { customerSummary, overview } from '../services/overview.ts'
import { registerDevice } from '../services/push.ts'
import { getSettings } from '../services/settings.ts'
import { readFile, sniff } from '../storage.ts'
import { body, hideWorkspaceId, idParam } from './util.ts'

const { fonts, invoices, originalInvoices, providers, reminders, settings, templates } = schema

export const miscRoutes = new Hono<AuthEnv>()
miscRoutes.use('*', hideWorkspaceId)

miscRoutes.get('/settings', (c) => {
  const ws = c.get('workspaceId')
  return c.json({
    ...getSettings(ws),
    baseCurrencyLocked: hasFinancialData(ws),
    currencies: CURRENCIES,
  })
})

miscRoutes.put('/settings', async (c) => {
  const ws = c.get('workspaceId')
  const input = await body(c, settingsInput)
  const current = getSettings(ws)
  if (input.baseCurrency !== current.baseCurrency && hasFinancialData(ws)) {
    throw new ApiError(409, 'The base currency is locked because invoices already exist')
  }
  db.update(settings)
    .set(input)
    .where(and(eq(settings.workspaceId, ws), eq(settings.id, current.id)))
    .run()
  return c.json(getSettings(ws))
})

miscRoutes.get('/overview', (c) => {
  const today = todayISO()
  const from = c.req.query('from') ?? `${today.slice(0, 7)}-01`
  const to = c.req.query('to') ?? today
  return c.json(overview(c.get('workspaceId'), from, to, today))
})

miscRoutes.get('/customers/:id/summary', (c) =>
  c.json(customerSummary(c.get('workspaceId'), idParam(c))),
)

miscRoutes.post('/devices', async (c) => {
  const apiTokenId = c.get('apiTokenId')
  if (!apiTokenId) throw new ApiError(403, 'Only the app can register for notifications')
  const { token, environment } = await body(c, deviceInput)
  registerDevice(apiTokenId, token, environment)
  return c.json({ ok: true })
})

miscRoutes.get('/reminders', (c) =>
  c.json(
    db
      .select()
      .from(reminders)
      .where(and(eq(reminders.workspaceId, c.get('workspaceId')), isNull(reminders.readAt)))
      .orderBy(desc(reminders.id))
      .all(),
  ),
)

miscRoutes.post('/reminders/:id/read', (c) => {
  const read = db
    .update(reminders)
    .set({ readAt: new Date().toISOString() })
    .where(and(eq(reminders.workspaceId, c.get('workspaceId')), eq(reminders.id, idParam(c))))
    .returning({ id: reminders.id })
    .get()
  if (!read) throw notFound('Reminder')
  return c.json({ ok: true })
})

/**
 * Whether a row in this workspace points at the stored file. The clients address files by the
 * key on that row, so the key is only served when its owning row is the caller's.
 */
function ownsFile(ws: number, key: string) {
  const owners = [
    () =>
      db
        .select({ id: templates.id })
        .from(templates)
        .where(
          and(
            eq(templates.workspaceId, ws),
            or(eq(templates.pdfFile, key), eq(templates.companyLogoFile, key)),
          ),
        )
        .get(),
    () =>
      db
        .select({ id: fonts.id })
        .from(fonts)
        .where(
          and(eq(fonts.workspaceId, ws), or(eq(fonts.regularFile, key), eq(fonts.boldFile, key))),
        )
        .get(),
    () =>
      db
        .select({ id: providers.id })
        .from(providers)
        .where(and(eq(providers.workspaceId, ws), eq(providers.logoFile, key)))
        .get(),
    () =>
      db
        .select({ id: originalInvoices.id })
        .from(originalInvoices)
        .where(and(eq(originalInvoices.workspaceId, ws), eq(originalInvoices.pdfFile, key)))
        .get(),
    () =>
      db
        .select({ id: invoices.id })
        .from(invoices)
        .where(and(eq(invoices.workspaceId, ws), eq(invoices.pdfFile, key)))
        .get(),
  ]
  return owners.some((find) => find() !== undefined)
}

miscRoutes.get('/files/*', async (c) => {
  const key = decodeURIComponent(c.req.path.split('/files/')[1] ?? '')
  if (!ownsFile(c.get('workspaceId'), key)) throw new ApiError(404, 'File not found')
  const bytes = await readFile(key)
  const type = sniff(bytes)?.contentType ?? 'application/octet-stream'
  return c.body(Buffer.from(bytes), 200, {
    'Content-Type': type,
    'Content-Disposition': 'inline',
  })
})
