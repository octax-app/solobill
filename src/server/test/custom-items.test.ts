import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { addDays, todayISO } from '../../shared/dates.ts'
import type { CustomField } from '../../shared/render.ts'
import { db, schema } from '../db/index.ts'
import { buildPayload, getInvoice, getLines } from '../services/invoices.ts'
import { runRenewals } from '../services/renewals.ts'
import { getTemplate } from '../services/templates.ts'
import { configureTemplate, draftBody, setup } from './helpers.ts'

let ctx: Awaited<ReturnType<typeof setup>>
let api: typeof ctx.api
let templateId: number
let otherTemplateId: number
let customerId: number
let ws: number

const field = (over: Partial<CustomField> = {}): CustomField => ({
  id: randomUUID(),
  label: 'Customer ID',
  type: 'text',
  required: false,
  order: 0,
  region: 'document_meta',
  ...over,
})

function setFields(id: number, customFields: CustomField[]) {
  db.update(schema.templates).set({ customFields }).where(eq(schema.templates.id, id)).run()
}

const draft = (customValues?: Record<string, string>, over: Record<string, unknown> = {}) =>
  draftBody(customerId, { templateId, ...(customValues ? { customValues } : {}), ...over })

async function createDraft(customValues?: Record<string, string>, over?: Record<string, unknown>) {
  const created = await api('POST', '/invoices', draft(customValues, over))
  expect(created.status).toBe(201)
  return created.json
}

beforeAll(async () => {
  ctx = await setup()
  api = ctx.api
  ws = (await api('GET', '/auth/me')).json.workspace.id
  templateId = (await api('GET', '/templates')).json[0].id
  await configureTemplate(api, templateId)
  customerId = (
    await api('POST', '/customers', { name: 'Acme', company: 'Acme LLC', currency: 'USD' })
  ).json.id
  const system = getTemplate(ws, templateId)
  const { id: _id, createdAt: _c, updatedAt: _u, ...fields } = system
  otherTemplateId = db
    .insert(schema.templates)
    .values({ ...fields, name: 'Second layout', isDefault: false })
    .returning()
    .get().id
  const regions = db
    .select()
    .from(schema.templateRegions)
    .where(eq(schema.templateRegions.templateId, templateId))
    .all()
  for (const { id: _region, ...region } of regions) {
    db.insert(schema.templateRegions)
      .values({ ...region, templateId: otherTemplateId })
      .run()
  }
})

beforeEach(() => {
  setFields(templateId, [])
  setFields(otherTemplateId, [])
})

describe('saving custom values on a draft', () => {
  it('saves a draft with a blank required item, and starts with no values', async () => {
    setFields(templateId, [field({ required: true })])
    const created = await createDraft()
    expect(created.customValues).toEqual({})
    expect(created.customSnapshot).toBeNull()
  })

  it('keeps stored values when a save leaves the key out, as iOS does', async () => {
    const item = field()
    setFields(templateId, [item])
    const created = await createDraft({ [item.id]: 'C-100' })
    expect(created.customValues).toEqual({ [item.id]: 'C-100' })

    const saved = await api(
      'PUT',
      `/invoices/${created.id}`,
      draft(undefined, { notes: 'Changed on the phone' }),
    )
    expect(saved.status).toBe(200)
    expect(saved.json.notes).toBe('Changed on the phone')
    expect(saved.json.customValues).toEqual({ [item.id]: 'C-100' })
  })

  it('replaces stored values when a save sends them, and an empty map clears them', async () => {
    const first = field()
    const second = field({ label: 'Purchase order', order: 1 })
    setFields(templateId, [first, second])
    const created = await createDraft({ [first.id]: 'C-100', [second.id]: 'PO-1' })

    const replaced = await api(
      'PUT',
      `/invoices/${created.id}`,
      draft({ [second.id]: 'PO-2', [first.id]: '   ' }),
    )
    expect(replaced.json.customValues).toEqual({ [second.id]: 'PO-2' })

    const cleared = await api('PUT', `/invoices/${created.id}`, draft({}))
    expect(cleared.json.customValues).toEqual({})
  })

  it('drops ids that are not on the template', async () => {
    const item = field()
    setFields(templateId, [item])
    const created = await createDraft({ [item.id]: 'C-100', [randomUUID()]: 'stray' })
    expect(created.customValues).toEqual({ [item.id]: 'C-100' })
  })

  it('drops ids the new template lacks when the template changes without values', async () => {
    const shared = field()
    const own = field({ label: 'Site code' })
    setFields(templateId, [shared, own])
    setFields(otherTemplateId, [shared])
    const created = await createDraft({ [shared.id]: 'C-100', [own.id]: 'S-1' })

    const moved = await api(
      'PUT',
      `/invoices/${created.id}`,
      draft(undefined, { templateId: otherTemplateId }),
    )
    expect(moved.json.templateId).toBe(otherTemplateId)
    expect(moved.json.customValues).toEqual({ [shared.id]: 'C-100' })
  })

  it('still creates renewal drafts on a template with required items', async () => {
    setFields(templateId, [field({ required: true })])
    const service = (await api('GET', '/services')).json.find(
      (row: { cycle: string; pricing: string }) =>
        row.cycle === 'monthly' && row.pricing === 'fixed',
    )
    const created = await api('POST', '/subscriptions', {
      customerId,
      serviceId: service.id,
      cycle: 'monthly',
      startedOn: addDays(todayISO(), -30),
      nextRenewalOn: addDays(todayISO(), 5),
      costCurrency: 'USD',
      priceCurrency: 'USD',
      lines: [{ description: 'Service', costAmount: 100_000, priceAmount: 200_000 }],
    })
    expect(created.status).toBe(201)

    runRenewals()
    const rows = (await api('GET', `/invoices?status=draft&customerId=${customerId}`)).json
    const renewal = rows.find((row: { source: string }) => row.source === 'renewal')
    expect(renewal.templateId).toBe(templateId)
    expect(renewal.customValues).toEqual({})
  })
})

describe('issuing with custom items', () => {
  it('refuses a blank required item by name, on the path iOS uses', async () => {
    setFields(templateId, [field({ label: 'Customer ID', required: true })])
    const created = await createDraft()
    const refused = await api('POST', `/invoices/${created.id}/issue`)
    expect(refused.status).toBe(422)
    expect(refused.json.error).toContain('Enter Customer ID')
    expect(getInvoice(ws, created.id).status).toBe('draft')
  })

  it('refuses values that do not match the type', async () => {
    const amount = field({ label: 'Seats', type: 'number' })
    const startsOn = field({ label: 'Start', type: 'date' })
    setFields(templateId, [amount, startsOn])
    const created = await createDraft({ [amount.id]: 'many', [startsOn.id]: '2026-02-31' })
    const refused = await api('POST', `/invoices/${created.id}/issue`)
    expect(refused.status).toBe(422)
    expect(refused.json.error).toContain('Seats must be a number')
    expect(refused.json.error).toContain('Start must be a date')

    await api(
      'PUT',
      `/invoices/${created.id}`,
      draft({ [amount.id]: '12.5', [startsOn.id]: '2026-02-28' }),
    )
    expect((await api('POST', `/invoices/${created.id}/issue`)).status).toBe(200)
  })

  it('stores the snapshot in field order and leaves out blank optional items', async () => {
    const last = field({ label: 'Last', order: 2 })
    const blank = field({ label: 'Blank', order: 1 })
    const first = field({ label: 'First', order: 0, region: 'customer' })
    setFields(templateId, [last, blank, first])
    const created = await createDraft({ [last.id]: 'L', [first.id]: ' F ' })
    const issued = await api('POST', `/invoices/${created.id}/issue`)
    expect(issued.status).toBe(200)
    expect(issued.json.customSnapshot).toEqual([
      { region: 'customer', label: 'First', value: 'F' },
      { region: 'document_meta', label: 'Last', value: 'L' },
    ])
  })

  it('does not change an issued document when the template fields change', async () => {
    const item = field({ label: 'Customer ID' })
    setFields(templateId, [item])
    const created = await createDraft({ [item.id]: 'C-100' })
    const issued = (await api('POST', `/invoices/${created.id}/issue`)).json
    const printed = [{ region: 'document_meta', label: 'Customer ID', value: 'C-100' }]
    expect(issued.customSnapshot).toEqual(printed)
    const pdf = await (await api('GET', `/invoices/${created.id}/pdf`)).res.arrayBuffer()

    setFields(templateId, [{ ...item, label: 'Renamed' }])
    expect((await api('GET', `/invoices/${created.id}`)).json.customSnapshot).toEqual(printed)
    setFields(templateId, [])
    expect((await api('GET', `/invoices/${created.id}`)).json.customSnapshot).toEqual(printed)

    const after = await (await api('GET', `/invoices/${created.id}/pdf`)).res.arrayBuffer()
    expect(Buffer.from(after).equals(Buffer.from(pdf))).toBe(true)
  })

  it('refuses edits to an issued document', async () => {
    const item = field()
    setFields(templateId, [item])
    const created = await createDraft({ [item.id]: 'C-100' })
    await api('POST', `/invoices/${created.id}/issue`)
    const refused = await api('PUT', `/invoices/${created.id}`, draft({ [item.id]: 'C-200' }))
    expect(refused.status).toBe(409)
    expect(getInvoice(ws, created.id).customValues).toEqual({ [item.id]: 'C-100' })
  })

  it('carries values to the invoice when a proforma converts, and clears the snapshot', async () => {
    const item = field({ required: true })
    setFields(templateId, [item])
    const proforma = await createDraft({ [item.id]: 'C-100' }, { type: 'proforma' })
    const issued = (await api('POST', `/invoices/${proforma.id}/issue`)).json
    expect(issued.customSnapshot).toHaveLength(1)

    const converted = await api('POST', `/invoices/${proforma.id}/convert`)
    expect(converted.status).toBe(201)
    expect(converted.json.customValues).toEqual({ [item.id]: 'C-100' })
    expect(converted.json.customSnapshot).toBeNull()
    expect(converted.json.sellerSnapshot).toBeNull()

    const final = await api('POST', `/invoices/${converted.json.id}/issue`)
    expect(final.status).toBe(200)
    expect(final.json.customSnapshot).toEqual(issued.customSnapshot)
    expect(getInvoice(ws, proforma.id).customSnapshot).toEqual(issued.customSnapshot)
  })
})

describe('the render payload', () => {
  it('holds the typed items, no cost, and leaves totals alone', async () => {
    const item = field({ label: 'Customer ID' })
    setFields(templateId, [item])
    const created = await createDraft({ [item.id]: 'C-100' })
    const plain = await createDraft()
    expect(created.total).toBe(plain.total)

    const payload = buildPayload(
      ws,
      getInvoice(ws, created.id),
      getLines(ws, created.id),
      getTemplate(ws, templateId),
      'DRAFT',
      null,
    )
    expect(payload.customItems).toEqual([
      { region: 'document_meta', label: 'Customer ID', value: 'C-100' },
    ])
    const text = JSON.stringify(payload).toLowerCase()
    expect(text).not.toContain('cost')
    expect(text).not.toContain('provider')
  })
})
