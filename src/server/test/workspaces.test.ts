import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import http2 from 'node:http2'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { PDFDocument } from '@cantoo/pdf-lib'
import { is } from 'drizzle-orm'
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { config } from '../config.ts'
import { db, schema, sqlite } from '../db/index.ts'
import { fixtureFont } from '../pdf/test-helpers.ts'
import { type ApnsSettings, deliverReminders } from '../services/push.ts'
import { runReminders, runRenewals } from '../services/renewals.ts'
import { deleteWorkspace } from '../services/workspaces.ts'
import {
  configureTemplate,
  draftBody,
  EMAIL,
  line,
  PASSWORD,
  setup,
  setupWorkspace,
} from './helpers.ts'

/**
 * Plan 22: no request, job or file route can read or change another workspace's data.
 * Workspace A is full of data. Workspace B tries to reach it with A's real ids, in the path and
 * in the body, and every attempt must give 404 (or 422 for a body reference) and change nothing.
 */

type Ctx = Awaited<ReturnType<typeof setup>>
type Json = Record<string, any>

const TODAY = '2026-11-02'
/** Late enough that A's and B's issued invoices are overdue and their originals are due. */
const LATER = '2026-12-15'
const B_EMAIL = 'second-business@example.com'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
const PDF = new TextEncoder().encode('%PDF-1.4 sample')
const TTF = fixtureFont('test-fonts/latin-only.ttf')
const ALL_TIME = '/overview?from=0000-01-01&to=9999-12-31'
const openapi = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, '../../../openapi.json'), 'utf8'),
) as { paths: Record<string, Json> }
const USD = { currency: 'USD', fxRate: 100_000_000 }

let a: Ctx
let b: Awaited<ReturnType<typeof setupWorkspace>>

/** Workspace A's ids, filled in `beforeAll`. */
const A = {
  ws: 0,
  customerId: 0,
  providerId: 0,
  serviceId: 0,
  subscriptionId: 0,
  subscriptionLineIds: [] as number[],
  fontId: 0,
  systemTemplateId: 0,
  uploadedTemplateId: 0,
  originalId: 0,
  originalLineId: 0,
  draftId: 0,
  issuedId: 0,
  issued2Id: 0,
  paidId: 0,
  proformaId: 0,
  renewalDraftId: 0,
  paymentIds: [] as number[],
  reminderIds: [] as number[],
  tokenId: 0,
  token: '',
}

/** Workspace B's own rows, used to build valid bodies so only A's id can make a call fail. */
const B = {
  ws: 0,
  templateId: 0,
  customerId: 0,
  providerId: 0,
  serviceId: 0,
  subscriptionId: 0,
  subscriptionLineId: 0,
  originalId: 0,
  draftId: 0,
  draftLineId: 0,
  issuedId: 0,
}

/* Helpers */

function ok(res: { status: number; json: unknown }, status?: number) {
  const detail = JSON.stringify(res.json)
  if (status) expect(res.status, detail).toBe(status)
  else expect(res.status, detail).toBeLessThan(300)
  return res.json as Json
}

const fileForm = (bytes: Uint8Array, name: string, fields: Record<string, string> = {}) => {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.set(key, value)
  form.set('file', new File([bytes as BlobPart], name))
  return form
}

/** JSON through `api`, or a multipart form with the same cookie. */
async function send(ctx: Ctx, method: string, url: string, body?: unknown) {
  if (!(body instanceof FormData)) return ctx.api(method, url, body)
  const res = await ctx.app.request(`/api/v1${url}`, {
    method,
    headers: { Cookie: ctx.cookie },
    body,
  })
  const type = res.headers.get('content-type') ?? ''
  return { status: res.status, json: type.includes('json') ? await res.json() : null, res }
}

const serviceBody = (providerId: number, over: Json = {}) => ({
  providerId,
  name: 'Dedicated server',
  pricing: 'fixed',
  cycle: 'monthly',
  defaultCost: 600_000,
  defaultPrice: 1_000_000,
  currency: 'USD',
  ...over,
})

const subscriptionBody = (customerId: number, serviceId: number, over: Json = {}) => ({
  customerId,
  serviceId,
  cycle: 'monthly',
  startedOn: TODAY,
  costCurrency: 'USD',
  priceCurrency: 'USD',
  lines: [{ description: 'Server', costAmount: 400_000, priceAmount: 700_000 }],
  ...over,
})

const originalBody = (providerId: number, over: Json = {}) => ({
  providerId,
  number: 'ORIG-1',
  issuedOn: TODAY,
  dueOn: '2026-11-05',
  ...USD,
  lines: [{ description: 'Server', quantity: 10_000, unitPrice: 500_000 }],
  ...over,
})

const TEMPLATE_DETAILS = {
  name: 'Taken over',
  companyName: 'Someone else',
  companyAddress: '',
  taxNumber: '',
  bankDetails: '',
  defaultTaxRate: 50_000,
}

/* The database, read directly */

const tableConfigs = Object.values(schema)
  .flatMap((value) => (is(value, SQLiteTable) ? [value] : []))
  .map((table) => getTableConfig(table))

const hasWorkspace = (name: string) =>
  tableConfigs.find((t) => t.name === name)?.columns.some((c) => c.name === 'workspace_id') ?? false

/** Every table with a `workspace_id`. Sessions are left out: signing in legitimately writes them. */
const SCOPED_TABLES = tableConfigs
  .filter((t) => hasWorkspace(t.name) && t.name !== 'auth_sessions')
  .map((t) => t.name)

const rowsIn = (table: string, ws: number) =>
  sqlite.prepare(`SELECT * FROM "${table}" WHERE workspace_id = ? ORDER BY id`).all(ws) as Json[]

/** Every row a workspace owns, by table. */
const snapshot = (ws: number) =>
  Object.fromEntries(SCOPED_TABLES.map((table) => [table, rowsIn(table, ws)]))

const countIn = (table: string, ws: number) =>
  (
    sqlite.prepare(`SELECT count(*) AS n FROM "${table}" WHERE workspace_id = ?`).get(ws) as {
      n: number
    }
  ).n

const workspaceOf = (table: string, id: number) =>
  (
    sqlite.prepare(`SELECT workspace_id AS ws FROM "${table}" WHERE id = ?`).get(id) as
      | { ws: number }
      | undefined
  )?.ws

/** Every stored file a workspace's rows point at. */
function filesOf(ws: number) {
  const pick = (sql: string) =>
    (sqlite.prepare(sql).all(ws) as { key: string | null }[])
      .map((row) => row.key)
      .filter((key): key is string => Boolean(key))
  return {
    templatePdfs: pick('SELECT pdf_file AS key FROM templates WHERE workspace_id = ?'),
    templateLogos: pick('SELECT company_logo_file AS key FROM templates WHERE workspace_id = ?'),
    fonts: [
      ...pick('SELECT regular_file AS key FROM fonts WHERE workspace_id = ?'),
      ...pick('SELECT bold_file AS key FROM fonts WHERE workspace_id = ?'),
    ],
    providerLogos: pick('SELECT logo_file AS key FROM providers WHERE workspace_id = ?'),
    originalPdfs: pick('SELECT pdf_file AS key FROM original_invoices WHERE workspace_id = ?'),
    invoicePdfs: pick('SELECT pdf_file AS key FROM invoices WHERE workspace_id = ?'),
  }
}
const allFilesOf = (ws: number) => Object.values(filesOf(ws)).flat()
const stored = (key: string) => fs.existsSync(path.join(config.filesDir, key))

/**
 * Rows that point at a row in another workspace. Every foreign key between two scoped tables is
 * checked, plus the references that have no foreign key (reminders and converted proformas).
 */
function crossWorkspaceReferences() {
  const found: string[] = []
  const check = (label: string, sql: string) => {
    const rows = sqlite.prepare(sql).all() as { id: number }[]
    if (rows.length) found.push(`${label}: rows ${rows.map((r) => r.id).join(', ')}`)
  }
  for (const table of tableConfigs) {
    if (!hasWorkspace(table.name)) continue
    for (const fk of table.foreignKeys) {
      const ref = fk.reference()
      const parent = getTableConfig(ref.foreignTable).name
      if (!hasWorkspace(parent) || ref.columns.length !== 1) continue
      const column = ref.columns[0].name
      check(
        `${table.name}.${column} -> ${parent}`,
        `SELECT c.id FROM "${table.name}" c JOIN "${parent}" p ON p.id = c."${column}"
         WHERE c.workspace_id <> p.workspace_id`,
      )
    }
  }
  check(
    'invoices.converted_from_id -> invoices',
    `SELECT c.id FROM invoices c JOIN invoices p ON p.id = c.converted_from_id
     WHERE c.workspace_id <> p.workspace_id`,
  )
  check(
    'reminders.ref_id -> invoices',
    `SELECT r.id FROM reminders r JOIN invoices p ON p.id = r.ref_id
     WHERE r.kind IN ('renewal_draft', 'invoice_overdue') AND r.workspace_id <> p.workspace_id`,
  )
  check(
    'reminders.ref_id -> original_invoices',
    `SELECT r.id FROM reminders r JOIN original_invoices p ON p.id = r.ref_id
     WHERE r.kind = 'original_due' AND r.workspace_id <> p.workspace_id`,
  )
  return found
}

/* Workspace A, full of data */

async function fillWorkspaceA() {
  a = await setup()
  A.ws = ok(await a.api('GET', '/auth/me')).workspace.id

  const templates = ok(await a.api('GET', '/templates')) as Json[]
  A.systemTemplateId = templates[0].id
  ok(await configureTemplate(a.api, A.systemTemplateId))
  const systemRegions = ok(await a.api('GET', `/templates/${A.systemTemplateId}`)).regions

  A.fontId = ok(
    await send(a, 'POST', '/fonts', fileForm(TTF, 'font.ttf', { name: 'A font' })),
    201,
  ).id

  const doc = await PDFDocument.create()
  doc.addPage([595, 842])
  const uploaded = ok(
    await send(a, 'POST', '/templates', fileForm(await doc.save(), 'a.pdf', { name: 'Cloud' })),
    201,
  )
  A.uploadedTemplateId = uploaded.id
  ok(
    await a.api('PUT', `/templates/${A.uploadedTemplateId}/regions`, {
      regions: systemRegions,
      style: { textColor: '#1a1a21', lineHeight: 1.32, fontId: A.fontId },
    }),
  )
  ok(await configureTemplate(a.api, A.uploadedTemplateId))
  ok(await send(a, 'POST', `/templates/${A.uploadedTemplateId}/logo`, fileForm(PNG, 'l.png')))

  A.customerId = ok(
    await a.api('POST', '/customers', { name: 'Acme', company: 'Acme LLC', currency: 'USD' }),
    201,
  ).id
  A.providerId = ok(
    await a.api('POST', '/providers', {
      name: 'Contabo A',
      defaultTemplateId: A.uploadedTemplateId,
    }),
    201,
  ).id
  ok(await send(a, 'POST', `/providers/${A.providerId}/logo`, fileForm(PNG, 'logo.png')))
  A.serviceId = ok(
    await a.api(
      'POST',
      '/services',
      serviceBody(A.providerId, { defaultTemplateId: A.uploadedTemplateId }),
    ),
    201,
  ).id

  const subscription = ok(
    await a.api(
      'POST',
      '/subscriptions',
      subscriptionBody(A.customerId, A.serviceId, {
        nextRenewalOn: TODAY,
        lines: [
          { description: 'Server', costAmount: 400_000, priceAmount: 700_000 },
          { description: 'Backup', costAmount: 200_000, priceAmount: 300_000 },
        ],
      }),
    ),
    201,
  )
  A.subscriptionId = subscription.id
  A.subscriptionLineIds = subscription.lines.map((l: Json) => l.id)
  expect(A.subscriptionLineIds).toHaveLength(2)

  A.originalId = ok(
    await a.api(
      'POST',
      '/originals',
      originalBody(A.providerId, {
        serviceId: A.serviceId,
        number: 'CTB-A',
        currency: 'EUR',
        fxRate: 120_000_000,
      }),
    ),
    201,
  ).id
  ok(await send(a, 'POST', `/originals/${A.originalId}/pdf`, fileForm(PDF, 'a.pdf')))
  A.originalLineId = (
    sqlite
      .prepare('SELECT id FROM original_invoice_lines WHERE original_invoice_id = ?')
      .get(A.originalId) as { id: number }
  ).id

  const draft = async (over: Json = {}) =>
    ok(
      await a.api(
        'POST',
        '/invoices',
        draftBody(A.customerId, { templateId: A.systemTemplateId, ...over }),
      ),
      201,
    )
  const issue = async (over: Json = {}) =>
    ok(await a.api('POST', `/invoices/${(await draft(over)).id}/issue`))

  A.draftId = (await draft()).id
  const issued = await issue({ dueOn: '2026-11-10' })
  A.issuedId = issued.id
  expect(issued.number).toBe('INV-0001')
  ok(
    await a.api('PATCH', `/invoices/${A.issuedId}/lines/${issued.lines[0].id}/cost`, {
      costAmount: 500_000,
      costCurrency: 'EUR',
      costFxRate: 120_000_000,
      originalInvoiceLineId: A.originalLineId,
    }),
  )
  A.issued2Id = (await issue({ dueOn: '2026-11-20' })).id
  A.paidId = (await issue()).id
  const paid = ok(
    await a.api('POST', `/invoices/${A.paidId}/payments`, { kind: 'payment', amount: 1_000_000 }),
  )
  expect(paid.status).toBe('paid')
  ok(
    await a.api('POST', `/customers/${A.customerId}/payments`, {
      currency: 'USD',
      amount: 300_000,
      note: 'Bank transfer',
    }),
  )
  A.proformaId = (await issue({ type: 'proforma', validUntil: '2026-12-01' })).id

  runRenewals(undefined, TODAY)
  runReminders(undefined, LATER)

  A.renewalDraftId = (
    sqlite
      .prepare("SELECT id FROM invoices WHERE workspace_id = ? AND source = 'renewal'")
      .get(A.ws) as { id: number }
  ).id
  A.paymentIds = rowsIn('invoice_payments', A.ws).map((row) => row.id)
  expect(rowsIn('invoice_payments', A.ws).some((row) => row.group_id)).toBe(true)
  A.reminderIds = rowsIn('reminders', A.ws).map((row) => row.id)
  expect(
    rowsIn('reminders', A.ws)
      .map((row) => row.kind)
      .sort(),
  ).toEqual(['invoice_overdue', 'invoice_overdue', 'original_due', 'renewal_draft'])

  const token = await a.app.request('/api/v1/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: 'A phone' }),
  })
  const tokenJson = (await token.json()) as Json
  A.token = tokenJson.token
  A.tokenId = tokenJson.id

  for (const [kind, keys] of Object.entries(filesOf(A.ws))) {
    expect(keys.length, `workspace A has no ${kind}`).toBeGreaterThan(0)
  }
  for (const key of allFilesOf(A.ws)) {
    expect((await a.api('GET', `/files/${key}`)).status, key).toBe(200)
  }
  for (const table of SCOPED_TABLES) {
    expect(countIn(table, A.ws), `workspace A has no ${table}`).toBeGreaterThan(0)
  }
}

/** Workspace B's own catalog and documents, for valid request bodies and the jobs. */
async function fillWorkspaceB() {
  ok(await configureTemplate(b.api, B.templateId))
  B.customerId = ok(await b.api('POST', '/customers', { name: 'Initech', currency: 'USD' }), 201).id
  B.providerId = ok(await b.api('POST', '/providers', { name: 'B provider' }), 201).id
  B.serviceId = ok(await b.api('POST', '/services', serviceBody(B.providerId)), 201).id
  const subscription = ok(
    await b.api(
      'POST',
      '/subscriptions',
      subscriptionBody(B.customerId, B.serviceId, { nextRenewalOn: TODAY }),
    ),
    201,
  )
  B.subscriptionId = subscription.id
  B.subscriptionLineId = subscription.lines[0].id
  B.originalId = ok(await b.api('POST', '/originals', originalBody(B.providerId)), 201).id
  const draft = ok(
    await b.api('POST', '/invoices', draftBody(B.customerId, { templateId: B.templateId })),
    201,
  )
  B.draftId = draft.id
  B.draftLineId = draft.lines[0].id
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(`${TODAY}T10:00:00Z`) })
  await fillWorkspaceA()
  b = await setupWorkspace(B_EMAIL, PASSWORD, 'Second business')
  B.ws = b.workspaceId
  B.templateId = ok(await b.api('GET', '/templates'))[0].id
})

afterAll(() => {
  vi.useRealTimers()
})

describe('a new workspace', () => {
  it('is its own workspace, owned by its user', async () => {
    expect(B.ws).not.toBe(A.ws)
    expect(ok(await b.api('GET', '/auth/me'))).toMatchObject({
      email: B_EMAIL,
      workspace: { id: B.ws, name: 'Second business' },
      role: 'owner',
    })
  })

  it('starts with no customers, catalog, documents or reminders', async () => {
    for (const url of [
      '/customers',
      '/providers',
      '/providers?archived=true',
      '/services',
      '/subscriptions',
      '/invoices',
      '/originals',
      '/original-lines',
      '/reminders',
      '/fonts',
    ]) {
      expect(ok(await b.api('GET', url)), url).toEqual([])
    }
  })

  it('has an empty overview', async () => {
    const overview = ok(await b.api('GET', ALL_TIME))
    expect(overview.summary).toMatchObject({ revenue: 0, cost: 0, profit: 0 })
    expect(overview).toMatchObject({
      toCollect: [],
      toCollectTotal: 0,
      toPay: [],
      toPayTotal: 0,
      renewals: [],
      unallocatedCost: 0,
      draftsToReview: 0,
    })
    // A's overview is not empty, so the zeros above are B's own.
    expect(ok(await a.api('GET', ALL_TIME)).summary.revenue).toBeGreaterThan(0)
  })

  it('has exactly one template, its own system template', async () => {
    const templates = ok(await b.api('GET', '/templates')) as Json[]
    expect(templates).toHaveLength(1)
    expect(templates[0]).toMatchObject({ kind: 'system', isDefault: true })
    expect(workspaceOf('templates', templates[0].id)).toBe(B.ws)
    expect(countIn('template_regions', B.ws)).toBeGreaterThan(0)
    // Its own copy of the PDF, so deleting one workspace never touches the other's file.
    expect(filesOf(B.ws).templatePdfs[0]).not.toBe(filesOf(A.ws).templatePdfs[0])
  })

  it('has its own settings, and its base currency can change while A is locked', async () => {
    expect(countIn('settings', B.ws)).toBe(1)
    expect(ok(await b.api('GET', '/settings')).baseCurrencyLocked).toBe(false)
    expect(ok(await a.api('GET', '/settings')).baseCurrencyLocked).toBe(true)

    const changed = {
      baseCurrency: 'EUR',
      renewalLeadDays: 7,
      invoicePrefix: 'B-',
      proformaPrefix: 'BP-',
    }
    expect(ok(await b.api('PUT', '/settings', changed))).toMatchObject(changed)
    expect(ok(await a.api('GET', '/settings'))).toMatchObject({
      baseCurrency: 'USD',
      invoicePrefix: 'INV-',
      proformaPrefix: 'PF-',
    })
    const lockedA = await a.api('PUT', '/settings', {
      baseCurrency: 'EUR',
      renewalLeadDays: 14,
      invoicePrefix: 'INV-',
      proformaPrefix: 'PF-',
    })
    expect(lockedA.status).toBe(409)

    const back = {
      baseCurrency: 'USD',
      renewalLeadDays: 14,
      invoicePrefix: 'INV-',
      proformaPrefix: 'PF-',
    }
    expect(ok(await b.api('PUT', '/settings', back))).toMatchObject(back)
  })

  it('numbers its first invoice from 1, with the same issuer as A', async () => {
    await fillWorkspaceB()
    const draft = ok(
      await b.api(
        'POST',
        '/invoices',
        draftBody(B.customerId, { templateId: B.templateId, dueOn: '2026-11-10' }),
      ),
      201,
    )
    const issued = ok(await b.api('POST', `/invoices/${draft.id}/issue`))
    B.issuedId = issued.id
    expect(issued.number).toBe('INV-0001')
    const issuer = (id: number) =>
      (sqlite.prepare('SELECT issuer_key AS k FROM invoices WHERE id = ?').get(id) as { k: string })
        .k
    // Same company and tax number as A, so only the workspace keeps the series apart.
    expect(issuer(B.issuedId)).toBe(issuer(A.issuedId))
    expect(ok(await a.api('GET', `/invoices/${A.issuedId}`)).number).toBe('INV-0001')
    expect(rowsIn('number_sequences', B.ws)).toHaveLength(1)
  })
})

/* Every route with an id in its path */

interface Route {
  method: string
  /** In OpenAPI form, `/invoices/{id}`. */
  path: string
  inOpenApi: boolean
  jsonBody: boolean
}

/** Routes in openapi.json, plus every route the app serves, so new routes are covered too. */
function idRoutes(app: Ctx['app']): Route[] {
  const routes = new Map<string, Route>()
  for (const [url, item] of Object.entries(openapi.paths)) {
    if (!url.includes('{')) continue
    // Sign-in routes name a provider, not a workspace row. They belong to the person (plan 23).
    if (url.includes('{provider}')) continue
    for (const [method, operation] of Object.entries(item)) {
      if (!['get', 'put', 'post', 'patch', 'delete'].includes(method)) continue
      const key = `${method.toUpperCase()} ${url}`
      routes.set(key, {
        method: method.toUpperCase(),
        path: url,
        inOpenApi: true,
        jsonBody: Boolean(operation.requestBody),
      })
    }
  }
  for (const route of app.routes) {
    if (!route.path.startsWith('/api/v1/') || route.method === 'ALL') continue
    const url = route.path
      .slice('/api/v1'.length)
      .replace(/:(\w+)/g, '{$1}')
      .replace(/^\/files\/\*$/, '/files/{key}')
    if (!url.includes('{')) continue
    // Sign-in routes name a provider, not a workspace row. They belong to the person (plan 23).
    if (url.includes('{provider}')) continue
    const key = `${route.method} ${url}`
    if (!routes.has(key)) {
      routes.set(key, { method: route.method, path: url, inOpenApi: false, jsonBody: false })
    }
  }
  return [...routes.values()].sort((x, y) => x.path.localeCompare(y.path))
}

/**
 * Valid bodies made of B's own rows, so the only thing wrong with each call is A's id in the
 * path. A route that takes a body needs an entry here.
 */
const BODIES: Record<string, () => unknown> = {
  'PUT /customers/{id}': () => ({ name: 'Taken over', currency: 'USD' }),
  'POST /customers/{id}/payments': () => ({ currency: 'USD', amount: 10_000 }),
  'PUT /providers/{id}': () => ({ name: 'Taken over' }),
  'POST /providers/{id}/logo': () => fileForm(PNG, 'logo.png'),
  'PUT /services/{id}': () => serviceBody(B.providerId),
  'PUT /subscriptions/{id}': () => subscriptionBody(B.customerId, B.serviceId),
  'PUT /templates/{id}': () => TEMPLATE_DETAILS,
  'PUT /templates/{id}/regions': () => ({ regions: [] }),
  'POST /templates/{id}/logo': () => fileForm(PNG, 'logo.png'),
  'POST /templates/{id}/preview': () => ({ tax: true }),
  'PUT /invoices/{id}': () => draftBody(B.customerId, { templateId: B.templateId }),
  'POST /invoices/{id}/paid': () => ({ paidOn: TODAY }),
  'POST /invoices/{id}/payments': () => ({ kind: 'payment', amount: 10_000 }),
  'PATCH /invoices/{id}/lines/{lineId}/cost': () => ({
    costAmount: 1,
    costCurrency: 'USD',
    costFxRate: 100_000_000,
  }),
  'PUT /originals/{id}': () => originalBody(B.providerId),
  'POST /originals/{id}/pdf': () => fileForm(PDF, 'a.pdf'),
  'POST /originals/{id}/paid': () => ({ paidOn: TODAY }),
}

/**
 * Routes where another status is also correct. Api tokens belong to the user, not the
 * workspace, and deleting one that is not yours is already a no-op that returns ok.
 */
const ALSO_ALLOWED: Record<string, number[]> = {
  'DELETE /auth/tokens/{id}': [200],
}

/** A's ids for the resource named just before `{id}`. */
function idsOf(resource: string): number[] | undefined {
  const ids: Record<string, number[]> = {
    customers: [A.customerId],
    providers: [A.providerId],
    services: [A.serviceId],
    subscriptions: [A.subscriptionId],
    templates: [A.systemTemplateId, A.uploadedTemplateId],
    fonts: [A.fontId],
    originals: [A.originalId],
    invoices: [A.draftId, A.issuedId, A.paidId, A.proformaId, A.renewalDraftId],
    payments: A.paymentIds,
    reminders: A.reminderIds,
    tokens: [A.tokenId],
  }
  return ids[resource]
}

function urlsFor(route: Route): string[] | string {
  if (route.path.includes('{key}')) {
    return allFilesOf(A.ws).map((key) => route.path.replace('{key}', key))
  }
  const segments = route.path.split('/')
  const resource = segments[segments.indexOf('{id}') - 1]
  const ids = idsOf(resource)
  if (!ids?.length) {
    return `no workspace A ids for "${resource}": add a row to fillWorkspaceA and to idsOf`
  }
  return ids.map((id) => {
    let url = route.path.replace('{id}', String(id))
    if (url.includes('{lineId}')) {
      const lineRow = sqlite
        .prepare('SELECT id FROM invoice_lines WHERE invoice_id = ? ORDER BY id')
        .get(id) as { id: number }
      url = url.replace('{lineId}', String(lineRow.id))
    }
    return url
  })
}

const diffTables = (before: Json, after: Json) =>
  Object.keys(before).filter(
    (table) => JSON.stringify(before[table]) !== JSON.stringify(after[table]),
  )

describe('workspace A ids in the path, from workspace B', () => {
  it('covers every route in openapi.json, and the app serves them all', () => {
    const routes = idRoutes(a.app)
    const served = new Set(
      a.app.routes.map(
        (r) =>
          `${r.method} ${r.path
            .slice('/api/v1'.length)
            .replace(/:(\w+)/g, '{$1}')
            .replace(/\*$/, '{key}')}`,
      ),
    )
    for (const route of routes.filter((r) => r.inOpenApi)) {
      expect(served.has(`${route.method} ${route.path}`), `${route.method} ${route.path}`).toBe(
        true,
      )
    }
    expect(routes.length).toBeGreaterThan(40)
  })

  it('gives 404 and changes nothing, for every route', async () => {
    const failures: string[] = []
    let beforeA = snapshot(A.ws)
    let beforeB = snapshot(B.ws)
    const filesA = allFilesOf(A.ws)

    for (const route of idRoutes(a.app)) {
      const name = `${route.method} ${route.path}`
      const makeBody = BODIES[name]
      if (route.jsonBody && !makeBody) {
        failures.push(`${name}: takes a body; add a valid one to BODIES`)
        continue
      }
      const urls = urlsFor(route)
      if (typeof urls === 'string') {
        failures.push(`${name}: ${urls}`)
        continue
      }
      const allowed = [404, ...(ALSO_ALLOWED[name] ?? [])]
      for (const url of urls) {
        const res = await send(b, route.method, url, makeBody?.())
        if (!allowed.includes(res.status)) {
          failures.push(`${route.method} ${url}: ${res.status} ${JSON.stringify(res.json)}`)
        }
      }
      const afterA = snapshot(A.ws)
      const afterB = snapshot(B.ws)
      const changedA = diffTables(beforeA, afterA)
      const changedB = diffTables(beforeB, afterB)
      if (changedA.length) failures.push(`${name}: changed workspace A's ${changedA.join(', ')}`)
      if (changedB.length) failures.push(`${name}: changed workspace B's ${changedB.join(', ')}`)
      beforeA = afterA
      beforeB = afterB
    }

    expect(failures).toEqual([])
    for (const key of filesA) expect(stored(key), key).toBe(true)
    expect(crossWorkspaceReferences()).toEqual([])
  })

  it('serves none of A’s files to B, while A can read them all', async () => {
    const files = filesOf(A.ws)
    for (const [kind, keys] of Object.entries(files)) {
      for (const key of keys) {
        expect((await b.api('GET', `/files/${key}`)).status, `${kind} ${key}`).toBe(404)
        expect((await a.api('GET', `/files/${key}`)).status, `${kind} ${key}`).toBe(200)
      }
    }
    for (const id of [A.issuedId, A.paidId, A.proformaId]) {
      expect((await b.api('GET', `/invoices/${id}/pdf`)).status).toBe(404)
    }
  })
})

/* Workspace A ids in request bodies */

interface BodyCase {
  name: string
  method: string
  url: () => string
  body: () => unknown
}

const firstLine = (over: Json) => [line({ costCurrency: 'USD', ...over })]

const BODY_CASES: BodyCase[] = [
  {
    name: 'invoice for A’s customer',
    method: 'POST',
    url: () => '/invoices',
    body: () => draftBody(A.customerId, { templateId: B.templateId }),
  },
  {
    name: 'invoice on A’s template',
    method: 'POST',
    url: () => '/invoices',
    body: () => draftBody(B.customerId, { templateId: A.systemTemplateId }),
  },
  {
    name: 'invoice with A’s provider',
    method: 'POST',
    url: () => '/invoices',
    body: () => draftBody(B.customerId, { templateId: B.templateId, providerId: A.providerId }),
  },
  {
    name: 'invoice with A’s service',
    method: 'POST',
    url: () => '/invoices',
    body: () => draftBody(B.customerId, { templateId: B.templateId, serviceId: A.serviceId }),
  },
  {
    name: 'invoice line billing A’s subscription',
    method: 'POST',
    url: () => '/invoices',
    body: () =>
      draftBody(B.customerId, {
        templateId: B.templateId,
        lines: firstLine({
          subscriptionId: A.subscriptionId,
          subscriptionLineId: A.subscriptionLineIds[0],
          periodStart: '2027-01-02',
        }),
      }),
  },
  {
    name: 'invoice line linked to A’s original',
    method: 'POST',
    url: () => '/invoices',
    body: () =>
      draftBody(B.customerId, {
        templateId: B.templateId,
        lines: firstLine({ originalInvoiceLineId: A.originalLineId }),
      }),
  },
  {
    name: 'B’s draft moved to A’s customer',
    method: 'PUT',
    url: () => `/invoices/${B.draftId}`,
    body: () => draftBody(A.customerId, { templateId: B.templateId }),
  },
  {
    name: 'B’s draft moved to A’s template',
    method: 'PUT',
    url: () => `/invoices/${B.draftId}`,
    body: () => draftBody(B.customerId, { templateId: A.uploadedTemplateId }),
  },
  {
    name: 'B’s line cost linked to A’s original',
    method: 'PATCH',
    url: () => `/invoices/${B.draftId}/lines/${B.draftLineId}/cost`,
    body: () => ({
      costAmount: 1,
      costCurrency: 'USD',
      costFxRate: 100_000_000,
      originalInvoiceLineId: A.originalLineId,
    }),
  },
  {
    name: 'subscription for A’s customer',
    method: 'POST',
    url: () => '/subscriptions',
    body: () => subscriptionBody(A.customerId, B.serviceId),
  },
  {
    name: 'subscription to A’s service',
    method: 'POST',
    url: () => '/subscriptions',
    body: () => subscriptionBody(B.customerId, A.serviceId),
  },
  {
    name: 'B’s subscription moved to A’s customer',
    method: 'PUT',
    url: () => `/subscriptions/${B.subscriptionId}`,
    body: () => subscriptionBody(A.customerId, B.serviceId),
  },
  {
    name: 'B’s subscription taking A’s subscription line',
    method: 'PUT',
    url: () => `/subscriptions/${B.subscriptionId}`,
    body: () =>
      subscriptionBody(B.customerId, B.serviceId, {
        lines: [
          {
            id: A.subscriptionLineIds[0],
            description: 'Taken over',
            costAmount: 0,
            priceAmount: 0,
          },
        ],
      }),
  },
  {
    name: 'service from A’s provider',
    method: 'POST',
    url: () => '/services',
    body: () => serviceBody(A.providerId),
  },
  {
    name: 'service on A’s template',
    method: 'POST',
    url: () => '/services',
    body: () => serviceBody(B.providerId, { defaultTemplateId: A.uploadedTemplateId }),
  },
  {
    name: 'B’s service moved to A’s provider',
    method: 'PUT',
    url: () => `/services/${B.serviceId}`,
    body: () => serviceBody(A.providerId),
  },
  {
    name: 'provider on A’s template',
    method: 'POST',
    url: () => '/providers',
    body: () => ({ name: 'Leaky', defaultTemplateId: A.uploadedTemplateId }),
  },
  {
    name: 'B’s provider on A’s template',
    method: 'PUT',
    url: () => `/providers/${B.providerId}`,
    body: () => ({ name: 'B provider', defaultTemplateId: A.systemTemplateId }),
  },
  {
    name: 'original from A’s provider',
    method: 'POST',
    url: () => '/originals',
    body: () => originalBody(A.providerId),
  },
  {
    name: 'original for A’s service',
    method: 'POST',
    url: () => '/originals',
    body: () => originalBody(B.providerId, { serviceId: A.serviceId }),
  },
  {
    name: 'B’s original moved to A’s provider',
    method: 'PUT',
    url: () => `/originals/${B.originalId}`,
    body: () => originalBody(A.providerId),
  },
]

describe('workspace A ids in request bodies, from workspace B', () => {
  it.each(BODY_CASES)('refuses $name', async ({ method, url, body }) => {
    const beforeA = snapshot(A.ws)
    const beforeB = snapshot(B.ws)
    const res = await b.api(method, url(), body())
    expect([404, 422], JSON.stringify(res.json)).toContain(res.status)
    expect(diffTables(beforeA, snapshot(A.ws)), 'changed in A').toEqual([])
    expect(diffTables(beforeB, snapshot(B.ws)), 'changed in B').toEqual([])
  })

  describe('template fonts', () => {
    let regions: Json[]
    const style = () => ({ textColor: '#1a1a21', lineHeight: 1.32, fontId: A.fontId })
    const regionsWithAFont = () =>
      regions.map((region, i) => (i === 0 ? { ...region, fontId: A.fontId } : region))

    beforeAll(async () => {
      regions = ok(await b.api('GET', `/templates/${B.templateId}`)).regions
    })

    it.each([
      ['a template style', () => ({ regions, style: style() })],
      ['a region', () => ({ regions: regionsWithAFont() })],
    ])('refuses A’s font in %s', async (_, body) => {
      const before = snapshot(B.ws)
      const res = await b.api('PUT', `/templates/${B.templateId}/regions`, body())
      expect([404, 422], JSON.stringify(res.json)).toContain(res.status)
      expect(diffTables(before, snapshot(B.ws))).toEqual([])
    })

    it('refuses A’s font in a preview of an unsaved layout', async () => {
      const res = await b.api('POST', `/templates/${B.templateId}/preview`, {
        tax: true,
        layout: { regions, style: style() },
      })
      expect([404, 422], JSON.stringify(res.json)).toContain(res.status)
    })
  })

  it('leaves no row pointing into another workspace', () => {
    expect(crossWorkspaceReferences()).toEqual([])
  })
})

/* Lists, filters and lookups */

describe('lists and lookups from workspace B', () => {
  const LISTS: [string, string][] = [
    ['/customers', 'customers'],
    ['/providers?archived=true', 'providers'],
    ['/services', 'services'],
    ['/subscriptions', 'subscriptions'],
    ['/invoices', 'invoices'],
    ['/originals', 'original_invoices'],
    ['/reminders', 'reminders'],
    ['/fonts', 'fonts'],
    ['/templates', 'templates'],
  ]

  it.each(LISTS)('%s lists only B’s rows', async (url, table) => {
    const rows = ok(await b.api('GET', url)) as Json[]
    for (const row of rows) expect(workspaceOf(table, row.id), `${table} ${row.id}`).toBe(B.ws)
    const rowsA = ok(await a.api('GET', url)) as Json[]
    for (const row of rowsA) expect(workspaceOf(table, row.id), `${table} ${row.id}`).toBe(A.ws)
  })

  it('finds nothing when filtering by A’s customer', async () => {
    expect(ok(await b.api('GET', `/invoices?customerId=${A.customerId}`))).toEqual([])
    expect(ok(await b.api('GET', `/subscriptions?customerId=${A.customerId}`))).toEqual([])
  })

  it('offers only B’s original lines to link', async () => {
    const options = ok(await b.api('GET', '/original-lines')) as Json[]
    expect(options.map((o) => o.id)).not.toContain(A.originalLineId)
  })

  it('does not prefill a rate from A’s documents', async () => {
    expect(ok(await a.api('GET', '/fx-rate?currency=EUR')).rate).toBe(120_000_000)
    expect(ok(await b.api('GET', '/fx-rate?currency=EUR')).rate).toBeNull()
  })

  it('does not resolve a template through A’s service or provider', async () => {
    const res = await b.api(
      'GET',
      `/resolve-template?serviceId=${A.serviceId}&providerId=${A.providerId}`,
    )
    if (res.status === 200) expect(res.json.templateId).toBe(B.templateId)
    else expect([404, 422]).toContain(res.status)
  })

  it('counts only B’s documents in the overview', async () => {
    const overviewB = ok(await b.api('GET', ALL_TIME))
    const ids = overviewB.toCollect.map((row: Json) => row.id)
    expect(ids).toEqual([B.issuedId])
    expect(overviewB.toPay.map((row: Json) => row.id)).toEqual([B.originalId])
    expect(overviewB.summary.revenue).toBe(1_000_000)
  })
})

/* Jobs */

describe('daily jobs', () => {
  const renewalDrafts = (ws: number) =>
    rowsIn('invoices', ws).filter((row) => row.source === 'renewal')

  it('creates renewal drafts and reminders only in the owning workspace', async () => {
    const remindersA = rowsIn('reminders', A.ws)
    const draftsA = renewalDrafts(A.ws)
    expect(renewalDrafts(B.ws)).toEqual([])

    runRenewals(undefined, TODAY)
    runReminders(undefined, LATER)

    // A's subscription was billed in setup, and its reminders already exist.
    expect(renewalDrafts(A.ws)).toEqual(draftsA)
    expect(rowsIn('reminders', A.ws)).toEqual(remindersA)

    const draftsB = renewalDrafts(B.ws)
    expect(draftsB).toHaveLength(1)
    expect(draftsB[0].customer_id).toBe(B.customerId)
    expect(draftsB[0].template_id).toBe(B.templateId)
    const linesB = rowsIn('invoice_lines', B.ws).filter((l) => l.invoice_id === draftsB[0].id)
    expect(linesB.map((l) => l.subscription_line_id)).toEqual([B.subscriptionLineId])

    const remindersB = rowsIn('reminders', B.ws)
    expect(remindersB.map((r) => `${r.kind}:${r.ref_id}`).sort()).toEqual(
      [
        `invoice_overdue:${B.issuedId}`,
        `original_due:${B.originalId}`,
        `renewal_draft:${draftsB[0].id}`,
      ].sort(),
    )
    expect(crossWorkspaceReferences()).toEqual([])
  })

  it('shows each workspace only its own reminders and drafts to review', async () => {
    const listed = (ctx: Ctx) => ctx.api('GET', '/reminders').then((r) => ok(r) as Json[])
    expect((await listed(b)).map((r) => r.id).sort()).toEqual(
      rowsIn('reminders', B.ws)
        .filter((r) => !r.read_at)
        .map((r) => r.id)
        .sort(),
    )
    expect((await listed(a)).map((r) => r.id).sort()).toEqual(
      rowsIn('reminders', A.ws)
        .filter((r) => !r.read_at)
        .map((r) => r.id)
        .sort(),
    )
    expect(ok(await b.api('GET', ALL_TIME)).draftsToReview).toBe(1)
    expect(ok(await a.api('GET', ALL_TIME)).draftsToReview).toBe(renewalDrafts(A.ws).length)
  })

  describe('push', () => {
    const DEVICE_A = 'aa'.repeat(32)
    const DEVICE_B = 'bb'.repeat(32)
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const apns: ApnsSettings = {
      key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      keyId: 'KEY1234567',
      teamId: 'ABCDE12345',
      bundleId: 'dev.octax.mg',
    }
    let server: http2.Http2Server
    let hosts: { sandbox: string; production: string }
    let received: { device: string; reminderId: number }[] = []

    const register = (bearer: string, token: string) =>
      a.app.request('/api/v1/devices', {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, environment: 'sandbox' }),
      })

    const remind = (ws: number, refId: number) =>
      db
        .insert(schema.reminders)
        .values({
          workspaceId: ws,
          kind: 'invoice_overdue',
          refId,
          message: `Reminder in workspace ${ws}`,
          link: `/invoices/${refId}`,
        })
        .returning()
        .get()

    beforeAll(async () => {
      server = http2.createServer()
      server.on('stream', (stream: http2.ServerHttp2Stream, headers) => {
        let text = ''
        stream.setEncoding('utf8')
        stream.on('data', (chunk) => {
          text += chunk
        })
        stream.on('end', () => {
          const device = String(headers[':path']).split('/').pop() as string
          received.push({ device, reminderId: JSON.parse(text).reminderId })
          stream.respond({ ':status': 200 })
          stream.end()
        })
      })
      await new Promise<void>((resolve) => server.listen(0, resolve))
      const url = `http://localhost:${(server.address() as AddressInfo).port}`
      hosts = { sandbox: url, production: url }

      const tokenB = await b.app.request('/api/v1/auth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: B_EMAIL, password: PASSWORD, name: 'B phone' }),
      })
      const bearerB = ((await tokenB.json()) as Json).token
      expect((await register(A.token, DEVICE_A)).status).toBe(200)
      expect((await register(bearerB, DEVICE_B)).status).toBe(200)
      // Everything so far counts as sent, so each run below pushes one new reminder.
      db.update(schema.reminders).set({ pushedAt: new Date().toISOString() }).run()
    })

    afterAll(() => {
      server.close()
    })

    it('sends a reminder only to the phones signed in to its workspace', async () => {
      received = []
      const reminderA = remind(A.ws, A.paidId)
      expect(await deliverReminders(undefined, apns, hosts)).toEqual({ sent: 1, failed: 0 })
      expect(received).toEqual([{ device: DEVICE_A, reminderId: reminderA.id }])

      received = []
      const reminderB = remind(B.ws, B.draftId)
      expect(await deliverReminders(undefined, apns, hosts)).toEqual({ sent: 1, failed: 0 })
      expect(received).toEqual([{ device: DEVICE_B, reminderId: reminderB.id }])
    })
  })
})

/* Deleting a workspace */

describe('deleting a workspace', () => {
  it('removes all of A’s rows and files, and leaves B untouched', async () => {
    const filesA = allFilesOf(A.ws)
    const filesB = allFilesOf(B.ws)
    const beforeB = snapshot(B.ws)
    const apiTokensA = rowsIn('api_tokens', A.ws).map((row) => row.id)
    expect(filesA.length).toBeGreaterThan(0)
    for (const key of [...filesA, ...filesB]) expect(stored(key), key).toBe(true)

    await deleteWorkspace(A.ws)

    for (const table of tableConfigs.filter((t) => hasWorkspace(t.name))) {
      expect(countIn(table.name, A.ws), table.name).toBe(0)
    }
    expect(sqlite.prepare('SELECT id FROM workspaces WHERE id = ?').get(A.ws)).toBeUndefined()
    const devicesLeft = sqlite
      .prepare(
        `SELECT id FROM device_tokens WHERE api_token_id IN (${apiTokensA.join(',') || 'NULL'})`,
      )
      .all()
    expect(devicesLeft).toEqual([])
    for (const key of filesA) expect(stored(key), key).toBe(false)

    expect(diffTables(beforeB, snapshot(B.ws))).toEqual([])
    for (const key of filesB) expect(stored(key), key).toBe(true)
    expect(crossWorkspaceReferences()).toEqual([])

    expect((await a.api('GET', '/auth/me')).status).toBe(401)
    const invoicesB = ok(await b.api('GET', '/invoices')) as Json[]
    expect(invoicesB.length).toBeGreaterThan(0)
  })
})
