import { Hono } from 'hono'
import { todayISO } from '../../shared/dates.ts'
import {
  customerPaymentInput,
  invoiceInput,
  lineCostInput,
  originalInvoiceInput,
  paidInput,
  paymentInput,
} from '../../shared/schemas.ts'
import type { AuthEnv } from '../auth.ts'
import { ApiError } from '../errors.ts'
import * as service from '../services/invoices.ts'
import * as originals from '../services/originals.ts'
import * as payments from '../services/payments.ts'
import { resolveTemplateId } from '../services/templates.ts'
import { removeFile, saveFile } from '../storage.ts'
import { body, hideWorkspaceId, idParam, uploaded } from './util.ts'

export const invoiceRoutes = new Hono<AuthEnv>()
invoiceRoutes.use('*', hideWorkspaceId)

const pdf = (bytes: Uint8Array) =>
  new Response(Buffer.from(bytes), { headers: { 'Content-Type': 'application/pdf' } })

/** Runs a change to an invoice's rows, then brings its PDF in line if the discount moved. */
async function keepingPdf<T>(ws: number, id: number, change: () => T) {
  const { discountAmount } = service.getInvoice(ws, id)
  const result = change()
  await service.rebuildPdfForDiscount(ws, id, discountAmount)
  return result
}

const full = (ws: number, id: number) => ({
  ...service.getInvoice(ws, id),
  lines: service.getLines(ws, id),
  payments: payments.listPayments(ws, id),
})

invoiceRoutes.get('/fx-rate', (c) => {
  const currency = c.req.query('currency')
  if (!currency) throw new ApiError(422, 'Choose a currency')
  return c.json({ rate: service.lastFxRate(c.get('workspaceId'), currency) })
})

invoiceRoutes.get('/resolve-template', (c) =>
  c.json({
    templateId: resolveTemplateId(
      c.get('workspaceId'),
      Number(c.req.query('serviceId')) || null,
      Number(c.req.query('providerId')) || null,
    ),
  }),
)

invoiceRoutes.get('/invoices', (c) =>
  c.json(
    service.listInvoices(c.get('workspaceId'), {
      type: c.req.query('type'),
      status: c.req.query('status'),
      customerId: Number(c.req.query('customerId')) || undefined,
    }),
  ),
)

invoiceRoutes.post('/invoices', async (c) => {
  const ws = c.get('workspaceId')
  const created = service.createDraft(ws, await body(c, invoiceInput))
  return c.json(full(ws, created.id), 201)
})

invoiceRoutes.get('/invoices/:id', (c) => c.json(full(c.get('workspaceId'), idParam(c))))

invoiceRoutes.put('/invoices/:id', async (c) => {
  const ws = c.get('workspaceId')
  const updated = service.updateDraft(ws, idParam(c), await body(c, invoiceInput))
  return c.json(full(ws, updated.id))
})

invoiceRoutes.delete('/invoices/:id', (c) => {
  service.deleteDraft(c.get('workspaceId'), idParam(c))
  return c.json({ ok: true })
})

invoiceRoutes.get('/invoices/:id/pdf', async (c) =>
  pdf(await service.previewPdf(c.get('workspaceId'), idParam(c))),
)

invoiceRoutes.post('/invoices/:id/issue', async (c) => {
  const ws = c.get('workspaceId')
  const issued = await service.issueInvoice(ws, idParam(c))
  return c.json(full(ws, issued.id))
})

invoiceRoutes.post('/invoices/:id/void', (c) =>
  c.json(service.voidInvoice(c.get('workspaceId'), idParam(c))),
)

invoiceRoutes.post('/invoices/:id/reverse', async (c) => {
  const ws = c.get('workspaceId')
  const draft = await service.reverseInvoice(ws, idParam(c))
  return c.json(full(ws, draft.id))
})

invoiceRoutes.post('/invoices/:id/paid', async (c) => {
  const { paidOn } = await body(c, paidInput)
  return c.json(service.markPaid(c.get('workspaceId'), idParam(c), paidOn ?? todayISO()))
})

invoiceRoutes.post('/invoices/:id/unpaid', async (c) => {
  const ws = c.get('workspaceId')
  const id = idParam(c)
  await keepingPdf(ws, id, () => service.markUnpaid(ws, id))
  return c.json(service.getInvoice(ws, id))
})

invoiceRoutes.post('/invoices/:id/payments', async (c) => {
  const ws = c.get('workspaceId')
  const id = idParam(c)
  const input = await body(c, paymentInput)
  await keepingPdf(ws, id, () => payments.addPayment(ws, id, input))
  return c.json(full(ws, id))
})

invoiceRoutes.post('/invoices/:id/undo-payments', async (c) => {
  const ws = c.get('workspaceId')
  const id = idParam(c)
  await keepingPdf(ws, id, () => payments.undoPayments(ws, id))
  return c.json(full(ws, id))
})

invoiceRoutes.delete('/payments/:id', async (c) => {
  const ws = c.get('workspaceId')
  const id = idParam(c)
  await keepingPdf(ws, payments.getPayment(ws, id).invoiceId, () => payments.removePayment(ws, id))
  return c.json({ ok: true })
})

invoiceRoutes.post('/customers/:id/payments', async (c) =>
  c.json(
    payments.addCustomerPayment(
      c.get('workspaceId'),
      idParam(c),
      await body(c, customerPaymentInput),
    ),
    201,
  ),
)

invoiceRoutes.post('/invoices/:id/convert', (c) => {
  const ws = c.get('workspaceId')
  const draft = service.convertProforma(ws, idParam(c))
  return c.json(full(ws, draft.id), 201)
})

invoiceRoutes.post('/invoices/:id/duplicate', (c) => {
  const ws = c.get('workspaceId')
  const draft = service.duplicateInvoice(ws, idParam(c))
  return c.json(full(ws, draft.id), 201)
})

invoiceRoutes.patch('/invoices/:id/lines/:lineId/cost', async (c) => {
  const input = await body(c, lineCostInput)
  return c.json(
    service.updateLineCost(c.get('workspaceId'), idParam(c), idParam(c, 'lineId'), input),
  )
})

invoiceRoutes.get('/original-lines', (c) =>
  c.json(service.originalLineOptions(c.get('workspaceId'))),
)

/* Original invoices */

invoiceRoutes.get('/originals', (c) => c.json(originals.listOriginals(c.get('workspaceId'))))

invoiceRoutes.post('/originals', async (c) =>
  c.json(
    originals.saveOriginal(c.get('workspaceId'), null, await body(c, originalInvoiceInput)),
    201,
  ),
)

invoiceRoutes.get('/originals/:id', (c) =>
  c.json(originals.getOriginal(c.get('workspaceId'), idParam(c))),
)

invoiceRoutes.put('/originals/:id', async (c) => {
  const ws = c.get('workspaceId')
  const id = idParam(c)
  originals.getOriginal(ws, id)
  return c.json(originals.saveOriginal(ws, id, await body(c, originalInvoiceInput)))
})

invoiceRoutes.delete('/originals/:id', async (c) => {
  await originals.deleteOriginal(c.get('workspaceId'), idParam(c))
  return c.json({ ok: true })
})

invoiceRoutes.post('/originals/:id/pdf', async (c) => {
  const ws = c.get('workspaceId')
  const id = idParam(c)
  const existing = originals.getOriginal(ws, id)
  const pdfFile = await saveFile('originals', await uploaded(c), 'pdf')
  const saved = originals.saveOriginal(
    ws,
    id,
    {
      providerId: existing.providerId,
      serviceId: existing.serviceId,
      number: existing.number,
      issuedOn: existing.issuedOn,
      dueOn: existing.dueOn,
      currency: existing.currency,
      fxRate: existing.fxRate,
      tax: existing.tax,
      notes: existing.notes,
      lines: existing.lines.map(({ description, quantity, unitPrice }) => ({
        description,
        quantity,
        unitPrice,
      })),
    },
    pdfFile,
  )
  await removeFile(existing.pdfFile)
  return c.json(saved)
})

invoiceRoutes.post('/originals/:id/paid', async (c) => {
  const { paidOn } = await body(c, paidInput)
  return c.json(originals.setOriginalPaid(c.get('workspaceId'), idParam(c), paidOn ?? todayISO()))
})

invoiceRoutes.post('/originals/:id/unpaid', (c) =>
  c.json(originals.setOriginalPaid(c.get('workspaceId'), idParam(c), null)),
)
