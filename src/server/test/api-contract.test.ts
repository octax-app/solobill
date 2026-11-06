import fs from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import * as res from '../../shared/api-responses.ts'
import { db, schema } from '../db/index.ts'
import { openApiDocument } from '../openapi.ts'
import { runReminders } from '../services/renewals.ts'
import { configureTemplate, draftBody, EMAIL, PASSWORD, setup } from './helpers.ts'

let ctx: Awaited<ReturnType<typeof setup>>
let token: string

/** Real responses, saved for the Swift decoding tests by `pnpm ios:fixtures`. */
const fixtures = new Map<string, unknown>()
const fixtureName = (schema: z.ZodType) =>
  Object.entries(res)
    .find(([, value]) => value === schema)?.[0]
    .replace(/Response$/, '') ?? 'unnamed'

async function call(method: string, route: string, data?: unknown) {
  const response = await ctx.app.request(`/api/v1${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  })
  const json = await response.json()
  if (!response.ok) throw new Error(`${method} ${route}: ${JSON.stringify(json)}`)
  return json
}

/** Throws if the live response has a missing, renamed or undocumented field. */
async function expectShape<T extends z.ZodType>(
  schema: T,
  method: string,
  route: string,
  data?: unknown,
): Promise<z.output<T>> {
  const json = await call(method, route, data)
  fixtures.set(fixtureName(schema), json)
  return schema.parse(json)
}

async function listOf<T extends z.ZodType>(schema: T, route: string) {
  const rows = (await call('GET', route)) as unknown[]
  fixtures.set(`${fixtureName(schema)}List`, rows)
  return rows.map((row) => schema.parse(row))
}

beforeAll(async () => {
  ctx = await setup()
  const created = await ctx.app.request('/api/v1/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: 'iPhone' }),
  })
  token = res.apiTokenResponse.parse(await created.json()).token
})

afterAll(() => {
  if (!process.env.WRITE_IOS_FIXTURES) return
  // The iOS app lives in its own repo. By default it is cloned next to this one.
  const dir = path.resolve(
    process.env.IOS_FIXTURES_DIR ??
      path.join(import.meta.dirname, '../../../../solobill-ios/MGOctaxTests/Fixtures'),
  )
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, json] of fixtures) {
    fs.writeFileSync(path.join(dir, `${name}.json`), `${JSON.stringify(json, null, 2)}\n`)
  }
})

describe('iOS API contract', () => {
  it('matches every response the app reads, using a bearer token', async () => {
    const templates = await listOf(res.templateResponse, '/templates')
    await configureTemplate(ctx.api, templates[0].id)
    await expectShape(res.meResponse, 'GET', '/auth/me')
    await expectShape(res.settingsResponse, 'GET', '/settings')

    const customer = res.customerResponse.parse(
      await call('POST', '/customers', { name: 'Contract Co', currency: 'USD' }),
    )
    const [provider] = await listOf(res.providerResponse, '/providers')
    const [service] = await listOf(res.serviceResponse, `/services?providerId=${provider.id}`)
    await call('POST', '/subscriptions', {
      customerId: customer.id,
      serviceId: service.id,
      startedOn: '2026-10-01',
    })

    await listOf(res.customerResponse, '/customers?q=Contract')
    await expectShape(res.customerResponse, 'GET', `/customers/${customer.id}`)
    await listOf(res.subscriptionResponse, `/subscriptions?customerId=${customer.id}`)
    await expectShape(res.fxRateResponse, 'GET', '/fx-rate?currency=USD')
    await expectShape(res.fxRateResponse, 'GET', '/fx-rate?currency=OMR')
    await expectShape(
      res.resolvedTemplateResponse,
      'GET',
      `/resolve-template?providerId=${provider.id}`,
    )

    const draft = await expectShape(
      res.invoiceFullResponse,
      'POST',
      '/invoices',
      draftBody(customer.id),
    )
    await expectShape(res.invoiceFullResponse, 'PUT', `/invoices/${draft.id}`, {
      ...draftBody(customer.id),
      notes: 'Edited',
    })
    const issued = await expectShape(res.invoiceFullResponse, 'POST', `/invoices/${draft.id}/issue`)
    expect(issued.status).toBe('issued')
    await expectShape(res.invoiceFullResponse, 'GET', `/invoices/${issued.id}`)
    await listOf(res.invoiceRowResponse, '/invoices?type=invoice')

    const original = await expectShape(res.originalFullResponse, 'POST', '/originals', {
      providerId: provider.id,
      issuedOn: '2026-10-05',
      dueOn: '2026-10-20',
      currency: 'USD',
      fxRate: 100_000_000,
      lines: [{ description: 'Bill', quantity: 10_000, unitPrice: 500_000 }],
    })
    await expectShape(res.originalFullResponse, 'GET', `/originals/${original.id}`)
    await listOf(res.originalRowResponse, '/originals')

    // Pending rows only exist while unpaid, and the original above is due soon enough to remind.
    runReminders(undefined, '2026-10-15')
    const pending = await expectShape(
      res.overviewResponse,
      'GET',
      '/overview?from=2026-01-01&to=2026-12-31',
    )
    expect(pending.toCollect.length).toBeGreaterThan(0)
    expect(pending.toPay.length).toBeGreaterThan(0)
    await expectShape(res.customerSummaryResponse, 'GET', `/customers/${customer.id}/summary`)
    expect((await listOf(res.reminderResponse, '/reminders')).length).toBeGreaterThan(0)

    await expectShape(res.invoiceResponse, 'POST', `/invoices/${issued.id}/paid`, {
      paidOn: '2026-10-10',
    })
    await expectShape(res.invoiceResponse, 'POST', `/invoices/${issued.id}/unpaid`)
    await expectShape(res.originalFullResponse, 'POST', `/originals/${original.id}/paid`, {})
    await expectShape(res.originalFullResponse, 'POST', `/originals/${original.id}/unpaid`)

    // Runs last, so the saved fixtures hold a partly paid invoice with real payment rows.
    const older = res.invoiceFullResponse.parse(
      await call('POST', '/invoices', { ...draftBody(customer.id), notes: 'Older' }),
    )
    await call('POST', `/invoices/${older.id}/issue`)
    await expectShape(res.invoiceFullResponse, 'POST', `/invoices/${older.id}/payments`, {
      kind: 'payment',
      amount: 250_000,
      paidOn: '2026-10-11',
      note: 'First part',
    })
    await expectShape(res.invoiceFullResponse, 'POST', `/invoices/${older.id}/payments`, {
      kind: 'discount',
      amount: 50_000,
      paidOn: '2026-10-12',
    })
    const mistake = await expectShape(
      res.invoiceFullResponse,
      'POST',
      `/invoices/${older.id}/payments`,
      { kind: 'payment', amount: 10_000 },
    )
    const removed = await call('DELETE', `/payments/${mistake.payments[2].id}`)
    res.okResponse.parse(removed)
    const spread = await expectShape(
      res.customerPaymentResponse,
      'POST',
      `/customers/${customer.id}/payments`,
      { currency: 'USD', amount: 1_200_000, paidOn: '2026-10-13', note: 'Bank transfer' },
    )
    expect(spread.allocations).toHaveLength(2)
    const partlyPaid = await expectShape(
      res.invoiceFullResponse,
      'GET',
      `/invoices/${spread.allocations[1].invoiceId}`,
    )
    expect(partlyPaid.status).toBe('issued')
    expect(partlyPaid.paidAmount).toBeGreaterThan(0)
    expect(partlyPaid.payments.length).toBeGreaterThan(0)
    await listOf(res.invoiceRowResponse, '/invoices?type=invoice')
    const partial = await expectShape(
      res.overviewResponse,
      'GET',
      '/overview?from=2026-01-01&to=2026-12-31',
    )
    expect(partial.toCollect.some((row) => row.due < row.total)).toBe(true)
    await expectShape(res.customerSummaryResponse, 'GET', `/customers/${customer.id}/summary`)
    await expectShape(res.invoiceResponse, 'POST', `/invoices/${older.id}/void`)

    const mistaken = await expectShape(
      res.invoiceFullResponse,
      'POST',
      '/invoices',
      draftBody(customer.id),
    )
    await expectShape(res.invoiceFullResponse, 'POST', `/invoices/${mistaken.id}/issue`)
    await call('POST', `/invoices/${mistaken.id}/paid`, {})
    const undone = await expectShape(
      res.invoiceFullResponse,
      'POST',
      `/invoices/${mistaken.id}/undo-payments`,
    )
    expect(undone.payments).toEqual([])
    const reversed = await expectShape(
      res.invoiceFullResponse,
      'POST',
      `/invoices/${mistaken.id}/reverse`,
    )
    expect(reversed.status).toBe('draft')
    const copy = await expectShape(
      res.invoiceFullResponse,
      'POST',
      `/invoices/${issued.id}/duplicate`,
    )
    expect(copy.status).toBe('draft')
  })

  it('matches the sign-in and account responses the app reads', async () => {
    await expectShape(res.authProvidersResponse, 'GET', '/auth/providers')
    // A linked Apple account, as a native sign-in would leave it.
    const owner = db.select().from(schema.users).where(eq(schema.users.email, EMAIL)).get()
    if (!owner) throw new Error('No owner')
    db.insert(schema.userIdentities)
      .values({
        userId: owner.id,
        provider: 'apple',
        subject: '001234.contract-fixture',
        email: 'x7k2@privaterelay.appleid.com',
      })
      .run()
    const identities = await listOf(res.identityResponse, '/auth/identities')
    expect(identities).toHaveLength(1)
    await expectShape(res.workspaceResponse, 'PUT', '/workspace', { name: 'Test workspace' })
  })

  it('reports failures in the documented error shape', async () => {
    const response = await ctx.app.request('/api/v1/invoices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'invoice' }),
    })
    expect(response.status).toBe(422)
    res.errorResponse.parse(await response.json())
  })

  it('keeps openapi.json in step with the schemas. Run `pnpm openapi` if this fails.', () => {
    const file = path.resolve(import.meta.dirname, '../../../openapi.json')
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(
      JSON.parse(JSON.stringify(openApiDocument())),
    )
  })
})
