import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { billingPeriods, renewalAfter } from '../../shared/dates.ts'
import { runRenewals } from '../services/renewals.ts'
import { configureTemplate, draftBody, line, setup } from './helpers.ts'

let api: Awaited<ReturnType<typeof setup>>['api']
let templateId: number
let customerId: number
let monthly: any
let oneTime: any
let metered: any

const TODAY = '2026-11-02'
const server = { description: 'Cloud VPS 16', costAmount: 445_000, priceAmount: 600_000 }
const location = { description: 'Location: India', costAmount: 242_500, priceAmount: 400_000 }

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(`${TODAY}T10:00:00Z`) })
  ;({ api } = await setup())
  templateId = (await api('GET', '/templates')).json[0].id
  await configureTemplate(api, templateId)
  customerId = (await api('POST', '/customers', { name: 'Acme', currency: 'USD' })).json.id
  const services = (await api('GET', '/services')).json
  monthly = services.find((s: any) => s.cycle === 'monthly' && s.pricing === 'fixed')
  oneTime = services.find((s: any) => s.cycle === 'once')
  metered = services.find((s: any) => s.pricing === 'metered')
})

afterAll(() => {
  vi.useRealTimers()
})

function subscribe(over: Record<string, unknown> = {}) {
  return api('POST', '/subscriptions', {
    customerId,
    serviceId: monthly.id,
    cycle: 'monthly',
    startedOn: TODAY,
    costCurrency: 'USD',
    priceCurrency: 'USD',
    lines: [{ description: 'Service', costAmount: 100_000, priceAmount: 200_000 }],
    ...over,
  })
}

const put = (sub: any, over: Record<string, unknown> = {}) =>
  api('PUT', `/subscriptions/${sub.id}`, {
    customerId,
    serviceId: sub.serviceId,
    cycle: sub.cycle,
    startedOn: sub.startedOn,
    nextRenewalOn: sub.nextRenewalOn,
    status: sub.status,
    lines: sub.lines,
    ...over,
  })

const invoice = async (id: number) => (await api('GET', `/invoices/${id}`)).json
const next = async (id: number) => (await api('GET', `/subscriptions/${id}`)).json.nextRenewalOn
const issue = (id: number) => api('POST', `/invoices/${id}/issue`)
const discard = (id: number) => api('POST', `/invoices/${id}/void`)
const period = (sub: any, index = 0) => ({
  subscriptionId: sub.id,
  subscriptionLineId: sub.lines[index].id,
})

async function billed(subscriptionId: number) {
  const all = (await api('GET', '/invoices')).json
  const full = await Promise.all(all.map((row: any) => invoice(row.id)))
  return full.filter((row) => row.lines.some((l: any) => l.subscriptionId === subscriptionId))
}

describe('period helpers', () => {
  it('keeps the anchor day across short months', () => {
    expect(billingPeriods('2026-01-31', 'monthly', '2026-03-31')).toEqual({
      periods: ['2026-01-31', '2026-02-28', '2026-03-31'],
      next: '2026-04-30',
    })
    expect(renewalAfter('2026-01-31', 'monthly', '2026-02-28')).toBe('2026-03-31')
    expect(billingPeriods('2026-01-01', 'once', '2026-12-31').periods).toEqual(['2026-01-01'])
    expect(billingPeriods('2026-12-01', 'monthly', '2026-11-01').periods).toEqual([])
  })
})

describe('subscription lines', () => {
  it('totals the lines and bills both on one draft, moving the renewal once', async () => {
    const { json: sub } = await subscribe({
      lines: [server, location],
      startedOn: '2026-10-05',
      nextRenewalOn: '2026-11-05',
    })
    expect(sub.lines).toHaveLength(2)
    expect(sub.costAmount).toBe(687_500)
    expect(sub.priceAmount).toBe(1_000_000)
    expect(runRenewals()).toBe(1)
    const [draft] = await billed(sub.id)
    expect(draft.lines.map((l: any) => l.description)).toEqual([
      'Cloud VPS 16 from 2026-11-05',
      'Location: India from 2026-11-05',
    ])
    expect(draft.total).toBe(1_000_000)
    expect((await issue(draft.id)).status).toBe(200)
    expect(await next(sub.id)).toBe('2026-12-05')
  })

  it('keeps the period and moves the renewal once when reversed and reissued', async () => {
    const { json: sub } = await subscribe({
      startedOn: '2026-10-06',
      nextRenewalOn: '2026-11-06',
    })
    expect(runRenewals()).toBe(1)
    const [draft] = await billed(sub.id)
    await issue(draft.id)
    expect(await next(sub.id)).toBe('2026-12-06')

    const { json: reversed } = await api('POST', `/invoices/${draft.id}/reverse`)
    expect(reversed.lines[0].periodStart).toBe('2026-11-06')
    expect(await next(sub.id)).toBe('2026-12-06')
    expect(runRenewals()).toBe(0)

    await issue(draft.id)
    expect((await invoice(draft.id)).status).toBe('issued')
    expect(await next(sub.id)).toBe('2026-12-06')
  })

  it('bills the next period on a copy, moving the renewal once', async () => {
    const { json: sub } = await subscribe({
      startedOn: '2026-10-07',
      nextRenewalOn: '2026-11-07',
    })
    runRenewals()
    const [draft] = await billed(sub.id)
    await issue(draft.id)
    expect(await next(sub.id)).toBe('2026-12-07')

    const { json: copy } = await api('POST', `/invoices/${draft.id}/duplicate`)
    expect(copy.source).toBe('manual')
    expect(copy.lines[0]).toMatchObject({ subscriptionId: sub.id, periodStart: '2026-12-07' })
    await issue(copy.id)
    expect(await next(sub.id)).toBe('2027-01-07')
  })

  it('refuses a copy when another document holds the next period', async () => {
    const { json: sub } = await subscribe({
      startedOn: '2026-10-08',
      nextRenewalOn: '2026-11-08',
    })
    runRenewals()
    const [draft] = await billed(sub.id)
    const res = await api('POST', `/invoices/${draft.id}/duplicate`)
    expect(res.status).toBe(409)
    expect(res.json.error).toContain('already on')
    expect(await billed(sub.id)).toHaveLength(1)
  })

  it('prefills one line from the service when none are given', async () => {
    const { json: sub } = await api('POST', '/subscriptions', {
      customerId,
      serviceId: monthly.id,
      label: 'example.com',
      startedOn: TODAY,
    })
    expect(sub.lines).toHaveLength(1)
    expect(sub.lines[0].description).toBe(`${monthly.name}, example.com`)
    expect(sub.lines[0].priceAmount).toBe(monthly.defaultPrice)
  })

  it('applies line changes to future drafts only and keeps billed history', async () => {
    const { json: sub } = await subscribe({
      lines: [server, location],
      startedOn: '2026-10-10',
      nextRenewalOn: '2026-11-10',
    })
    runRenewals()
    const [draft] = await billed(sub.id)
    await issue(draft.id)
    const current = (await api('GET', `/subscriptions/${sub.id}`)).json
    const saved = await put(current, { lines: [{ ...current.lines[0], priceAmount: 700_000 }] })
    expect(saved.status).toBe(200)
    expect(saved.json.lines).toHaveLength(1)
    expect(saved.json.priceAmount).toBe(700_000)
    const after = await invoice(draft.id)
    expect(after.total).toBe(1_000_000)
    expect(after.lines[0].subscriptionLineId).toBe(current.lines[0].id)
    expect(after.lines[1].subscriptionLineId).toBeNull()
  })

  it('refuses a line from another subscription, and an empty list', async () => {
    const { json: one } = await subscribe({ nextRenewalOn: '2027-01-01' })
    const { json: other } = await subscribe({ nextRenewalOn: '2027-01-01' })
    expect((await put(one, { lines: other.lines })).status).toBe(422)
    expect((await put(one, { lines: [] })).status).toBe(422)
  })

  it('carries a metered amount forward per line', async () => {
    const { json: sub } = await subscribe({
      serviceId: metered.id,
      lines: [server, location],
      startedOn: '2026-10-12',
      nextRenewalOn: '2026-11-12',
    })
    runRenewals()
    const [draft] = await billed(sub.id)
    expect(draft.lines.every((l: any) => !l.amountConfirmed)).toBe(true)
    const updated = await api(
      'PUT',
      `/invoices/${draft.id}`,
      draftBody(customerId, {
        templateId,
        lines: draft.lines.map((l: any, index: number) =>
          line({
            ...period(sub, index),
            periodStart: l.periodStart,
            description: l.description,
            unitPrice: index === 0 ? 111_000 : 222_000,
          }),
        ),
      }),
    )
    expect(updated.status).toBe(200)
    await issue(draft.id)
    runRenewals(undefined, '2026-11-30')
    const second = (await billed(sub.id)).find((row) => row.id !== draft.id)
    expect(second.lines.map((l: any) => l.unitPrice)).toEqual([111_000, 222_000])
    await discard(second.id)
  })
})

describe('first invoice', () => {
  it('bills every period from a past start date on one draft', async () => {
    const { json: sub } = await subscribe({
      startedOn: '2026-10-01',
      lines: [{ description: 'Server', costAmount: 100_000, priceAmount: 200_000 }],
      createFirstInvoice: true,
    })
    expect(sub.firstDraftId).toBeTruthy()
    const draft = await invoice(sub.firstDraftId)
    expect(draft.status).toBe('draft')
    expect(draft.source).toBe('renewal')
    expect(draft.lines.map((l: any) => l.periodStart)).toEqual(['2026-10-01', '2026-11-01'])
    expect(draft.total).toBe(400_000)
    expect(draft.dueOn).toBe(TODAY)
    expect(sub.nextRenewalOn).toBe('2026-10-01')
    expect((await issue(draft.id)).status).toBe(200)
    expect(await next(sub.id)).toBe('2026-12-01')
    runRenewals()
    expect(await billed(sub.id)).toHaveLength(1)
  })

  it('backfills a long history once, however often the job runs', async () => {
    const { json: sub } = await subscribe({ startedOn: '2024-03-15', createFirstInvoice: true })
    const draft = await invoice(sub.firstDraftId)
    expect(draft.lines).toHaveLength(33)
    expect(draft.lines[0].periodStart).toBe('2024-03-15')
    expect(draft.lines.at(-1).periodStart).toBe('2026-11-15')
    runRenewals()
    runRenewals()
    expect(await billed(sub.id)).toHaveLength(1)
    await issue(draft.id)
    expect(await next(sub.id)).toBe('2026-12-15')
  })

  it('skips the past when the box is unticked', async () => {
    const { json: sub } = await subscribe({ startedOn: '2026-01-31' })
    expect(sub.firstDraftId).toBeNull()
    expect(sub.nextRenewalOn).toBe('2026-11-30')
    runRenewals()
    expect(await billed(sub.id)).toHaveLength(0)
  })

  it('treats a typed date as the next renewal, with no first draft', async () => {
    const { json: sub } = await subscribe({
      startedOn: '2026-05-01',
      nextRenewalOn: '2027-03-01',
      createFirstInvoice: true,
    })
    expect(sub.firstDraftId).toBeNull()
    expect(sub.nextRenewalOn).toBe('2027-03-01')
  })

  it('does not bring a discarded first draft back, and skips its periods', async () => {
    const { json: sub } = await subscribe({ startedOn: '2026-10-20', createFirstInvoice: true })
    await discard(sub.firstDraftId)
    expect(await next(sub.id)).toBe('2026-11-20')
    runRenewals()
    expect((await billed(sub.id)).filter((row) => row.status === 'draft')).toHaveLength(0)
  })

  it('leaves a future start to the daily job', async () => {
    const { json: sub } = await subscribe({ startedOn: '2027-02-01', createFirstInvoice: true })
    expect(sub.firstDraftId).toBeNull()
    expect(sub.nextRenewalOn).toBe('2027-02-01')
    runRenewals(undefined, '2027-01-25')
    const drafts = await billed(sub.id)
    expect(drafts).toHaveLength(1)
    expect(drafts[0].dueOn).toBe('2027-02-01')
    await discard(drafts[0].id)
  })

  it('bills a one-time service once, with no renewal date', async () => {
    const { json: sub } = await subscribe({
      serviceId: oneTime.id,
      cycle: 'once',
      startedOn: '2026-09-01',
      createFirstInvoice: true,
    })
    expect(sub.nextRenewalOn).toBeNull()
    const draft = await invoice(sub.firstDraftId)
    expect(draft.lines.map((l: any) => l.description)).toEqual(['Service'])
    await issue(draft.id)
    runRenewals()
    expect(await billed(sub.id)).toHaveLength(1)
  })

  it('does not bill a paused subscription', async () => {
    const { json: sub } = await subscribe({
      startedOn: '2026-10-01',
      status: 'paused',
      createFirstInvoice: true,
    })
    expect(sub.firstDraftId).toBeNull()
  })
})

describe('renewal dates on edit', () => {
  it('works out a date when One time becomes Monthly, with no back-billing', async () => {
    const { json: sub } = await subscribe({
      serviceId: oneTime.id,
      cycle: 'once',
      startedOn: '2026-08-10',
    })
    const edited = await put(sub, { cycle: 'monthly', nextRenewalOn: null })
    expect(edited.json.nextRenewalOn).toBe('2026-11-10')
  })

  it('moves the date when Monthly becomes Yearly', async () => {
    const { json: sub } = await subscribe({ startedOn: '2026-10-20' })
    expect(sub.nextRenewalOn).toBe('2026-11-20')
    const edited = await put(sub, { cycle: 'yearly' })
    expect(edited.json.nextRenewalOn).toBe('2027-10-20')
  })

  it('moves forward from the last billed period', async () => {
    const { json: sub } = await subscribe({ startedOn: '2026-10-25', createFirstInvoice: true })
    await issue(sub.firstDraftId)
    const current = (await api('GET', `/subscriptions/${sub.id}`)).json
    expect(current.nextRenewalOn).toBe('2026-11-25')
    const edited = await put(current, { cycle: 'quarterly' })
    expect(edited.json.nextRenewalOn).toBe('2027-01-25')
  })

  it('lets a typed date win, and keeps the date when nothing changed', async () => {
    const { json: sub } = await subscribe({ startedOn: '2026-10-20' })
    const typed = await put(sub, { cycle: 'yearly', nextRenewalOn: '2027-06-01' })
    expect(typed.json.nextRenewalOn).toBe('2027-06-01')
    const cleared = await put(typed.json, { nextRenewalOn: null })
    expect(cleared.json.nextRenewalOn).toBe('2027-06-01')
  })

  it('refuses a date change while a renewal draft is open', async () => {
    const { json: sub } = await subscribe({ startedOn: '2026-10-22', createFirstInvoice: true })
    const refused = await put(sub, { cycle: 'yearly' })
    expect(refused.status).toBe(409)
    expect(refused.json.error).toContain('renewal draft')
    expect((await put(sub, { label: 'renamed' })).status).toBe(200)
    await discard(sub.firstDraftId)
  })

  it('keeps an unbilled future first period when the start date moves', async () => {
    const { json: sub } = await subscribe({ startedOn: '2027-03-01', createFirstInvoice: true })
    const edited = await put(sub, { startedOn: '2027-04-01' })
    expect(edited.json.nextRenewalOn).toBe('2027-04-01')
  })
})

describe('deleting subscriptions', () => {
  const remove = (id: number) => api('DELETE', `/subscriptions/${id}`)

  it('removes a subscription with its unissued renewal draft and reminder', async () => {
    const { json: sub } = await subscribe({ startedOn: '2026-10-03', createFirstInvoice: true })
    const link = `/invoices/${sub.firstDraftId}`
    expect((await api('GET', '/reminders')).json.some((r: any) => r.link === link)).toBe(true)
    expect((await remove(sub.id)).status).toBe(200)
    expect((await api('GET', link)).status).toBe(404)
    expect((await api('GET', '/reminders')).json.some((r: any) => r.link === link)).toBe(false)
  })

  it('removes a subscription whose renewal draft was discarded', async () => {
    const { json: sub } = await subscribe({ startedOn: '2026-10-04', createFirstInvoice: true })
    await discard(sub.firstDraftId)
    expect((await remove(sub.id)).status).toBe(200)
  })

  it('keeps a subscription with an issued or voided invoice', async () => {
    const { json: sub } = await subscribe({ startedOn: '2026-10-06', createFirstInvoice: true })
    await issue(sub.firstDraftId)
    expect((await remove(sub.id)).status).toBe(409)
    await discard(sub.firstDraftId)
    const refused = await remove(sub.id)
    expect(refused.status).toBe(409)
    expect(refused.json.error).toContain('Cancel')
  })

  it('keeps a subscription on a manual draft', async () => {
    const { json: sub } = await subscribe({ nextRenewalOn: '2027-02-02' })
    const draft = await api(
      'POST',
      '/invoices',
      draftBody(customerId, { templateId, lines: [line(period(sub))] }),
    )
    const refused = await remove(sub.id)
    expect(refused.status).toBe(409)
    expect(refused.json.error).toContain('draft')
    await api('DELETE', `/invoices/${draft.json.id}`)
    expect((await remove(sub.id)).status).toBe(200)
  })

  it('keeps a renewal draft that has other lines', async () => {
    const { json: sub } = await subscribe({ startedOn: '2026-10-07', createFirstInvoice: true })
    const draft = await invoice(sub.firstDraftId)
    await api(
      'PUT',
      `/invoices/${draft.id}`,
      draftBody(customerId, {
        templateId,
        lines: [
          ...draft.lines.map((l: any) =>
            line({ ...period(sub), periodStart: l.periodStart, description: l.description }),
          ),
          line({ description: 'Setup fee' }),
        ],
      }),
    )
    expect((await remove(sub.id)).status).toBe(409)
    await discard(draft.id)
  })
})

describe('adding a subscription to an invoice', () => {
  const manual = (sub: any, over = {}) =>
    api(
      'POST',
      '/invoices',
      draftBody(customerId, {
        templateId,
        lines: sub.lines.map((_: unknown, index: number) => line(period(sub, index))),
        ...over,
      }),
    )

  it('claims the period on every line and moves the renewal once', async () => {
    const { json: sub } = await subscribe({
      lines: [server, location],
      startedOn: '2026-10-14',
      nextRenewalOn: '2026-11-14',
    })
    const draft = await manual(sub)
    expect(draft.status).toBe(201)
    expect(draft.json.lines.map((l: any) => l.periodStart)).toEqual(['2026-11-14', '2026-11-14'])
    runRenewals()
    expect(await billed(sub.id)).toHaveLength(1)
    await issue(draft.json.id)
    expect(await next(sub.id)).toBe('2026-12-14')
  })

  it('refuses a period another document already covers', async () => {
    const { json: sub } = await subscribe({ startedOn: '2026-10-15', nextRenewalOn: '2026-11-15' })
    runRenewals()
    const [draft] = await billed(sub.id)
    const refused = await manual(sub)
    expect(refused.status).toBe(409)
    expect(refused.json.error).toContain(`#${draft.id}`)
    await discard(draft.id)
    expect(await next(sub.id)).toBe('2026-12-15')
  })

  it('still allows an extra plain line on another invoice', async () => {
    const { json: sub } = await subscribe({ startedOn: '2026-10-16', nextRenewalOn: '2026-11-16' })
    runRenewals()
    const [draft] = await billed(sub.id)
    const extra = await api('POST', '/invoices', draftBody(customerId, { templateId }))
    expect(extra.status).toBe(201)
    await api('DELETE', `/invoices/${extra.json.id}`)
    await discard(draft.id)
  })

  it('gives a repeated line no period', async () => {
    const { json: sub } = await subscribe({ nextRenewalOn: '2027-05-01' })
    const draft = await api(
      'POST',
      '/invoices',
      draftBody(customerId, { templateId, lines: [line(period(sub)), line(period(sub))] }),
    )
    expect(draft.json.lines.map((l: any) => l.periodStart)).toEqual(['2027-05-01', null])
    await api('DELETE', `/invoices/${draft.json.id}`)
  })
})

describe('proformas and renewals', () => {
  const proforma = async (sub: any) => {
    const lines = sub.lines.map((_: unknown, index: number) => line(period(sub, index)))
    const body = draftBody(customerId, { type: 'proforma', templateId, lines })
    return (await api('POST', '/invoices', body)).json
  }

  it('does not claim a period', async () => {
    const { json: sub } = await subscribe({ startedOn: '2026-10-17', nextRenewalOn: '2026-11-17' })
    const draft = await proforma(sub)
    expect(draft.lines[0].periodStart).toBeNull()
    await issue(draft.id)
    runRenewals(undefined, '2026-11-05')
    const drafts = (await billed(sub.id)).filter((row) => row.source === 'renewal')
    expect(drafts).toHaveLength(1)
    await discard(drafts[0].id)
  })

  it('moves the renewal on when converted and issued', async () => {
    const { json: sub } = await subscribe({
      lines: [server, location],
      startedOn: '2026-10-18',
      nextRenewalOn: '2026-11-18',
    })
    const draft = await proforma(sub)
    await issue(draft.id)
    const converted = await api('POST', `/invoices/${draft.id}/convert`)
    expect(converted.status).toBe(201)
    expect(converted.json.lines.map((l: any) => l.periodStart)).toEqual([
      '2026-11-18',
      '2026-11-18',
    ])
    await issue(converted.json.id)
    expect(await next(sub.id)).toBe('2026-12-18')
    runRenewals(undefined, '2026-11-05')
    expect((await billed(sub.id)).filter((row) => row.source === 'renewal')).toHaveLength(0)
  })

  it('keeps renewing after a voided proforma', async () => {
    const { json: sub } = await subscribe({ startedOn: '2026-10-19', nextRenewalOn: '2026-11-19' })
    const draft = await proforma(sub)
    await issue(draft.id)
    await discard(draft.id)
    runRenewals(undefined, '2026-11-06')
    const drafts = (await billed(sub.id)).filter((row) => row.source === 'renewal')
    expect(drafts).toHaveLength(1)
    await discard(drafts[0].id)
  })

  it('refuses conversion when a renewal draft has taken the period', async () => {
    const { json: sub } = await subscribe({ startedOn: '2026-10-21', nextRenewalOn: '2026-11-11' })
    const draft = await proforma(sub)
    await issue(draft.id)
    runRenewals()
    const renewal = (await billed(sub.id)).find((row) => row.source === 'renewal')
    const refused = await api('POST', `/invoices/${draft.id}/convert`)
    expect(refused.status).toBe(409)
    expect((await invoice(draft.id)).status).toBe('issued')
    await discard(renewal.id)
    expect((await api('POST', `/invoices/${draft.id}/convert`)).status).toBe(201)
  })
})

describe('migration', () => {
  it('moves existing subscriptions and invoice lines onto subscription lines', () => {
    const folder = path.resolve(import.meta.dirname, '../../../drizzle')
    // Stops before 0007, which needs a user or settings row. test/migration.test.ts covers it.
    const files = fs.readdirSync(folder).filter((file) => file.endsWith('.sql') && file < '0007_')
    files.sort()
    const apply = (database: Database.Database, file: string) => {
      const text = fs.readFileSync(path.join(folder, file), 'utf8')
      for (const statement of text.split('--> statement-breakpoint')) database.exec(statement)
    }
    const old = new Database(':memory:')
    const target = files.findIndex((file) => file.startsWith('0003_'))
    for (const file of files.slice(0, target)) apply(old, file)
    old.exec(`
      insert into providers (id, name, created_at, updated_at) values (1, 'P', 'x', 'x');
      insert into services (id, provider_id, name, pricing, cycle, default_cost, default_price, currency, created_at, updated_at)
        values (1, 1, 'VPS', 'fixed', 'monthly', 0, 0, 'USD', 'x', 'x');
      insert into customers (id, name, currency, created_at, updated_at) values (1, 'C', 'USD', 'x', 'x');
      insert into subscriptions (id, customer_id, service_id, label, cycle, started_on, next_renewal_on, cost_amount, price_amount, created_at, updated_at)
        values (1, 1, 1, '', 'monthly', '2026-01-01', '2026-12-01', 10, 20, 'x', 'x'),
               (2, 1, 1, 'srv-2', 'monthly', '2026-01-01', '2026-12-01', 30, 40, 'x', 'x');
      insert into templates (id, name, kind, pdf_file, created_at, updated_at) values (1, 'T', 'system', 'x', 'x', 'x');
      insert into invoices (id, type, customer_id, template_id, currency, fx_rate, created_at, updated_at)
        values (1, 'invoice', 1, 1, 'USD', 1, 'x', 'x'), (2, 'proforma', 1, 1, 'USD', 1, 'x', 'x');
      insert into invoice_lines (id, invoice_id, subscription_id, period_start, description, quantity, unit_price, cost_currency, cost_fx_rate)
        values (1, 1, 2, '2026-11-01', 'a', 1, 1, 'USD', 1),
               (2, 1, null, null, 'b', 1, 1, 'USD', 1),
               (3, 2, 1, '2026-12-01', 'c', 1, 1, 'USD', 1);
    `)
    for (const file of files.slice(target)) apply(old, file)
    expect(
      old
        .prepare(
          'select subscription_id, description, cost_amount, price_amount from subscription_lines order by id',
        )
        .raw()
        .all(),
    ).toEqual([
      [1, 'VPS', 10, 20],
      [2, 'VPS, srv-2', 30, 40],
    ])
    expect(
      old
        .prepare('select id, subscription_line_id, period_start from invoice_lines order by id')
        .raw()
        .all(),
    ).toEqual([
      [1, 2, '2026-11-01'],
      [2, null, null],
      [3, 1, null],
    ])
    old.pragma('foreign_keys = ON')
    old.exec('delete from subscription_lines where id = 2')
    const kept = old.prepare('select subscription_line_id from invoice_lines where id = 1')
    expect(kept.raw().get()).toEqual([null])
    old.close()
  })
})
