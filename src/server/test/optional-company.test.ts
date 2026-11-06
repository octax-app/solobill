import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Region } from '../../shared/render.ts'
import { db, schema } from '../db/index.ts'
import { templateProblems } from '../services/templates.ts'
import { draftBody, setup } from './helpers.ts'

let api: Awaited<ReturnType<typeof setup>>['api']
let customerId: number
let systemRegions: Region[]

const blankDetails = (name: string) => ({
  name,
  companyName: '',
  companyAddress: '',
  taxNumber: '',
  bankDetails: '',
  defaultTaxRate: 50_000,
})

/** A template whose PDF prints the company, so only the required regions are mapped. */
async function printedTemplate(name: string, extra: Region['key'][] = []) {
  const system = db.select().from(schema.templates).where(eq(schema.templates.kind, 'system')).get()
  if (!system) throw new Error('No system template')
  const { id: _id, createdAt: _c, updatedAt: _u, ...fields } = system
  const id = db
    .insert(schema.templates)
    .values({ ...fields, ...blankDetails(name), kind: 'uploaded', isDefault: false })
    .returning()
    .get().id
  const keep = new Set(['document_meta', 'customer', 'line_table', 'totals', ...extra])
  const regions = systemRegions.filter((region) => keep.has(region.key))
  expect((await api('PUT', `/templates/${id}/regions`, { regions })).status).toBe(200)
  return id
}

async function issue(templateId: number, over: Record<string, unknown> = {}) {
  const body = { templateId, ...over }
  const created = await api('POST', '/invoices', draftBody(customerId, body))
  expect(created.status).toBe(201)
  return api('POST', `/invoices/${created.json.id}/issue`)
}

beforeAll(async () => {
  const ctx = await setup()
  api = ctx.api
  customerId = (
    await api('POST', '/customers', { name: 'Blank Co', company: 'Blank LLC', currency: 'USD' })
  ).json.id
  const system = (await api('GET', '/templates')).json.find(
    (row: { kind: string }) => row.kind === 'system',
  )
  systemRegions = system.regions
})

describe('company details printed in the PDF', () => {
  it('reports a template with no company regions as ready', async () => {
    const id = await printedTemplate('Printed ready')
    const template = (await api('GET', `/templates/${id}`)).json
    expect(template.problems).toEqual([])
    expect(template.ready).toBe(true)
  })

  it('issues untaxed and taxed invoices with blank details', async () => {
    const id = await printedTemplate('Printed issue')
    const plain = await issue(id)
    expect(plain.status).toBe(200)
    expect(plain.json.sellerSnapshot.companyName).toBe('')
    const taxed = await issue(id, { taxEnabled: true, taxRate: 50_000 })
    expect(taxed.status).toBe(200)
  })

  it('still asks for the company name when the company region is mapped', async () => {
    const id = await printedTemplate('Company mapped', ['company'])
    const res = await issue(id)
    expect(res.status).toBe(422)
    expect(res.json.error).toContain('company name')
  })

  it('asks for the tax number only on a taxed invoice with tax details mapped', async () => {
    const id = await printedTemplate('Tax mapped', ['tax_details'])
    expect((await issue(id)).status).toBe(200)
    const taxed = await issue(id, { taxEnabled: true, taxRate: 50_000 })
    expect(taxed.status).toBe(422)
    expect(taxed.json.error).toContain('tax number')
  })

  it('keeps a separate number series for each blank template', async () => {
    const first = await printedTemplate('Series one')
    const second = await printedTemplate('Series two')
    const a = await issue(first, { number: 'SAME-1' })
    const b = await issue(second, { number: 'SAME-1' })
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(a.json.issuerKey).toBe(`template:${first}`)
    expect(b.json.issuerKey).toBe(`template:${second}`)
    const repeat = await api(
      'POST',
      '/invoices',
      draftBody(customerId, { templateId: first, number: 'SAME-1' }),
    )
    expect(repeat.status).toBe(409)
  })

  it('leaves the keys of templates with details alone', async () => {
    const id = await printedTemplate('Named')
    db.update(schema.templates)
      .set({ companyName: 'Named Co' })
      .where(eq(schema.templates.id, id))
      .run()
    expect((await issue(id)).json.issuerKey).toBe('name:named co')
    db.update(schema.templates).set({ taxNumber: 'OM77' }).where(eq(schema.templates.id, id)).run()
    expect((await issue(id)).json.issuerKey).toBe('tax:om77')
  })

  it('does not stop the system template asking for details', () => {
    const template = db
      .select()
      .from(schema.templates)
      .where(eq(schema.templates.kind, 'system'))
      .get()
    if (!template) throw new Error('No system template')
    const blank = { ...template, companyName: '', taxNumber: '' }
    const problems = templateProblems(blank, systemRegions, { tax: true })
    expect(problems.join()).toContain('company name')
    expect(problems.join()).toContain('tax number')
  })
})
