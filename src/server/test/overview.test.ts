import { beforeAll, describe, expect, it } from 'vitest'
import { addDays } from '../../shared/dates.ts'
import { runReminders, runRenewals } from '../services/renewals.ts'
import { configureTemplate, draftBody, line, setup } from './helpers.ts'

let api: Awaited<ReturnType<typeof setup>>['api']
let templateId: number
let customerId: number
let other: number

beforeAll(async () => {
  ;({ api } = await setup())
  templateId = (await api('GET', '/templates')).json[0].id
  await configureTemplate(api, templateId)
  customerId = (await api('POST', '/customers', { name: 'Acme', currency: 'USD' })).json.id
  other = (await api('POST', '/customers', { name: 'Beta', currency: 'OMR' })).json.id
})

const today = new Date().toISOString().slice(0, 10)

async function issued(customer: number, over = {}) {
  const invoice = (await api('POST', '/invoices', draftBody(customer, { templateId, ...over })))
    .json
  await api('POST', `/invoices/${invoice.id}/issue`)
  return invoice
}

describe('overview figures', () => {
  it('matches a hand calculated data set in mixed currencies', async () => {
    // 100.00 USD net, cost 60.00, with tax that must not count.
    await issued(customerId, { taxEnabled: true })
    // 200 OMR at 2.6 USD = 520.00 USD, cost 100 EUR at 1.2 = 120.00 USD.
    await issued(other, {
      currency: 'OMR',
      fxRate: 260_000_000,
      lines: [
        line({
          unitPrice: 2_000_000,
          costAmount: 1_000_000,
          costCurrency: 'EUR',
          costFxRate: 120_000_000,
        }),
      ],
    })
    // Must not count: a proforma and a voided invoice.
    const proforma = (
      await api('POST', '/invoices', draftBody(customerId, { type: 'proforma', templateId }))
    ).json
    await api('POST', `/invoices/${proforma.id}/issue`)
    const voided = await issued(customerId)
    await api('POST', `/invoices/${voided.id}/void`)

    const view = (await api('GET', `/overview?from=${today}&to=${today}`)).json
    expect(view.baseCurrency).toBe('USD')
    expect(view.summary.revenue).toBe(6_200_000)
    expect(view.summary.cost).toBe(1_800_000)
    expect(view.summary.profit).toBe(4_400_000)
    expect(view.summary.margin).toBe(71)
    expect(view.toCollect).toHaveLength(2)
    expect(view.toCollectTotal).toBe(6_250_000)
  })

  it('updates lists when an invoice is marked as paid', async () => {
    const first = (await api('GET', '/overview')).json.toCollect[0]
    await api('POST', `/invoices/${first.id}/paid`, {})
    expect((await api('GET', '/overview')).json.toCollect).toHaveLength(1)
    await api('POST', `/invoices/${first.id}/unpaid`)
  })

  it('shows pending items whatever the period', async () => {
    const view = (await api('GET', '/overview?from=2000-01-01&to=2000-01-31')).json
    expect(view.summary.revenue).toBe(0)
    expect(view.toCollect).toHaveLength(2)
  })

  it('shows unallocated provider cost separately', async () => {
    const provider = (await api('GET', '/providers')).json[0]
    const original = (
      await api('POST', '/originals', {
        providerId: provider.id,
        issuedOn: today,
        currency: 'USD',
        fxRate: 100_000_000,
        lines: [{ description: 'Server', quantity: 10_000, unitPrice: 1_000_000 }],
      })
    ).json
    const before = (await api('GET', `/overview?from=${today}&to=${today}`)).json
    expect(before.unallocatedCost).toBe(1_000_000)
    expect(before.summary.profit).toBe(4_400_000)
    expect(before.toPay).toHaveLength(1)

    const invoice = await issued(customerId)
    const lines = (await api('GET', `/invoices/${invoice.id}`)).json.lines
    await api('PATCH', `/invoices/${invoice.id}/lines/${lines[0].id}/cost`, {
      costAmount: 400_000,
      costCurrency: 'USD',
      costFxRate: 100_000_000,
      originalInvoiceLineId: original.lines[0].id,
    })
    const after = (await api('GET', `/overview?from=${today}&to=${today}`)).json
    expect(after.unallocatedCost).toBe(600_000)

    const summary = (await api('GET', `/customers/${customerId}/summary`)).json
    expect(summary.linkedOriginals).toHaveLength(1)
    await api('POST', `/invoices/${invoice.id}/void`)
  })

  it("matches a customer's page with the overview", async () => {
    const summary = (await api('GET', `/customers/${other}/summary`)).json
    expect(summary.summary.revenue).toBe(5_200_000)
    expect(summary.summary.cost).toBe(1_200_000)
    expect(summary.summary.profit).toBe(4_000_000)
    expect(summary.pending).toBe(5_200_000)
  })
})

describe('renewals', () => {
  async function subscribe(serviceName: string, renewsInDays: number, over = {}) {
    const service = (await api('GET', '/services')).json.find((s: any) => s.name === serviceName)
    return (
      await api('POST', '/subscriptions', {
        customerId,
        serviceId: service.id,
        startedOn: '2026-01-15',
        nextRenewalOn: addDays(today, renewsInDays),
        lines: [{ description: '', costAmount: 100_000, priceAmount: 200_000 }],
        costCurrency: 'USD',
        priceCurrency: 'USD',
        ...over,
      })
    ).json
  }

  const draftsFor = async (subscriptionId: number) => {
    const all = (await api('GET', '/invoices?status=draft,void')).json
    const details = await Promise.all(all.map((i: any) => api('GET', `/invoices/${i.id}`)))
    return details
      .map((d) => d.json)
      .filter((i) => i.lines.some((l: any) => l.subscriptionId === subscriptionId))
  }

  it('creates one draft however many times it runs', async () => {
    const sub = await subscribe('Domain', 5)
    runRenewals()
    runRenewals()
    const drafts = await draftsFor(sub.id)
    expect(drafts).toHaveLength(1)
    expect(drafts[0].source).toBe('renewal')
    expect(drafts[0].status).toBe('draft')
    const reminders = (await api('GET', '/reminders')).json
    expect(reminders.some((r: any) => r.link === `/invoices/${drafts[0].id}`)).toBe(true)
  })

  it('leaves subscriptions outside the lead time alone', async () => {
    const sub = await subscribe('Dedicated server', 40)
    runRenewals()
    expect(await draftsFor(sub.id)).toHaveLength(0)
  })

  it('catches a renewal missed during downtime', async () => {
    const sub = await subscribe('QuickBooks Online', -10)
    runRenewals()
    expect(await draftsFor(sub.id)).toHaveLength(1)
  })

  it('does not bring back a discarded draft, and moves the renewal on', async () => {
    const sub = await subscribe('Apple developer account', 3)
    runRenewals()
    const [draft] = await draftsFor(sub.id)
    expect((await api('DELETE', `/invoices/${draft.id}`)).status).toBe(409)
    expect((await api('POST', `/invoices/${draft.id}/void`)).json.status).toBe('void')
    runRenewals()
    const all = await draftsFor(sub.id)
    expect(all.filter((i) => i.status === 'draft')).toHaveLength(0)
    const after = (await api('GET', `/subscriptions/${sub.id}`)).json
    expect(after.nextRenewalOn > sub.nextRenewalOn).toBe(true)
  })

  it('moves the renewal on when the draft is issued', async () => {
    const sub = await subscribe('Domain', 2, { label: 'second.com' })
    runRenewals()
    const [draft] = await draftsFor(sub.id)
    expect((await api('POST', `/invoices/${draft.id}/issue`)).status).toBe(200)
    const after = (await api('GET', `/subscriptions/${sub.id}`)).json
    expect(after.nextRenewalOn > sub.nextRenewalOn).toBe(true)
  })

  it('blocks a metered draft until the amount is confirmed', async () => {
    const sub = await subscribe('S3 storage (R2)', 4)
    runRenewals()
    const [draft] = await draftsFor(sub.id)
    expect(draft.lines[0].amountConfirmed).toBe(false)
    const blocked = await api('POST', `/invoices/${draft.id}/issue`)
    expect(blocked.status).toBe(422)
    expect(blocked.json.error).toContain('metered')
    await api('PUT', `/invoices/${draft.id}`, {
      ...draftBody(customerId, { templateId }),
      lines: [{ ...draft.lines[0], amountConfirmed: true, unitPrice: 333_000 }],
    })
    expect((await api('POST', `/invoices/${draft.id}/issue`)).status).toBe(200)
  })

  it('adds overdue and coming-due reminders once', async () => {
    const invoice = await issued(customerId, { dueOn: addDays(today, -3) })
    runReminders()
    runReminders()
    const reminders = (await api('GET', '/reminders')).json
    const overdue = reminders.filter(
      (r: any) => r.kind === 'invoice_overdue' && r.refId === invoice.id,
    )
    expect(overdue).toHaveLength(1)
    await api('POST', `/reminders/${overdue[0].id}/read`)
    expect((await api('GET', '/reminders')).json.some((r: any) => r.id === overdue[0].id)).toBe(
      false,
    )
  })
})
