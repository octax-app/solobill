import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { beforeAll, describe, expect, it } from 'vitest'
import { discountLimit, dueOf } from '../../shared/payments.ts'
import { config } from '../config.ts'
import { buildPayload, getInvoice, getLines } from '../services/invoices.ts'
import { runReminders } from '../services/renewals.ts'
import { getTemplate } from '../services/templates.ts'
import { configureTemplate, draftBody, line, setup } from './helpers.ts'

let api: Awaited<ReturnType<typeof setup>>['api']
let templateId: number
let ws: number

beforeAll(async () => {
  ;({ api } = await setup())
  ws = (await api('GET', '/auth/me')).json.workspace.id
  templateId = (await api('GET', '/templates')).json[0].id
  await configureTemplate(api, templateId)
})

const ALL_TIME = '/overview?from=0000-01-01&to=9999-12-31'
const OMR_RATE = 260_000_000

async function newCustomer(currency = 'USD') {
  const name = `Customer ${crypto.randomUUID()}`
  return (await api('POST', '/customers', { name, currency })).json.id as number
}

async function draft(customerId: number, over = {}) {
  return (await api('POST', '/invoices', draftBody(customerId, { templateId, ...over }))).json
}

async function issued(customerId: number, over = {}) {
  const { id } = await draft(customerId, over)
  return (await api('POST', `/invoices/${id}/issue`)).json
}

/** 100.000 OMR net with 5% tax, so 105.000 OMR in total, at 2.6 USD. Cost is 60.00 USD. */
const omr = { currency: 'OMR', fxRate: OMR_RATE, taxEnabled: true }

const invoice = async (id: number) => (await api('GET', `/invoices/${id}`)).json
const pay = (id: number, amount: number, over = {}) =>
  api('POST', `/invoices/${id}/payments`, { kind: 'payment', amount, ...over })
const discount = (id: number, amount: number, over = {}) =>
  api('POST', `/invoices/${id}/payments`, { kind: 'discount', amount, ...over })
const customerPay = (id: number, amount: number, over = {}) =>
  api('POST', `/customers/${id}/payments`, { currency: 'USD', amount, ...over })

async function customerProfit(id: number) {
  return (await api('GET', `/customers/${id}/summary`)).json
}

describe('payments on an invoice', () => {
  it('leaves a partly paid invoice issued with the right due', async () => {
    const customerId = await newCustomer()
    const { id } = await issued(customerId)
    const { status, json } = await pay(id, 400_000, { paidOn: '2026-10-01', note: 'Deposit' })
    expect(status).toBe(200)
    expect(json).toMatchObject({ status: 'issued', paidOn: null, paidAmount: 400_000 })
    expect(json.payments).toHaveLength(1)
    expect(json.payments[0]).toMatchObject({
      kind: 'payment',
      amount: 400_000,
      paidOn: '2026-10-01',
      note: 'Deposit',
      groupId: null,
    })
    expect((await customerProfit(customerId)).pending).toBe(600_000)
  })

  it('marks it paid when a later payment reaches exactly the due, on the latest date', async () => {
    const { id } = await issued(await newCustomer())
    await pay(id, 400_000, { paidOn: '2026-10-05' })
    const { json } = await pay(id, 600_000, { paidOn: '2026-10-01' })
    expect(json).toMatchObject({ status: 'paid', paidOn: '2026-10-05', revenueAdjustBase: 0 })
    expect(json.payments.map((row: { amount: number }) => row.amount)).toEqual([600_000, 400_000])
  })

  it('counts a payment above the due as profit, at the invoice rate', async () => {
    const customerId = await newCustomer('OMR')
    const { id } = await issued(customerId, omr)
    const { json } = await pay(id, 1_060_000)
    expect(json).toMatchObject({ status: 'paid', paidAmount: 1_060_000 })
    // 1.000 OMR extra at 2.6 is 2.60 USD, and none of it is tax.
    expect(json.revenueAdjustBase).toBe(26_000)
    const { summary } = await customerProfit(customerId)
    expect(summary).toMatchObject({ revenue: 2_626_000, cost: 600_000, profit: 2_026_000 })
  })

  it('accepts a payment on an issued invoice with a total of 0 and undoes it fully', async () => {
    const { id } = await issued(await newCustomer(), { lines: [line({ unitPrice: 0 })] })
    expect((await pay(id, 10_000)).json).toMatchObject({ status: 'paid', paidAmount: 10_000 })
    const { payments } = await invoice(id)
    await api('DELETE', `/payments/${payments[0].id}`)
    expect(await invoice(id)).toMatchObject({ status: 'issued', paidOn: null, paidAmount: 0 })
  })

  it('refuses amounts that do not fit the currency', async () => {
    const usd = await issued(await newCustomer())
    const usdFail = await pay(usd.id, 12_345)
    expect(usdFail.status).toBe(422)
    expect(usdFail.json.error).toContain('2 decimal places')
    const rial = await issued(await newCustomer('OMR'), omr)
    const rialFail = await pay(rial.id, 12_345)
    expect(rialFail.status).toBe(422)
    expect(rialFail.json.error).toContain('3 decimal places')
    expect((await pay(rial.id, 12_340)).status).toBe(200)
  })

  it('refuses proformas, drafts, voided and paid invoices', async () => {
    const customerId = await newCustomer()
    const proforma = await issued(customerId, { type: 'proforma' })
    expect((await pay(proforma.id, 10_000)).status).toBe(409)
    const draftInvoice = await draft(customerId)
    expect((await pay(draftInvoice.id, 10_000)).status).toBe(409)
    const voided = await issued(customerId)
    await api('POST', `/invoices/${voided.id}/void`)
    expect((await pay(voided.id, 10_000)).status).toBe(409)
    expect((await discount(voided.id, 10_000)).status).toBe(409)
    const converted = await issued(customerId, { type: 'proforma' })
    await api('POST', `/invoices/${converted.id}/convert`)
    expect((await pay(converted.id, 10_000)).status).toBe(409)
    const paid = await issued(customerId)
    await api('POST', `/invoices/${paid.id}/paid`, {})
    const again = await pay(paid.id, 10_000)
    expect(again.status).toBe(409)
    expect(again.json.error).toBe('This invoice is already paid. Remove a payment to change it.')
    expect((await pay(999_999, 10_000)).status).toBe(404)
  })
})

describe('discounts', () => {
  it('lowers due and revenue with no tax to split on an untaxed invoice', async () => {
    const customerId = await newCustomer()
    const { id } = await issued(customerId)
    const { json } = await discount(id, 100_000)
    expect(json).toMatchObject({
      status: 'issued',
      discountAmount: 100_000,
      revenueAdjustBase: -100_000,
    })
    const { summary, pending } = await customerProfit(customerId)
    expect(summary).toMatchObject({ revenue: 900_000, cost: 600_000, profit: 300_000 })
    expect(pending).toBe(900_000)
  })

  it('takes only the net share off revenue on a taxed invoice', async () => {
    const customerId = await newCustomer()
    const { id } = await issued(customerId, { taxEnabled: true })
    // 20.00 before tax takes 21.00 off 105.00.
    const { json } = await discount(id, 200_000)
    expect(json).toMatchObject({ discountAmount: 210_000, revenueAdjustBase: -200_000 })
    const { summary, pending } = await customerProfit(customerId)
    expect(summary).toMatchObject({ revenue: 800_000, cost: 600_000, profit: 200_000 })
    expect(pending).toBe(840_000)
  })

  it('converts the net share at the invoice rate', async () => {
    const customerId = await newCustomer('OMR')
    const { id } = await issued(customerId, omr)
    // 20.000 OMR before tax is 52.00 USD, and takes 21.000 OMR off 105.000.
    const { json } = await discount(id, 200_000)
    expect(json.revenueAdjustBase).toBe(-520_000)
    const { summary, pending } = await customerProfit(customerId)
    expect(summary).toMatchObject({ revenue: 2_080_000, profit: 1_480_000 })
    // 84.000 OMR at 2.6.
    expect(pending).toBe(2_184_000)
  })

  it('marks a partly paid invoice paid when it clears the rest', async () => {
    const { id } = await issued(await newCustomer())
    await pay(id, 700_000, { paidOn: '2026-10-01' })
    const { json } = await discount(id, 300_000, { paidOn: '2026-10-02' })
    expect(json).toMatchObject({
      status: 'paid',
      paidOn: '2026-10-02',
      revenueAdjustBase: -300_000,
    })
  })

  it('refuses a discount above the due and on a paid invoice', async () => {
    const { id } = await issued(await newCustomer())
    await pay(id, 700_000)
    const tooMuch = await discount(id, 300_100)
    expect(tooMuch.status).toBe(422)
    expect(tooMuch.json.error).toContain('30.00 USD')
    await pay(id, 300_000)
    expect((await discount(id, 10_000)).status).toBe(409)
  })
})

describe('customer payments', () => {
  it('fills the oldest invoices first and leaves the last one partly paid', async () => {
    const customerId = await newCustomer()
    const first = await issued(customerId)
    const second = await issued(customerId)
    const third = await issued(customerId)
    await pay(first.id, 200_000, { paidOn: '2026-10-19' })
    const { status, json } = await customerPay(customerId, 1_300_000, {
      paidOn: '2026-10-20',
      note: 'Wire',
    })
    expect(status).toBe(201)
    expect(json).toEqual({
      allocations: [
        { invoiceId: first.id, number: first.number, amount: 800_000 },
        { invoiceId: second.id, number: second.number, amount: 500_000 },
      ],
      excess: 0,
    })
    expect(await invoice(first.id)).toMatchObject({ status: 'paid', paidOn: '2026-10-20' })
    expect(await invoice(second.id)).toMatchObject({ status: 'issued', paidAmount: 500_000 })
    expect((await invoice(third.id)).paidAmount).toBe(0)
    const rows = [...(await invoice(first.id)).payments, ...(await invoice(second.id)).payments]
    const grouped = rows.filter((row) => row.groupId)
    expect(grouped).toHaveLength(2)
    expect(new Set(grouped.map((row) => row.groupId)).size).toBe(1)
    expect(grouped[0].note).toBe('Wire')
    expect((await customerProfit(customerId)).pending).toBe(1_500_000)
  })

  it('puts any excess on the last invoice as profit', async () => {
    const customerId = await newCustomer()
    const first = await issued(customerId)
    const second = await issued(customerId)
    const { json } = await customerPay(customerId, 2_050_000)
    expect(json.excess).toBe(50_000)
    expect(json.allocations.map((row: { amount: number }) => row.amount)).toEqual([
      1_000_000, 1_050_000,
    ])
    expect((await invoice(first.id)).revenueAdjustBase).toBe(0)
    expect(await invoice(second.id)).toMatchObject({ status: 'paid', revenueAdjustBase: 50_000 })
  })

  it('ignores other currencies, proformas and other customers', async () => {
    const customerId = await newCustomer()
    const usd = await issued(customerId)
    const rial = await issued(customerId, omr)
    await issued(customerId, { type: 'proforma' })
    await issued(await newCustomer())
    const { json } = await customerPay(customerId, 300_000)
    expect(json.allocations).toEqual([{ invoiceId: usd.id, number: usd.number, amount: 300_000 }])
    expect((await invoice(rial.id)).paidAmount).toBe(0)
  })

  it('is refused when nothing is open in that currency, with no rows left behind', async () => {
    const customerId = await newCustomer()
    await issued(customerId, omr)
    const { status, json } = await customerPay(customerId, 100_000)
    expect(status).toBe(422)
    expect(json.error).toBe('No open USD invoices for this customer')
  })

  it('checks the customer and the currency decimals', async () => {
    expect((await customerPay(999_999, 100_000)).status).toBe(404)
    const customerId = await newCustomer()
    await issued(customerId)
    expect((await customerPay(customerId, 100_050)).status).toBe(422)
  })
})

describe('removing a payment or discount', () => {
  it('restores due, status and profit', async () => {
    const customerId = await newCustomer()
    const { id } = await issued(customerId, { taxEnabled: true })
    const before = await customerProfit(customerId)
    await discount(id, 210_000, { paidOn: '2026-10-04' })
    const paid = await pay(id, 1_000_000, { paidOn: '2026-10-05' })
    expect(paid.json).toMatchObject({ status: 'paid', paidOn: '2026-10-05' })
    for (const row of paid.json.payments) {
      expect((await api('DELETE', `/payments/${row.id}`)).json).toEqual({ ok: true })
    }
    expect(await invoice(id)).toMatchObject({
      status: 'issued',
      paidOn: null,
      paidAmount: 0,
      discountAmount: 0,
      revenueAdjustBase: 0,
      payments: [],
    })
    expect(await customerProfit(customerId)).toMatchObject({
      pending: before.pending,
      summary: before.summary,
    })
  })

  it('removes the whole customer payment from any of its rows', async () => {
    const customerId = await newCustomer()
    const first = await issued(customerId)
    const second = await issued(customerId)
    await pay(second.id, 100_000)
    await customerPay(customerId, 1_500_000)
    const { payments } = await invoice(first.id)
    await api('DELETE', `/payments/${payments[0].id}`)
    expect(await invoice(first.id)).toMatchObject({ status: 'issued', payments: [] })
    const left = await invoice(second.id)
    expect(left).toMatchObject({ status: 'issued', paidAmount: 100_000 })
    expect(left.payments).toHaveLength(1)
  })

  it('refuses when any invoice of the group is void, and keeps the rows as history', async () => {
    const customerId = await newCustomer()
    const first = await issued(customerId)
    const second = await issued(customerId)
    await customerPay(customerId, 1_500_000)
    await api('POST', `/invoices/${first.id}/void`)
    const { payments } = await invoice(second.id)
    const refused = await api('DELETE', `/payments/${payments[0].id}`)
    expect(refused.status).toBe(409)
    expect(refused.json.error).toContain(first.number)
    expect((await invoice(first.id)).payments).toHaveLength(1)
    expect((await invoice(second.id)).payments).toHaveLength(1)
  })

  it('returns 404 for a row that does not exist', async () => {
    expect((await api('DELETE', '/payments/999999')).status).toBe(404)
  })
})

describe('mark as paid and undo', () => {
  it('records a payment for the current due', async () => {
    const { id } = await issued(await newCustomer())
    await pay(id, 400_000, { paidOn: '2026-10-08' })
    const paid = await api('POST', `/invoices/${id}/paid`, { paidOn: '2026-10-09' })
    expect(paid.json).toMatchObject({ status: 'paid', paidOn: '2026-10-09', paidAmount: 1_000_000 })
    expect(paid.json.lines).toBeUndefined()
    const { payments } = await invoice(id)
    expect(payments.map((row: { amount: number }) => row.amount).sort()).toEqual([400_000, 600_000])
  })

  it('undoes the last row only, leaving earlier payments', async () => {
    const { id } = await issued(await newCustomer())
    await pay(id, 400_000)
    await api('POST', `/invoices/${id}/paid`, {})
    const undone = await api('POST', `/invoices/${id}/unpaid`)
    expect(undone.json).toMatchObject({ status: 'issued', paidOn: null, paidAmount: 400_000 })
  })

  it('reopens the invoice even when the last row entered carries an earlier date', async () => {
    const { id } = await issued(await newCustomer())
    await pay(id, 10_000, { paidOn: '2026-10-20' })
    await pay(id, 2_000_000, { paidOn: '2026-10-01' })
    const undone = await api('POST', `/invoices/${id}/unpaid`)
    expect(undone.json).toMatchObject({ status: 'issued', paidAmount: 10_000 })
  })

  it('removes the whole group when the last row belongs to a customer payment', async () => {
    const customerId = await newCustomer()
    const first = await issued(customerId)
    const second = await issued(customerId)
    await customerPay(customerId, 2_000_000)
    await api('POST', `/invoices/${first.id}/unpaid`)
    expect(await invoice(second.id)).toMatchObject({ status: 'issued', paidAmount: 0 })
  })

  it('still works on a total of 0, with no row', async () => {
    const { id } = await issued(await newCustomer(), { lines: [line({ unitPrice: 0 })] })
    const paid = await api('POST', `/invoices/${id}/paid`, { paidOn: '2026-10-09' })
    expect(paid.json).toMatchObject({ status: 'paid', paidOn: '2026-10-09' })
    expect((await invoice(id)).payments).toEqual([])
    const undone = await api('POST', `/invoices/${id}/unpaid`)
    expect(undone.json).toMatchObject({ status: 'issued', paidOn: null })
  })

  it('refuses to undo an invoice that is not paid', async () => {
    const { id } = await issued(await newCustomer())
    expect((await api('POST', `/invoices/${id}/unpaid`)).status).toBe(409)
  })
})

describe('undo payments', () => {
  const undo = (id: number) => api('POST', `/invoices/${id}/undo-payments`)
  const nothingPaid = {
    status: 'issued',
    paidOn: null,
    paidAmount: 0,
    discountAmount: 0,
    revenueAdjustBase: 0,
    payments: [],
  }

  it('returns an invoice marked as paid by mistake to issued', async () => {
    const { id } = await issued(await newCustomer())
    await api('POST', `/invoices/${id}/paid`, {})
    expect((await undo(id)).json).toMatchObject(nothingPaid)
  })

  it('removes every row from a paid invoice, discounts included', async () => {
    const { id } = await issued(await newCustomer())
    await pay(id, 300_000)
    await discount(id, 100_000)
    await api('POST', `/invoices/${id}/paid`, {})
    expect((await undo(id)).json).toMatchObject(nothingPaid)
  })

  it('removes a customer payment from every invoice it covers', async () => {
    const customerId = await newCustomer()
    const first = await issued(customerId)
    const second = await issued(customerId)
    await customerPay(customerId, 1_500_000)
    const paid = (await invoice(first.id)).status === 'paid' ? first : second
    expect((await undo(paid.id)).json).toMatchObject(nothingPaid)
    expect(await invoice(first.id)).toMatchObject(nothingPaid)
    expect(await invoice(second.id)).toMatchObject(nothingPaid)
  })

  it('changes nothing when a customer payment also covers a voided invoice', async () => {
    const customerId = await newCustomer()
    const first = await issued(customerId)
    const second = await issued(customerId)
    await customerPay(customerId, 2_000_000)
    await api('POST', `/invoices/${first.id}/void`)
    const before = await invoice(second.id)
    expect((await undo(second.id)).status).toBe(409)
    expect(await invoice(second.id)).toEqual(before)
  })

  it('still works on a total of 0, with no row', async () => {
    const { id } = await issued(await newCustomer(), { lines: [line({ unitPrice: 0 })] })
    await api('POST', `/invoices/${id}/paid`, {})
    expect((await undo(id)).json).toMatchObject(nothingPaid)
  })

  it('refuses partly paid and unpaid invoices, and a draft', async () => {
    const customerId = await newCustomer()
    const { id } = await issued(customerId)
    expect((await undo(id)).status).toBe(409)
    await pay(id, 100_000)
    expect((await undo(id)).status).toBe(409)
    expect((await invoice(id)).paidAmount).toBe(100_000)
    const { json: draft } = await api('POST', '/invoices', draftBody(customerId))
    expect((await undo(draft.id)).status).toBe(409)
  })

  it('lets the invoice be reversed afterwards', async () => {
    const { id } = await issued(await newCustomer())
    await api('POST', `/invoices/${id}/paid`, {})
    expect((await api('POST', `/invoices/${id}/reverse`)).status).toBe(409)
    await undo(id)
    expect((await api('POST', `/invoices/${id}/reverse`)).json.status).toBe('draft')
  })
})

describe('overview', () => {
  it('collects what is due and keeps the total on each row', async () => {
    const customerId = await newCustomer('OMR')
    const { id, number } = await issued(customerId, omr)
    const before = (await api('GET', ALL_TIME)).json.toCollectTotal
    await pay(id, 310_000)
    const view = (await api('GET', ALL_TIME)).json
    const row = view.toCollect.find((item: { id: number }) => item.id === id)
    expect(row).toMatchObject({
      number,
      total: 1_050_000,
      baseTotal: 2_730_000,
      due: 740_000,
      baseDue: 1_924_000,
    })
    expect(view.toCollectTotal).toBe(before - 806_000)
    expect(row.paidAmount).toBeUndefined()
    expect(row.fxRate).toBeUndefined()
  })

  it('drops a settled invoice from To collect', async () => {
    const { id } = await issued(await newCustomer())
    await pay(id, 1_000_000)
    const view = (await api('GET', ALL_TIME)).json
    expect(view.toCollect.some((item: { id: number }) => item.id === id)).toBe(false)
  })

  it('leaves revenue on the issue month, whenever the payment is made', async () => {
    const customerId = await newCustomer()
    const { id, issuedOn } = await issued(customerId)
    await pay(id, 1_100_000, { paidOn: '2030-01-15' })
    const month = (await api('GET', `/overview?from=${issuedOn}&to=${issuedOn}`)).json
    const later = (await api('GET', '/overview?from=2030-01-01&to=2030-01-31')).json
    expect(month.summary.revenue).toBeGreaterThanOrEqual(1_100_000)
    expect(later.summary.revenue).toBe(0)
  })

  it('keeps a partly paid invoice overdue, and the reminder states what is due', async () => {
    const customerId = await newCustomer()
    const { id, number } = await issued(customerId, { dueOn: '2020-01-01' })
    await pay(id, 400_000)
    runReminders()
    const { json } = await api('GET', '/reminders')
    const reminder = json.find(
      (row: { kind: string; refId: number }) => row.kind === 'invoice_overdue' && row.refId === id,
    )
    expect(reminder.message).toContain(`${number} `)
    expect(reminder.message).toContain('60.00 USD')
    const view = (await api('GET', ALL_TIME)).json
    expect(view.toCollect.some((item: { id: number }) => item.id === id)).toBe(true)
  })
})

describe('the issued document', () => {
  it('does not change after payments', async () => {
    const customerId = await newCustomer()
    const { id, number, issuedOn } = await issued(customerId, { taxEnabled: true })
    const stored = async () =>
      Buffer.from(await (await api('GET', `/invoices/${id}/pdf`)).res.arrayBuffer())
    const payload = () => {
      const current = getInvoice(ws, id)
      return buildPayload(
        ws,
        current,
        getLines(ws, id),
        getTemplate(ws, templateId),
        number,
        issuedOn,
      )
    }
    const pdfBefore = await stored()
    const payloadBefore = payload()
    const { pdfFile } = await invoice(id)

    await pay(id, 400_000)
    await customerPay(customerId, 650_000)

    expect(await invoice(id)).toMatchObject({ status: 'paid', pdfFile })
    expect((await stored()).equals(pdfBefore)).toBe(true)
    expect(payload()).toEqual(payloadBefore)
    expect(JSON.stringify(payload())).not.toMatch(/paid|discount|due:/i)
  })
})

describe('the discount on the PDF', () => {
  const text = async (id: number) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discount-'))
    const file = path.join(dir, 'x.pdf')
    const bytes = await (await api('GET', `/invoices/${id}/pdf`)).res.arrayBuffer()
    fs.writeFileSync(file, Buffer.from(bytes))
    return execFileSync('pdftotext', ['-layout', file, '-']).toString()
  }
  const stored = (key: string) => fs.existsSync(path.join(config.filesDir, key))

  it('prints before tax and replaces the stored PDF', async () => {
    const { id } = await issued(await newCustomer(), { taxEnabled: true })
    const { pdfFile: first } = await invoice(id)
    const { json } = await discount(id, 100_000)
    expect(json).toMatchObject({ status: 'issued', discountAmount: 105_000, total: 1_050_000 })
    expect(dueOf(json)).toBe(945_000)
    expect(json.pdfFile).not.toBe(first)
    expect(stored(first)).toBe(false)
    const printed = await text(id)
    expect(printed).toMatch(/Subtotal\s+100\.00 USD/)
    expect(printed).toMatch(/Discount\s+-10\.00 USD/)
    expect(printed).toMatch(/Tax \(5%\)\s+4\.50 USD/)
    expect(printed).toMatch(/Total\s+94\.50 USD/)
  })

  it('prints on an untaxed invoice, and not when there is no discount', async () => {
    const { id } = await issued(await newCustomer())
    expect(await text(id)).not.toContain('Discount')
    await discount(id, 100_000)
    const printed = await text(id)
    expect(printed).toMatch(/Discount\s+-10\.00 USD/)
    expect(printed).toMatch(/Total\s+90\.00 USD/)
  })

  it('never prints payments, and a payment leaves the PDF alone', async () => {
    const { id } = await issued(await newCustomer())
    await discount(id, 100_000)
    const { pdfFile } = await invoice(id)
    await pay(id, 300_000)
    expect((await invoice(id)).pdfFile).toBe(pdfFile)
    expect(await text(id)).not.toMatch(/30\.00|Paid|Due\b/)
  })

  it('goes back to the plain totals when the discount is removed', async () => {
    const { id } = await issued(await newCustomer(), { taxEnabled: true })
    await discount(id, 100_000)
    const { pdfFile, payments } = await invoice(id)
    await api('DELETE', `/payments/${payments[0].id}`)
    const after = await invoice(id)
    expect(after.pdfFile).not.toBe(pdfFile)
    expect(stored(pdfFile)).toBe(false)
    const printed = await text(id)
    expect(printed).not.toContain('Discount')
    expect(printed).toMatch(/Total\s+105\.00 USD/)
  })

  it('updates on undo paid and on undoing with the old route', async () => {
    const { id } = await issued(await newCustomer())
    await discount(id, 100_000)
    await api('POST', `/invoices/${id}/paid`, {})
    await api('POST', `/invoices/${id}/undo-payments`)
    expect(await text(id)).not.toContain('Discount')

    await pay(id, 900_000)
    await discount(id, 100_000)
    expect((await invoice(id)).status).toBe('paid')
    await api('POST', `/invoices/${id}/unpaid`)
    expect(await text(id)).not.toContain('Discount')
  })

  it('keeps the issued number, date and company after the template changes', async () => {
    const { id, number } = await issued(await newCustomer(), { issueDate: '2026-02-03' })
    const template = (await api('GET', `/templates/${templateId}`)).json
    const old = (await invoice(id)).sellerSnapshot.companyName
    await api('PUT', `/templates/${templateId}`, { ...template, companyName: 'Renamed Co' })
    await discount(id, 100_000)
    await configureTemplate(api, templateId)
    const printed = await text(id)
    expect(printed).toContain(number)
    expect(printed).toContain('2026-02-03')
    expect(printed).toContain(old)
    expect(printed).not.toContain('Renamed Co')
  })

  it('closes the invoice exactly from the limit, or from the due as old builds send', async () => {
    for (const amount of [952_381, 1_000_001]) {
      const { id } = await issued(await newCustomer(), {
        taxEnabled: true,
        lines: [line({ unitPrice: 1_000_001 })],
      })
      const full = await invoice(id)
      const limit = amount === 952_381 ? discountLimit(full) : dueOf(full)
      const { json } = await discount(id, limit)
      expect(json.status).toBe('paid')
      expect(dueOf(json)).toBe(0)
    }
  })

  it('refuses more than the limit, and names it before tax', async () => {
    const { id } = await issued(await newCustomer(), { taxEnabled: true })
    await pay(id, 840_000)
    const res = await discount(id, 200_100)
    expect(res.status).toBe(422)
    expect(res.json.error).toContain('20.00 USD before tax')
  })
})

describe('voiding', () => {
  it('keeps the rows and takes the invoice out of the figures', async () => {
    const customerId = await newCustomer()
    const { id } = await issued(customerId)
    await pay(id, 400_000)
    const voided = await api('POST', `/invoices/${id}/void`)
    expect(voided.json).toMatchObject({ status: 'void', paidAmount: 400_000 })
    const { payments } = await invoice(id)
    expect(payments).toHaveLength(1)
    expect((await api('DELETE', `/payments/${payments[0].id}`)).status).toBe(409)
    const { summary, pending } = await customerProfit(customerId)
    expect(summary.revenue).toBe(0)
    expect(pending).toBe(0)
  })
})

describe('the migration backfill', () => {
  const folder = path.resolve(import.meta.dirname, '../../../drizzle')
  const journal = JSON.parse(fs.readFileSync(path.join(folder, 'meta/_journal.json'), 'utf8'))
  const applyUpTo = (database: Database.Database, last: number, first = 0) => {
    for (const { idx, tag } of journal.entries) {
      if (idx < first || idx > last) continue
      const sql = fs.readFileSync(path.join(folder, `${tag}.sql`), 'utf8')
      for (const statement of sql.split('--> statement-breakpoint')) database.exec(statement)
    }
  }

  function legacyDatabase() {
    const database = new Database(':memory:')
    database.pragma('foreign_keys = OFF')
    applyUpTo(database, 4)
    const insert = database.prepare(`
      INSERT INTO invoices
        (id, type, status, customer_id, template_id, currency, fx_rate, total, paid_on,
         created_at, updated_at)
      VALUES (?, 'invoice', ?, 1, 1, 'USD', 100000000, ?, ?, '2026-09-01', '2026-09-03')`)
    insert.run(1, 'paid', 1_000_000, '2026-09-02')
    insert.run(2, 'issued', 500_000, null)
    insert.run(3, 'paid', 0, '2026-09-04')
    insert.run(4, 'void', 700_000, '2026-09-05')
    applyUpTo(database, 5, 5)
    return database
  }

  it('gives paid invoices one row for their total and leaves the rest alone', () => {
    const database = legacyDatabase()
    const rows = database
      .prepare('SELECT invoice_id, kind, amount, paid_on, group_id FROM invoice_payments')
      .all()
    expect(rows).toEqual([
      { invoice_id: 1, kind: 'payment', amount: 1_000_000, paid_on: '2026-09-02', group_id: null },
    ])
    const amounts = database.prepare('SELECT id, status, paid_amount FROM invoices ORDER BY id')
    expect(amounts.all()).toEqual([
      { id: 1, status: 'paid', paid_amount: 1_000_000 },
      { id: 2, status: 'issued', paid_amount: 0 },
      { id: 3, status: 'paid', paid_amount: 0 },
      { id: 4, status: 'void', paid_amount: 0 },
    ])
  })

  it('leaves a backfilled invoice that removes cleanly through the normal flow', async () => {
    const customerId = await newCustomer()
    const { id, total } = await issued(customerId)
    const { db, schema } = await import('../db/index.ts')
    const { eq } = await import('drizzle-orm')
    // The same row and figures the migration writes for an invoice that was already paid.
    db.update(schema.invoices)
      .set({ status: 'paid', paidOn: '2026-09-02', paidAmount: total })
      .where(eq(schema.invoices.id, id))
      .run()
    db.insert(schema.invoicePayments)
      .values({
        workspaceId: ws,
        invoiceId: id,
        kind: 'payment',
        amount: total,
        paidOn: '2026-09-02',
      })
      .run()
    const { payments } = await invoice(id)
    expect(payments).toHaveLength(1)
    await api('DELETE', `/payments/${payments[0].id}`)
    expect(await invoice(id)).toMatchObject({ status: 'issued', paidOn: null, paidAmount: 0 })
    expect((await customerProfit(customerId)).pending).toBe(total)
  })
})
