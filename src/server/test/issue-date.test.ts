import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { todayISO } from '../../shared/dates.ts'
import { db, schema } from '../db/index.ts'
import { configureTemplate, draftBody, setup } from './helpers.ts'

let api: Awaited<ReturnType<typeof setup>>['api']
let customerId: number

const create = async (over: Record<string, unknown> = {}) => {
  const res = await api('POST', '/invoices', draftBody(customerId, over))
  expect(res.status).toBe(201)
  return res.json
}

async function pdfText(id: number) {
  const { res } = await api('GET', `/invoices/${id}/pdf`)
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'date-')), 'doc.pdf')
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()))
  return execFileSync('pdftotext', ['-layout', file, '-']).toString()
}

beforeAll(async () => {
  ;({ api } = await setup())
  await configureTemplate(api, (await api('GET', '/templates')).json[0].id)
  customerId = (await api('POST', '/customers', { name: 'Dated', currency: 'USD' })).json.id
})

describe('typed issue date', () => {
  it('issues with the typed date and prints it', async () => {
    const draft = await create({ issueDate: '2026-03-14' })
    expect(draft.issuedOn).toBeNull()
    expect(await pdfText(draft.id)).toContain('2026-03-14')
    const issued = await api('POST', `/invoices/${draft.id}/issue`)
    expect(issued.json.issuedOn).toBe('2026-03-14')
    expect(await pdfText(draft.id)).toContain('2026-03-14')
  })

  it('uses today with no date', async () => {
    const draft = await create()
    const issued = await api('POST', `/invoices/${draft.id}/issue`)
    expect(issued.json.issuedOn).toBe(todayISO())
  })

  it('keeps the date on a save without it, and clears it with null', async () => {
    const draft = await create({ issueDate: '2026-03-14' })
    const kept = await api('PUT', `/invoices/${draft.id}`, draftBody(customerId))
    expect(kept.json.issueDate).toBe('2026-03-14')
    const cleared = await api('PUT', `/invoices/${draft.id}`, {
      ...draftBody(customerId),
      issueDate: null,
    })
    expect(cleared.json.issueDate).toBeNull()
  })

  it('refuses an impossible date', async () => {
    const res = await api('POST', '/invoices', draftBody(customerId, { issueDate: '2026-02-30' }))
    expect(res.status).toBe(422)
  })

  it('counts a back-dated invoice in the month of its date', async () => {
    const before = await api('GET', '/overview?from=2025-05-01&to=2025-05-31')
    const draft = await create({ issueDate: '2025-05-10' })
    await api('POST', `/invoices/${draft.id}/issue`)
    const after = await api('GET', '/overview?from=2025-05-01&to=2025-05-31')
    expect(after.json.summary.revenue - before.json.summary.revenue).toBe(draft.baseSubtotal)
  })

  it('does not treat a dated draft as issued when deleting a subscription', async () => {
    const service = (await api('GET', '/services')).json.find(
      (row: { cycle: string; pricing: string }) =>
        row.cycle === 'monthly' && row.pricing === 'fixed',
    )
    const { json: subscription } = await api('POST', '/subscriptions', {
      customerId,
      serviceId: service.id,
      cycle: 'monthly',
      startedOn: todayISO(),
      costCurrency: 'USD',
      priceCurrency: 'USD',
      lines: [{ description: 'Service', costAmount: 100_000, priceAmount: 200_000 }],
      createFirstInvoice: true,
    })
    db.update(schema.invoices)
      .set({ issueDate: '2026-01-01' })
      .where(eq(schema.invoices.id, subscription.firstDraftId))
      .run()
    expect((await api('DELETE', `/subscriptions/${subscription.id}`)).status).toBe(200)
  })

  it('clears the date when a proforma converts', async () => {
    const proforma = await create({ type: 'proforma', issueDate: '2026-03-14' })
    await api('POST', `/invoices/${proforma.id}/issue`)
    const draft = await api('POST', `/invoices/${proforma.id}/convert`)
    expect(draft.json.issueDate).toBeNull()
    expect(draft.json.issuedOn).toBeNull()
  })
})
