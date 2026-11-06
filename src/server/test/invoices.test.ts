import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PDFDocument } from '@cantoo/pdf-lib'
import { beforeAll, describe, expect, it } from 'vitest'
import { config } from '../config.ts'
import { configureTemplate, draftBody, line, setup } from './helpers.ts'

let ctx: Awaited<ReturnType<typeof setup>>
let api: typeof ctx.api
let templateId: number
let customerId: number

beforeAll(async () => {
  ctx = await setup()
  api = ctx.api
  const templates = (await api('GET', '/templates')).json
  templateId = templates[0].id
  customerId = (
    await api('POST', '/customers', { name: 'Acme', company: 'Acme LLC', currency: 'USD' })
  ).json.id
})

function pdfText(bytes: ArrayBuffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-'))
  const file = path.join(dir, 'x.pdf')
  fs.writeFileSync(file, Buffer.from(bytes))
  return execFileSync('pdftotext', ['-layout', file, '-']).toString()
}

describe('templates', () => {
  it('starts not ready, then is ready once company details are in', async () => {
    const before = (await api('GET', `/templates/${templateId}`)).json
    expect(before.ready).toBe(false)
    expect(before.isDefault).toBe(true)
    const after = (await configureTemplate(api, templateId)).json
    expect(after.ready).toBe(true)
  })

  it('cannot delete the system template', async () => {
    expect((await api('DELETE', `/templates/${templateId}`)).status).toBe(409)
  })

  it('previews with tax on and off', async () => {
    const on = await api('POST', `/templates/${templateId}/preview`, { tax: true })
    const off = await api('POST', `/templates/${templateId}/preview`, { tax: false })
    expect(on.status).toBe(200)
    const onText = pdfText(await on.res.arrayBuffer())
    const offText = pdfText(await off.res.arrayBuffer())
    expect(onText).toContain('Tax Invoice')
    expect(onText).toContain('Tax %')
    expect(offText).not.toContain('Tax %')
  })

  it('uploads a PDF, maps it and enforces required regions', async () => {
    const doc = await PDFDocument.create()
    doc.addPage([595, 842])
    const form = new FormData()
    form.append('file', new File([Buffer.from(await doc.save())], 'cloud.pdf'))
    const res = await ctx.app.request('/api/v1/templates', {
      method: 'POST',
      headers: { Cookie: ctx.cookie },
      body: form,
    })
    expect(res.status).toBe(201)
    const created = await res.json()
    expect(created.ready).toBe(false)
    expect(created.problems.join()).toContain('line_table')

    const system = (await api('GET', `/templates/${templateId}`)).json
    const saved = await api('PUT', `/templates/${created.id}/regions`, { regions: system.regions })
    expect(saved.status).toBe(200)
    await api('PUT', `/templates/${created.id}`, {
      name: 'Cloud',
      companyName: 'MG Trading',
      companyAddress: '',
      taxNumber: 'OM1100',
      bankDetails: '',
      defaultTaxRate: 50_000,
    })
    expect((await api('GET', `/templates/${created.id}`)).json.ready).toBe(true)
  })

  it('resolves service, then provider, then default', async () => {
    const templates = (await api('GET', '/templates')).json
    const uploaded = templates.find((t: any) => t.kind === 'uploaded')
    const other = (await api('GET', '/services')).json[0]
    const provider = (await api('GET', `/providers/${other.providerId}`)).json
    const resolve = async () =>
      (await api('GET', `/resolve-template?serviceId=${other.id}`)).json.templateId

    expect(await resolve()).toBe(templateId)
    await api('PUT', `/providers/${provider.id}`, { ...provider, defaultTemplateId: uploaded.id })
    expect(await resolve()).toBe(uploaded.id)
    expect((await api('DELETE', `/templates/${uploaded.id}`)).status).toBe(409)

    const third = await api('PUT', `/services/${other.id}`, {
      ...other,
      defaultTemplateId: templateId,
    })
    expect(third.status).toBe(200)
    expect(await resolve()).toBe(templateId)

    await api('PUT', `/services/${other.id}`, { ...other, defaultTemplateId: null })
    await api('PUT', `/providers/${provider.id}`, { ...provider, defaultTemplateId: null })
  })
})

describe('customer invoices', () => {
  const draft = async (over = {}) =>
    (await api('POST', '/invoices', draftBody(customerId, { templateId, ...over }))).json

  it('blocks issuing without required details', async () => {
    const blank = await api('POST', '/templates/999999/preview', {})
    expect(blank.status).toBe(404)
    const template = (await api('GET', `/templates/${templateId}`)).json
    await api('PUT', `/templates/${templateId}`, { ...template, taxNumber: '' })
    const invoice = await draft({ taxEnabled: true })
    const res = await api('POST', `/invoices/${invoice.id}/issue`)
    expect(res.status).toBe(422)
    expect(res.json.error).toContain('tax number')
    await configureTemplate(api, templateId)
    await api('DELETE', `/invoices/${invoice.id}`)
  })

  it('issues, numbers on issue, and prints no internal data', async () => {
    const invoice = await draft({
      taxEnabled: true,
      providerId: (await api('GET', '/providers')).json[0].id,
    })
    expect(invoice.number).toBeNull()
    expect(invoice.total).toBe(1_050_000)
    const issued = (await api('POST', `/invoices/${invoice.id}/issue`)).json
    expect(issued.number).toMatch(/^INV-\d{4}$/)
    expect(issued.sellerSnapshot.companyName).toBe('MG Trading')

    const pdf = await api('GET', `/invoices/${invoice.id}/pdf`)
    const text = pdfText(await pdf.res.arrayBuffer())
    expect(text).toContain('Tax Invoice')
    expect(text).toContain('MG Trading')
    expect(text).toContain('105.00 USD')
    expect(text).not.toContain('60.00')
    expect(text).not.toContain('Apple')
  })

  it('keeps the workspace out of API replies', async () => {
    const invoice = await draft()
    const replies = [
      await api('GET', '/customers'),
      await api('GET', `/invoices/${invoice.id}`),
      await api('GET', `/templates/${templateId}`),
    ]
    for (const reply of replies) {
      expect(reply.status).toBe(200)
      expect(JSON.stringify(reply.json)).not.toContain('workspaceId')
    }
    await api('DELETE', `/invoices/${invoice.id}`)
  })

  it('prints a unit price finer than the currency without rounding it', async () => {
    const invoice = await draft({
      lines: [line({ description: 'SMS', quantity: 10_000_000, unitPrice: 150 })],
    })
    const text = pdfText(await (await api('GET', `/invoices/${invoice.id}/pdf`)).res.arrayBuffer())
    expect(text).toContain('0.015')
    expect(text).not.toContain('0.02')
    expect(text).toContain('15.00 USD')
  })

  it('never gives two invoices the same number when issued at once', async () => {
    const drafts = await Promise.all([draft(), draft(), draft(), draft()])
    const issued = await Promise.all(drafts.map((d) => api('POST', `/invoices/${d.id}/issue`)))
    const numbers = issued.map((r) => r.json.number)
    expect(new Set(numbers).size).toBe(4)
  })

  it('uses one number series across templates of the same company', async () => {
    const templates = (await api('GET', '/templates')).json
    const uploaded = templates.find((t: any) => t.kind === 'uploaded')
    const a = await draft()
    const b = await draft({ templateId: uploaded.id })
    const first = (await api('POST', `/invoices/${a.id}/issue`)).json.number
    const second = (await api('POST', `/invoices/${b.id}/issue`)).json.number
    expect(Number(second.slice(4))).toBe(Number(first.slice(4)) + 1)
  })

  it('keeps issued documents immutable, while cost stays editable', async () => {
    const invoice = await draft()
    const before = (await api('POST', `/invoices/${invoice.id}/issue`)).json
    const edit = await api('PUT', `/invoices/${invoice.id}`, draftBody(customerId))
    expect(edit.status).toBe(409)
    expect((await api('DELETE', `/invoices/${invoice.id}`)).status).toBe(409)

    const cost = await api('PATCH', `/invoices/${invoice.id}/lines/${before.lines[0].id}/cost`, {
      costAmount: 700_000,
      costCurrency: 'USD',
      costFxRate: 100_000_000,
    })
    expect(cost.status).toBe(200)
    expect(cost.json[0].costBase).toBe(700_000)
  })

  it('does not change a stored PDF when the template changes', async () => {
    const invoice = await draft()
    await api('POST', `/invoices/${invoice.id}/issue`)
    const before = await (await api('GET', `/invoices/${invoice.id}/pdf`)).res.arrayBuffer()
    const template = (await api('GET', `/templates/${templateId}`)).json
    await api('PUT', `/templates/${templateId}`, {
      ...template,
      companyName: 'Renamed Ltd',
      taxNumber: 'OM1100',
    })
    const after = await (await api('GET', `/invoices/${invoice.id}/pdf`)).res.arrayBuffer()
    expect(Buffer.from(after).equals(Buffer.from(before))).toBe(true)
    await configureTemplate(api, templateId)
  })

  it('voids but does not delete', async () => {
    const invoice = await draft()
    await api('POST', `/invoices/${invoice.id}/issue`)
    expect((await api('POST', `/invoices/${invoice.id}/void`)).json.status).toBe('void')
    expect((await api('GET', `/invoices/${invoice.id}`)).json.number).toBeTruthy()
    expect((await api('POST', `/invoices/${invoice.id}/paid`, {})).status).toBe(409)
  })

  describe('reversing', () => {
    const stored = (key: string) => fs.existsSync(path.join(config.filesDir, key))
    const issue = async (over = {}) => {
      const invoice = await draft(over)
      return (await api('POST', `/invoices/${invoice.id}/issue`)).json
    }

    it('returns an issued document to draft and deletes its PDF', async () => {
      const issued = await issue()
      expect(stored(issued.pdfFile)).toBe(true)
      const { json: reversed } = await api('POST', `/invoices/${issued.id}/reverse`)
      expect(reversed).toMatchObject({
        status: 'draft',
        number: issued.number,
        issueDate: issued.issuedOn,
        issuedOn: null,
        issuerKey: null,
        pdfFile: null,
        sellerSnapshot: null,
        customSnapshot: null,
      })
      expect(reversed.lines).toHaveLength(issued.lines.length)
      expect(stored(issued.pdfFile)).toBe(false)
    })

    it('reissues under the same number and date with a new PDF', async () => {
      const issued = await issue({ issueDate: '2026-03-04' })
      await api('POST', `/invoices/${issued.id}/reverse`)
      const { json: again } = await api('POST', `/invoices/${issued.id}/issue`)
      expect(again).toMatchObject({
        status: 'issued',
        number: issued.number,
        issuedOn: '2026-03-04',
      })
      expect(again.pdfFile).not.toBe(issued.pdfFile)
      expect(stored(again.pdfFile)).toBe(true)
    })

    it('takes the next automatic number when the kept one is cleared', async () => {
      const issued = await issue()
      const { json: reversed } = await api('POST', `/invoices/${issued.id}/reverse`)
      await api('PUT', `/invoices/${issued.id}`, { ...draftBody(customerId), number: null })
      const { json: again } = await api('POST', `/invoices/${reversed.id}/issue`)
      expect(again.number).not.toBe(issued.number)
    })

    it('refuses a reissue when another document took the kept number', async () => {
      const issued = await issue()
      await api('POST', `/invoices/${issued.id}/reverse`)
      await issue({ number: issued.number })
      const res = await api('POST', `/invoices/${issued.id}/issue`)
      expect(res.status).toBe(409)
      expect(res.json.error).toContain('already used')
    })

    it('reverses an issued proforma, but not a converted one', async () => {
      const proforma = await issue({ type: 'proforma' })
      const { json: reversed } = await api('POST', `/invoices/${proforma.id}/reverse`)
      expect(reversed).toMatchObject({ status: 'draft', type: 'proforma', pdfFile: null })
      expect(stored(proforma.pdfFile)).toBe(false)

      const converted = await issue({ type: 'proforma' })
      await api('POST', `/invoices/${converted.id}/convert`)
      expect((await api('POST', `/invoices/${converted.id}/reverse`)).status).toBe(409)
      expect(stored(converted.pdfFile)).toBe(true)
    })

    it('refuses documents with payments, and paid, draft and void ones', async () => {
      const partly = await issue()
      await api('POST', `/invoices/${partly.id}/payments`, { kind: 'payment', amount: 10_000 })
      const paid = await issue()
      await api('POST', `/invoices/${paid.id}/paid`, {})
      const unissued = await draft()
      const voided = await issue()
      await api('POST', `/invoices/${voided.id}/void`)

      for (const { id } of [partly, paid, unissued, voided]) {
        const before = (await api('GET', `/invoices/${id}`)).json
        expect((await api('POST', `/invoices/${id}/reverse`)).status).toBe(409)
        expect((await api('GET', `/invoices/${id}`)).json).toEqual(before)
      }
      expect(stored(partly.pdfFile)).toBe(true)
      expect(stored(paid.pdfFile)).toBe(true)
      expect(stored(voided.pdfFile)).toBe(true)
    })

    it('stops counting toward totals', async () => {
      const range = '/overview?from=2026-01-01&to=2099-12-31'
      const issued = await issue({ issueDate: '2026-05-05' })
      const before = (await api('GET', range)).json
      expect(before.toCollect.some((row: { id: number }) => row.id === issued.id)).toBe(true)
      await api('POST', `/invoices/${issued.id}/reverse`)
      const after = (await api('GET', range)).json
      expect(after.toCollect.some((row: { id: number }) => row.id === issued.id)).toBe(false)
      expect(after.summary.revenue).toBeLessThan(before.summary.revenue)
    })
  })

  describe('duplicating', () => {
    const duplicate = (id: number) => api('POST', `/invoices/${id}/duplicate`)

    it('copies a paid invoice into a clean draft', async () => {
      const source = await draft({
        notes: 'Thanks',
        dueOn: '2026-12-01',
        issueDate: '2026-03-04',
        lines: [{ ...draftBody(customerId).lines[0], description: 'Hosting', costAmount: 50_000 }],
      })
      const { json: issued } = await api('POST', `/invoices/${source.id}/issue`)
      await api('POST', `/invoices/${source.id}/paid`, {})

      const res = await duplicate(source.id)
      expect(res.status).toBe(201)
      expect(res.json.id).not.toBe(source.id)
      expect(res.json).toMatchObject({
        type: 'invoice',
        status: 'draft',
        source: 'manual',
        customerId,
        templateId: source.templateId,
        currency: source.currency,
        total: source.total,
        notes: 'Thanks',
        dueOn: '2026-12-01',
        number: null,
        issuerKey: null,
        issueDate: null,
        issuedOn: null,
        pdfFile: null,
        paidOn: null,
        paidAmount: 0,
        payments: [],
        sellerSnapshot: null,
        customSnapshot: null,
      })
      expect(res.json.lines).toHaveLength(1)
      expect(res.json.lines[0]).toMatchObject({ description: 'Hosting', costAmount: 50_000 })
      expect((await api('GET', `/invoices/${source.id}`)).json.pdfFile).toBe(issued.pdfFile)
    })

    it('copies a proforma as a proforma, and a voided document', async () => {
      const proforma = await draft({ type: 'proforma', validUntil: '2026-12-01' })
      const { json: copy } = await duplicate(proforma.id)
      expect(copy).toMatchObject({ type: 'proforma', validUntil: '2026-12-01', status: 'draft' })

      const voided = await draft()
      await api('POST', `/invoices/${voided.id}/issue`)
      await api('POST', `/invoices/${voided.id}/void`)
      expect((await duplicate(voided.id)).json.status).toBe('draft')
    })

    it('can be edited and issued under a new number', async () => {
      const source = await draft()
      const { json: first } = await api('POST', `/invoices/${source.id}/issue`)
      const { json: copy } = await duplicate(source.id)
      const { json: again } = await api('POST', `/invoices/${copy.id}/issue`)
      expect(again.status).toBe('issued')
      expect(again.number).not.toBe(first.number)
    })

    it('answers 404 for a document that does not exist', async () => {
      expect((await duplicate(999_999)).status).toBe(404)
    })
  })

  it('marks as paid and can undo it', async () => {
    const invoice = await draft()
    await api('POST', `/invoices/${invoice.id}/issue`)
    const paid = await api('POST', `/invoices/${invoice.id}/paid`, { paidOn: '2026-11-02' })
    expect(paid.json.status).toBe('paid')
    expect((await api('POST', `/invoices/${invoice.id}/unpaid`)).json.paidOn).toBeNull()
  })

  it('needs an exchange rate for a foreign currency', async () => {
    const invoice = await draft({ currency: 'OMR', fxRate: 0 })
    const res = await api('POST', `/invoices/${invoice.id}/issue`)
    expect(res.status).toBe(422)
    expect(res.json.error).toContain('exchange rate')
  })
})

describe('typed invoice numbers', () => {
  const draft = async (over = {}) =>
    api('POST', '/invoices', draftBody(customerId, { templateId, ...over }))
  const issue = (id: number) => api('POST', `/invoices/${id}/issue`)

  it('prints a typed number exactly and leaves the automatic series alone', async () => {
    const auto = (await draft()).json
    const before = (await issue(auto.id)).json.number
    const typed = (await draft({ number: ' 1042-QB ' })).json
    expect(typed.number).toBe('1042-QB')
    const preview = pdfText(await (await api('GET', `/invoices/${typed.id}/pdf`)).res.arrayBuffer())
    expect(preview).toContain('1042-QB')

    expect((await issue(typed.id)).json.number).toBe('1042-QB')
    const text = pdfText(await (await api('GET', `/invoices/${typed.id}/pdf`)).res.arrayBuffer())
    expect(text).toContain('1042-QB')
    expect(text).not.toContain('INV-1042')

    const next = (await draft()).json
    const after = (await issue(next.id)).json.number
    expect(Number(after.slice(4))).toBe(Number(before.slice(4)) + 1)
  })

  it('treats an empty field as automatic', async () => {
    const invoice = (await draft({ number: '   ' })).json
    expect(invoice.number).toBeNull()
    expect((await issue(invoice.id)).json.number).toMatch(/^INV-\d{4}$/)
  })

  it('refuses a duplicate when saving and when issuing', async () => {
    const first = (await draft({ number: 'QB-1' })).json
    const second = (await draft({ number: 'QB-1' })).json
    expect((await issue(first.id)).status).toBe(200)

    const saved = await draft({ number: 'QB-1' })
    expect(saved.status).toBe(409)
    expect(saved.json.error).toContain('QB-1')
    const issued = await issue(second.id)
    expect(issued.status).toBe(409)
    expect(issued.json.error).toContain('QB-1')
    expect((await api('GET', `/invoices/${second.id}`)).json.status).toBe('draft')
  })

  it('lets another company use the same number', async () => {
    const templates = (await api('GET', '/templates')).json
    const uploaded = templates.find((t: any) => t.kind === 'uploaded')
    await api('PUT', `/templates/${uploaded.id}`, {
      name: 'Other company',
      companyName: 'Other Co',
      companyAddress: '',
      taxNumber: 'OM7777',
      bankDetails: '',
      defaultTaxRate: 50_000,
    })
    await issue((await draft({ number: 'SHARED-1' })).json.id)
    const other = (await draft({ number: 'SHARED-1', templateId: uploaded.id })).json
    expect((await issue(other.id)).json.number).toBe('SHARED-1')
  })

  it('allows reissuing under a voided number', async () => {
    const wrong = (await draft({ number: 'QB-77' })).json
    await issue(wrong.id)
    await api('POST', `/invoices/${wrong.id}/void`)
    const fixed = (await draft({ number: 'QB-77' })).json
    expect((await issue(fixed.id)).json.number).toBe('QB-77')
    expect((await api('GET', `/invoices/${wrong.id}`)).json.number).toBe('QB-77')
  })

  it('skips an automatic number that is already taken', async () => {
    const probe = (await draft()).json
    const current = Number((await issue(probe.id)).json.number.slice(4))
    const next = `INV-${String(current + 1).padStart(4, '0')}`
    await issue((await draft({ number: next })).json.id)
    const auto = (await draft()).json
    expect((await issue(auto.id)).json.number).toBe(`INV-${String(current + 2).padStart(4, '0')}`)
  })

  it('never reuses an automatic number from a voided invoice', async () => {
    const invoice = (await draft()).json
    const used = (await issue(invoice.id)).json.number
    await api('POST', `/invoices/${invoice.id}/void`)
    const next = (await draft()).json
    expect((await issue(next.id)).json.number).not.toBe(used)
  })

  it('locks a typed number after issue', async () => {
    const invoice = (await draft({ number: 'QB-LOCK' })).json
    await issue(invoice.id)
    const edit = await api(
      'PUT',
      `/invoices/${invoice.id}`,
      draftBody(customerId, { number: 'QB-CHANGED' }),
    )
    expect(edit.status).toBe(409)
    expect((await api('GET', `/invoices/${invoice.id}`)).json.number).toBe('QB-LOCK')
  })
})

describe('proformas', () => {
  it('runs a lead from proforma to invoice to active customer', async () => {
    const lead = (
      await api('POST', '/customers', { status: 'lead', name: 'Prospect', currency: 'USD' })
    ).json
    const proforma = (
      await api(
        'POST',
        '/invoices',
        draftBody(lead.id, { type: 'proforma', templateId, validUntil: '2026-12-01' }),
      )
    ).json
    const issued = (await api('POST', `/invoices/${proforma.id}/issue`)).json
    expect(issued.number).toMatch(/^PF-/)
    const text = pdfText(await (await api('GET', `/invoices/${proforma.id}/pdf`)).res.arrayBuffer())
    expect(text).toContain('Proforma Invoice')
    expect(text).toContain('Valid until')

    const converted = await api('POST', `/invoices/${proforma.id}/convert`)
    expect(converted.status).toBe(201)
    expect(converted.json.convertedFromId).toBe(proforma.id)
    expect(converted.json.status).toBe('draft')
    expect((await api('GET', `/invoices/${proforma.id}`)).json.status).toBe('converted')
    expect((await api('GET', `/customers/${lead.id}`)).json.status).toBe('lead')

    await api('POST', `/invoices/${converted.json.id}/issue`)
    expect((await api('GET', `/customers/${lead.id}`)).json.status).toBe('active')
  })
})

describe('original invoices', () => {
  it('stores amounts, base value and links to customer lines', async () => {
    const provider = (await api('GET', '/providers')).json[0]
    const original = await api('POST', '/originals', {
      providerId: provider.id,
      issuedOn: '2026-11-01',
      dueOn: '2026-11-20',
      currency: 'EUR',
      fxRate: 120_000_000,
      tax: 20_000,
      number: 'CTB-1',
      lines: [{ description: 'Server', quantity: 10_000, unitPrice: 500_000 }],
    })
    expect(original.status).toBe(201)
    expect(original.json.total).toBe(520_000)
    expect(original.json.baseTotal).toBe(624_000)

    const res = await ctx.app.request(`/api/v1/originals/${original.json.id}/pdf`, {
      method: 'POST',
      headers: { Cookie: ctx.cookie },
      body: (() => {
        const form = new FormData()
        form.append('file', new File(['%PDF-1.4 sample'], 'a.pdf'))
        return form
      })(),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).pdfFile).toContain('originals/')

    const paid = await api('POST', `/originals/${original.json.id}/paid`, {})
    expect(paid.json.paidOn).toBeTruthy()
    expect((await api('POST', `/originals/${original.json.id}/unpaid`)).json.paidOn).toBeNull()
  })

  it('requires a rate for foreign currency', async () => {
    const provider = (await api('GET', '/providers')).json[0]
    const res = await api('POST', '/originals', {
      providerId: provider.id,
      issuedOn: '2026-11-01',
      currency: 'EUR',
      fxRate: 0,
      lines: [{ description: 'Server', quantity: 10_000, unitPrice: 1 }],
    })
    expect(res.status).toBe(422)
  })

  it('prefills the last rate used', async () => {
    expect((await api('GET', '/fx-rate?currency=EUR')).json.rate).toBe(120_000_000)
    expect((await api('GET', '/fx-rate?currency=USD')).json.rate).toBe(100_000_000)
    expect((await api('GET', '/fx-rate?currency=KWD')).json.rate).toBeNull()
  })
})

describe('settings lock', () => {
  it('locks the base currency once data exists', async () => {
    const current = (await api('GET', '/settings')).json
    expect(current.baseCurrencyLocked).toBe(true)
    const res = await api('PUT', '/settings', {
      baseCurrency: 'OMR',
      renewalLeadDays: 14,
      invoicePrefix: 'INV-',
      proformaPrefix: 'PF-',
    })
    expect(res.status).toBe(409)
  })
})
