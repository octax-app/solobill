import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm'
import { calculateInvoice } from '../../shared/calc.ts'
import { nextRenewal, todayISO } from '../../shared/dates.ts'
import {
  amountInput,
  FX_SCALE,
  formatAmount,
  formatMoney,
  formatUnitPrice,
  percentText,
  toBase,
} from '../../shared/money.ts'
import { discountedTotals, dueOf } from '../../shared/payments.ts'
import {
  type CustomField,
  type CustomValues,
  customItemsFor,
  customValueProblem,
  type RenderPayload,
} from '../../shared/render.ts'
import type { InvoiceInput } from '../../shared/schemas.ts'
import { db, type schema as Schema, schema, sqlite } from '../db/index.ts'
import { ApiError, notFound } from '../errors.ts'
import { readFile, removeFile, saveFile } from '../storage.ts'
import { createLock } from './lock.ts'
import { addPayment, lastEnteredPayment, removePayment, settleInvoice } from './payments.ts'
import { getSettings } from './settings.ts'
import { renderWithTemplate } from './template-render.ts'
import { getRegions, getTemplate, resolveTemplateId, templateProblems } from './templates.ts'

const {
  customers,
  invoiceLines,
  invoicePayments,
  invoices,
  numberSequences,
  originalInvoiceLines,
  originalInvoices,
  providers,
  services,
  subscriptionLines,
  subscriptions,
} = schema

type Invoice = typeof Schema.invoices.$inferSelect
type Line = typeof Schema.invoiceLines.$inferSelect

const issueLock = createLock()

const byId = (ws: number, id: number) => and(eq(invoices.workspaceId, ws), eq(invoices.id, id))

export function getInvoice(ws: number, id: number) {
  const invoice = db.select().from(invoices).where(byId(ws, id)).get()
  if (!invoice) throw notFound('Invoice')
  return invoice
}

export function getLines(ws: number, invoiceId: number) {
  return db
    .select()
    .from(invoiceLines)
    .where(and(eq(invoiceLines.workspaceId, ws), eq(invoiceLines.invoiceId, invoiceId)))
    .orderBy(asc(invoiceLines.position))
    .all()
}

/** The last rate used for a currency, across invoices and originals. */
export function lastFxRate(ws: number, currency: string): number | null {
  const { baseCurrency } = getSettings(ws)
  if (currency === baseCurrency) return FX_SCALE
  const invoice = db
    .select({ rate: invoices.fxRate, at: invoices.updatedAt })
    .from(invoices)
    .where(
      and(eq(invoices.workspaceId, ws), eq(invoices.currency, currency), ne(invoices.fxRate, 0)),
    )
    .orderBy(desc(invoices.updatedAt))
    .get()
  const original = db
    .select({ rate: originalInvoices.fxRate, at: originalInvoices.updatedAt })
    .from(originalInvoices)
    .where(
      and(
        eq(originalInvoices.workspaceId, ws),
        eq(originalInvoices.currency, currency),
        ne(originalInvoices.fxRate, 0),
      ),
    )
    .orderBy(desc(originalInvoices.updatedAt))
    .get()
  const line = db
    .select({ rate: invoiceLines.costFxRate })
    .from(invoiceLines)
    .where(
      and(
        eq(invoiceLines.workspaceId, ws),
        eq(invoiceLines.costCurrency, currency),
        ne(invoiceLines.costFxRate, 0),
      ),
    )
    .orderBy(desc(invoiceLines.id))
    .get()
  const candidates = [invoice, original].filter((row) => row !== undefined)
  candidates.sort((a, b) => b.at.localeCompare(a.at))
  return candidates[0]?.rate ?? line?.rate ?? null
}

export function effectiveRate(currency: string, rate: number, baseCurrency: string) {
  return currency === baseCurrency ? FX_SCALE : rate
}

type PeriodLine = Pick<
  InvoiceInput['lines'][number],
  'subscriptionId' | 'subscriptionLineId' | 'periodStart'
>

/**
 * Only invoices claim a subscription period. A proforma is a quote, so it must not hold up
 * renewals. Another live document covering the period is refused, to prevent double billing.
 */
function periodFor(
  ws: number,
  line: PeriodLine,
  type: Invoice['type'],
  invoiceId: number,
): string | null {
  if (type === 'proforma') return null
  if (line.periodStart || !line.subscriptionId) return line.periodStart
  const subscription = db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.workspaceId, ws), eq(subscriptions.id, line.subscriptionId)))
    .get()
  const period = subscription?.nextRenewalOn
  if (!period) return null
  const taken = db
    .select({
      invoiceId: invoiceLines.invoiceId,
      subscriptionLineId: invoiceLines.subscriptionLineId,
      status: invoices.status,
      number: invoices.number,
    })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .where(
      and(
        eq(invoiceLines.workspaceId, ws),
        eq(invoices.workspaceId, ws),
        eq(invoiceLines.subscriptionId, line.subscriptionId),
        eq(invoiceLines.periodStart, period),
      ),
    )
    .all()
  const other = taken.find((row) => row.invoiceId !== invoiceId && row.status !== 'void')
  if (other) {
    const name = other.number ?? `the draft #${other.invoiceId}`
    throw new ApiError(
      409,
      `The period from ${period} is already on ${name}. Open that document instead.`,
      `/invoices/${other.invoiceId}`,
    )
  }
  const repeated = taken.some(
    (row) =>
      row.invoiceId !== invoiceId ||
      !line.subscriptionLineId ||
      row.subscriptionLineId === line.subscriptionLineId,
  )
  return repeated ? null : period
}

/** Blank means not entered, and an item that is not on the template cannot print. */
function keepCustomValues(values: CustomValues, fields: CustomField[]) {
  const ids = new Set(fields.map((field) => field.id))
  return Object.fromEntries(
    Object.entries(values).filter(([id, value]) => ids.has(id) && value.trim()),
  )
}

function persistDraft(
  ws: number,
  invoiceId: number | null,
  input: InvoiceInput,
  source: 'manual' | 'renewal',
) {
  assertReferences(ws, input)
  const { baseCurrency } = getSettings(ws)
  const fxRate = effectiveRate(input.currency, input.fxRate, baseCurrency)
  const calc = calculateInvoice({
    currency: input.currency,
    baseCurrency,
    fxRate,
    taxEnabled: input.taxEnabled,
    taxRate: input.taxRate,
    lines: input.lines,
  })
  const templateId = input.templateId ?? resolveTemplateId(ws, input.serviceId, input.providerId)
  const template = getTemplate(ws, templateId)
  if (input.number) assertNumberFree(ws, issuerKeyFor(template), input.type, input.number)
  // iOS sends whole drafts back without this key, so absent must not wipe what the web saved.
  const customValues = keepCustomValues(
    input.customValues ?? (invoiceId ? getInvoice(ws, invoiceId).customValues : {}),
    template.customFields,
  )
  const values = {
    workspaceId: ws,
    type: input.type,
    number: input.number,
    customerId: input.customerId,
    providerId: input.providerId,
    serviceId: input.serviceId,
    templateId,
    ...(input.issueDate === undefined ? {} : { issueDate: input.issueDate }),
    dueOn: input.dueOn,
    validUntil: input.validUntil,
    currency: input.currency,
    fxRate,
    taxEnabled: input.taxEnabled,
    taxRate: input.taxRate,
    notes: input.notes,
    customValues,
    subtotal: calc.subtotal,
    tax: calc.tax,
    total: calc.total,
    baseSubtotal: calc.baseSubtotal,
    baseTotal: calc.baseTotal,
  }
  return db.transaction((tx) => {
    let id = invoiceId
    if (id) {
      tx.update(invoices).set(values).where(byId(ws, id)).run()
      tx.delete(invoiceLines)
        .where(and(eq(invoiceLines.workspaceId, ws), eq(invoiceLines.invoiceId, id)))
        .run()
    } else {
      id = tx
        .insert(invoices)
        .values({ ...values, source })
        .returning()
        .get().id
    }
    calc.lines.forEach((line, position) => {
      const costFxRate = effectiveRate(line.costCurrency, line.costFxRate, baseCurrency)
      tx.insert(invoiceLines)
        .values({
          workspaceId: ws,
          invoiceId: id,
          position,
          subscriptionId: line.subscriptionId,
          subscriptionLineId: line.subscriptionLineId,
          periodStart: periodFor(ws, line, input.type, id as number),
          description: line.description,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          net: line.net,
          tax: line.tax,
          total: line.total,
          costAmount: line.costAmount,
          costCurrency: line.costCurrency,
          costFxRate,
          costBase: toBase(line.costAmount, costFxRate, baseCurrency),
          originalInvoiceLineId: line.originalInvoiceLineId,
          amountConfirmed: line.amountConfirmed,
        })
        .run()
    })
    return id
  })
}

export function assertCustomer(ws: number, id: number) {
  if (
    !db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.workspaceId, ws), eq(customers.id, id)))
      .get()
  ) {
    throw new ApiError(422, 'Choose a customer that exists')
  }
}

/** Ids that are all in this workspace. */
function idsIn(ws: number, table: 'providers' | 'services' | 'subscriptions', ids: number[]) {
  const wanted = [...new Set(ids)]
  if (!wanted.length) return true
  const t = { providers, services, subscriptions }[table]
  const found = db
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.workspaceId, ws), inArray(t.id, wanted)))
    .all()
  return found.length === wanted.length
}

/** Lines of subscriptions and provider invoices that are all in this workspace. */
function lineIdsIn(
  ws: number,
  table: 'subscriptionLines' | 'originalInvoiceLines',
  ids: (number | null | undefined)[],
) {
  const wanted = [...new Set(ids.filter((id): id is number => id != null))]
  if (!wanted.length) return true
  const t = { subscriptionLines, originalInvoiceLines }[table]
  const found = db
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.workspaceId, ws), inArray(t.id, wanted)))
    .all()
  return found.length === wanted.length
}

/** Every row the body names must be in this workspace. The template is checked by `getTemplate`. */
function assertReferences(ws: number, input: InvoiceInput) {
  const problem = (message: string) => new ApiError(422, message)
  if (input.providerId && !idsIn(ws, 'providers', [input.providerId])) {
    throw problem('Choose a provider that exists')
  }
  if (input.serviceId && !idsIn(ws, 'services', [input.serviceId])) {
    throw problem('Choose a service that exists')
  }
  const subscriptionIds = input.lines.flatMap((line) =>
    line.subscriptionId ? [line.subscriptionId] : [],
  )
  if (!idsIn(ws, 'subscriptions', subscriptionIds)) {
    throw problem('Choose a subscription that exists')
  }
  if (
    !lineIdsIn(
      ws,
      'subscriptionLines',
      input.lines.map((line) => line.subscriptionLineId),
    )
  ) {
    throw problem('Choose a subscription line that exists')
  }
  assertOriginalLines(
    ws,
    input.lines.map((line) => line.originalInvoiceLineId),
  )
}

function assertOriginalLines(ws: number, ids: (number | null | undefined)[]) {
  if (!lineIdsIn(ws, 'originalInvoiceLines', ids)) {
    throw new ApiError(422, 'Choose a provider invoice line that exists')
  }
}

export function createDraft(
  ws: number,
  input: InvoiceInput,
  source: 'manual' | 'renewal' = 'manual',
) {
  assertCustomer(ws, input.customerId)
  return getInvoice(ws, persistDraft(ws, null, input, source))
}

function assertDraft(invoice: Invoice) {
  if (invoice.status !== 'draft') {
    throw new ApiError(409, 'Only drafts can be changed. Void this document and issue a new one.')
  }
}

export function updateDraft(ws: number, id: number, input: InvoiceInput) {
  const invoice = getInvoice(ws, id)
  assertDraft(invoice)
  assertCustomer(ws, input.customerId)
  persistDraft(ws, id, { ...input, type: invoice.type }, invoice.source)
  return getInvoice(ws, id)
}

export function deleteDraft(ws: number, id: number) {
  const invoice = getInvoice(ws, id)
  assertDraft(invoice)
  if (invoice.source === 'renewal') {
    throw new ApiError(409, 'Discard renewal drafts instead, so they are not recreated.')
  }
  db.delete(invoices).where(byId(ws, id)).run()
}

function documentTitle(invoice: Invoice) {
  if (invoice.type === 'proforma') return 'Proforma Invoice'
  return invoice.taxEnabled ? 'Tax Invoice' : 'Invoice'
}

function customerLines(customer: typeof Schema.customers.$inferSelect) {
  const lines = [customer.company || customer.name]
  if (customer.company && customer.name !== customer.company) lines.push(customer.name)
  lines.push(...customer.address.split(/\r?\n/).filter(Boolean))
  if (customer.taxNumber) lines.push(`Tax number: ${customer.taxNumber}`)
  return lines
}

/** Builds the text printed on the document. Cost and provider data never enter this object. */
export function buildPayload(
  ws: number,
  invoice: Invoice,
  lines: Line[],
  seller: {
    companyName: string
    companyAddress: string
    taxNumber: string
    bankDetails: string
    customFields: CustomField[]
  },
  number: string,
  issuedOn: string | null,
): RenderPayload {
  const customer = db
    .select()
    .from(customers)
    .where(and(eq(customers.workspaceId, ws), eq(customers.id, invoice.customerId)))
    .get()
  if (!customer) throw notFound('Customer')
  const rate = percentText(invoice.taxRate)
  const { currency } = invoice
  const { discount, tax, total } = discountedTotals(invoice)
  const meta = [
    { label: 'Number', value: number },
    { label: 'Date', value: issuedOn ?? 'Not issued yet' },
  ]
  if (invoice.type === 'invoice' && invoice.dueOn) {
    meta.push({ label: 'Due date', value: invoice.dueOn })
  }
  if (invoice.type === 'proforma' && invoice.validUntil) {
    meta.push({ label: 'Valid until', value: invoice.validUntil })
  }
  return {
    title: documentTitle(invoice),
    meta,
    customerLines: customerLines(customer),
    lines: lines.map((line) => ({
      description: line.description,
      quantity: amountInput(line.quantity),
      unitPrice: formatUnitPrice(line.unitPrice, currency),
      taxRate: invoice.taxEnabled ? `${rate}%` : '',
      taxAmount: formatAmount(line.tax, currency),
      total: formatAmount(line.total, currency),
    })),
    totals: [
      { label: 'Subtotal', value: formatMoney(invoice.subtotal, currency) },
      ...(discount > 0
        ? [{ label: 'Discount', value: `-${formatMoney(discount, currency)}` }]
        : []),
      ...(invoice.taxEnabled
        ? [{ label: `Tax (${rate}%)`, value: formatMoney(tax, currency) }]
        : []),
      { label: 'Total', value: formatMoney(total, currency), strong: true },
    ],
    taxEnabled: invoice.taxEnabled,
    taxLines: [`Tax number: ${seller.taxNumber}`, `Tax rate: ${rate}%`],
    company: {
      name: seller.companyName,
      address: seller.companyAddress,
      taxNumber: seller.taxNumber,
    },
    notes: [invoice.notes, seller.bankDetails].filter(Boolean).join('\n\n'),
    customItems: customItemsFor(seller.customFields, invoice.customValues),
  }
}

async function renderFor(
  ws: number,
  invoice: Invoice,
  template: ReturnType<typeof getTemplate>,
  number: string,
  issuedOn: string | null,
) {
  return renderWithTemplate(
    ws,
    template,
    buildPayload(ws, invoice, getLines(ws, invoice.id), template, number, issuedOn),
  )
}

export function previewPdf(ws: number, id: number) {
  const invoice = getInvoice(ws, id)
  if (invoice.pdfFile) return readFile(invoice.pdfFile)
  return renderFor(
    ws,
    invoice,
    getTemplate(ws, invoice.templateId),
    invoice.number ?? 'DRAFT',
    invoice.issueDate,
  )
}

/** One real company has one number series, however many layouts it uses. */
export function issuerKeyFor(template: { id: number; taxNumber: string; companyName: string }) {
  const tax = template.taxNumber.trim().toLowerCase()
  if (tax) return `tax:${tax}`
  const name = template.companyName.trim().toLowerCase()
  // A PDF can print the company itself. Blank templates must not all share one series.
  return name ? `name:${name}` : `template:${template.id}`
}

function numberRows(ws: number, issuerKey: string, type: Invoice['type'], number: string) {
  return db
    .select({ status: invoices.status })
    .from(invoices)
    .where(
      and(
        eq(invoices.workspaceId, ws),
        eq(invoices.issuerKey, issuerKey),
        eq(invoices.type, type),
        eq(invoices.number, number),
      ),
    )
    .all()
}

/** A number on a voided document can be typed again, so a mistake can be reissued. */
function assertNumberFree(ws: number, issuerKey: string, type: Invoice['type'], number: string) {
  if (numberRows(ws, issuerKey, type, number).some((row) => row.status !== 'void')) {
    throw new ApiError(409, `Number ${number} is already used. Enter a different number.`)
  }
}

function formatNumber(ws: number, type: Invoice['type'], value: number) {
  const { invoicePrefix, proformaPrefix } = getSettings(ws)
  const prefix = type === 'proforma' ? proformaPrefix : invoicePrefix
  return `${prefix}${String(value).padStart(4, '0')}`
}

/** Skips anything already taken, so automatic numbers are never reused, even from void. */
function nextAutoNumber(ws: number, issuerKey: string, type: Invoice['type']) {
  const row = db
    .select()
    .from(numberSequences)
    .where(
      and(
        eq(numberSequences.workspaceId, ws),
        eq(numberSequences.issuerKey, issuerKey),
        eq(numberSequences.type, type),
      ),
    )
    .get()
  let value = row?.nextValue ?? 1
  while (numberRows(ws, issuerKey, type, formatNumber(ws, type, value)).length > 0) value += 1
  return { value, number: formatNumber(ws, type, value) }
}

export function advanceRenewal(ws: number, subscriptionId: number, periodStart: string) {
  const scoped = and(eq(subscriptions.workspaceId, ws), eq(subscriptions.id, subscriptionId))
  const subscription = db.select().from(subscriptions).where(scoped).get()
  if (!subscription || subscription.nextRenewalOn !== periodStart) return
  db.update(subscriptions)
    .set({ nextRenewalOn: nextRenewal(periodStart, subscription.cycle, subscription.startedOn) })
    .where(scoped)
    .run()
}

function validateForIssue(ws: number, invoice: Invoice, lines: Line[]) {
  const template = getTemplate(ws, invoice.templateId)
  const problems = templateProblems(template, getRegions(ws, template.id), {
    tax: invoice.taxEnabled,
  })
  if (invoice.fxRate <= 0) problems.push(`Enter the exchange rate for ${invoice.currency}`)
  if (lines.length === 0) problems.push('Add at least one line')
  if (lines.some((line) => !line.amountConfirmed)) {
    problems.push('Confirm the amount on metered lines')
  }
  if (lines.some((line) => line.costFxRate <= 0)) {
    problems.push('Enter the exchange rate for line costs')
  }
  for (const field of [...template.customFields].sort((a, b) => a.order - b.order)) {
    const problem = customValueProblem(field, invoice.customValues[field.id])
    if (problem) problems.push(problem)
  }
  if (problems.length) throw new ApiError(422, problems.join('. '))
  return template
}

export function issueInvoice(ws: number, id: number) {
  return issueLock(async () => {
    const invoice = getInvoice(ws, id)
    assertDraft(invoice)
    const lines = getLines(ws, id)
    const template = validateForIssue(ws, invoice, lines)
    const issuerKey = issuerKeyFor(template)
    const printedRegions = new Set<string>(getRegions(ws, template.id).map((region) => region.key))
    if (invoice.number) assertNumberFree(ws, issuerKey, invoice.type, invoice.number)
    const auto = invoice.number ? null : nextAutoNumber(ws, issuerKey, invoice.type)
    const number = invoice.number ?? (auto as { number: string }).number
    const issuedOn = invoice.issueDate ?? todayISO()
    // The template read here also fills the snapshot, so the record matches the stored PDF.
    const bytes = await renderFor(ws, invoice, template, number, issuedOn)
    const pdfFile = await saveFile('invoices', bytes, 'pdf')
    try {
      db.transaction((tx) => {
        if (auto) {
          tx.insert(numberSequences)
            .values({ workspaceId: ws, issuerKey, type: invoice.type, nextValue: auto.value + 1 })
            .onConflictDoUpdate({
              target: [
                numberSequences.workspaceId,
                numberSequences.issuerKey,
                numberSequences.type,
              ],
              set: { nextValue: auto.value + 1 },
            })
            .run()
        }
        tx.update(invoices)
          .set({
            status: 'issued',
            number,
            issuerKey,
            issuedOn,
            pdfFile,
            sellerSnapshot: {
              companyName: template.companyName,
              companyAddress: template.companyAddress,
              taxNumber: template.taxNumber,
              bankDetails: template.bankDetails,
            },
            customSnapshot: customItemsFor(template.customFields, invoice.customValues).filter(
              (item) => printedRegions.has(item.region),
            ),
          })
          .where(byId(ws, id))
          .run()
        if (invoice.type === 'invoice') {
          tx.update(customers)
            .set({ status: 'active' })
            .where(
              and(
                eq(customers.workspaceId, ws),
                eq(customers.id, invoice.customerId),
                eq(customers.status, 'lead'),
              ),
            )
            .run()
          for (const line of lines) {
            if (line.subscriptionId && line.periodStart) {
              advanceRenewal(ws, line.subscriptionId, line.periodStart)
            }
          }
        }
      })
    } catch (error) {
      await removeFile(pdfFile)
      throw error
    }
    return getInvoice(ws, id)
  })
}

export function voidInvoice(ws: number, id: number) {
  const invoice = getInvoice(ws, id)
  if (invoice.status === 'void' || invoice.status === 'converted') {
    throw new ApiError(409, 'This document cannot be voided')
  }
  if (invoice.status === 'draft' && invoice.source !== 'renewal') {
    throw new ApiError(409, 'Delete a draft instead of voiding it')
  }
  sqlite.transaction(() => {
    db.update(invoices).set({ status: 'void' }).where(byId(ws, id)).run()
    if (invoice.status === 'draft') {
      for (const line of getLines(ws, id)) {
        if (line.subscriptionId && line.periodStart) {
          advanceRenewal(ws, line.subscriptionId, line.periodStart)
        }
      }
    }
  })()
  return getInvoice(ws, id)
}

/**
 * A discount prints, so the stored PDF follows it. Everything else is what was printed at issue,
 * except the customer and the layout, which have no stored copy.
 */
export function rebuildPdfForDiscount(ws: number, id: number, previousDiscount: number) {
  return issueLock(async () => {
    const invoice = getInvoice(ws, id)
    if (invoice.discountAmount === previousDiscount || !invoice.pdfFile) return
    if (invoice.status !== 'issued' && invoice.status !== 'paid') return
    const template = getTemplate(ws, invoice.templateId)
    const seller = { ...(invoice.sellerSnapshot ?? template), customFields: template.customFields }
    let pdfFile: string
    try {
      const payload = buildPayload(
        ws,
        invoice,
        getLines(ws, id),
        seller,
        invoice.number as string,
        invoice.issuedOn,
      )
      pdfFile = await saveFile(
        'invoices',
        await renderWithTemplate(ws, template, {
          ...payload,
          customItems: invoice.customSnapshot ?? payload.customItems,
        }),
        'pdf',
      )
    } catch (error) {
      console.error('Could not rebuild a PDF', error)
      throw new ApiError(
        409,
        'The discount changed, but the PDF was not updated. Remove the discount and add it again.',
      )
    }
    db.update(invoices).set({ pdfFile }).where(byId(ws, id)).run()
    try {
      await removeFile(invoice.pdfFile)
    } catch (error) {
      console.error('A replaced PDF stayed in storage', error)
    }
  })
}

/**
 * Sends an issued document back to draft for correction. The number stays, as if typed, so it
 * reissues under the same number. Clearing `issuerKey` stops the draft counting as its holder.
 */
export async function reverseInvoice(ws: number, id: number) {
  const invoice = getInvoice(ws, id)
  if (invoice.status === 'paid') {
    throw new ApiError(409, 'This invoice is paid. Remove its payments before reversing it.')
  }
  if (invoice.status !== 'issued') {
    throw new ApiError(409, 'Only issued documents can be reversed')
  }
  db.transaction((tx) => {
    const payment = tx
      .select({ id: invoicePayments.id })
      .from(invoicePayments)
      .where(and(eq(invoicePayments.workspaceId, ws), eq(invoicePayments.invoiceId, id)))
      .get()
    if (payment) {
      throw new ApiError(409, 'This invoice has payments. Remove them before reversing it.')
    }
    tx.update(invoices)
      .set({
        status: 'draft',
        issueDate: invoice.issuedOn,
        issuedOn: null,
        issuerKey: null,
        pdfFile: null,
        sellerSnapshot: null,
        customSnapshot: null,
      })
      .where(byId(ws, id))
      .run()
  })
  // After the commit, so a failure here cannot leave an issued document with no PDF.
  try {
    await removeFile(invoice.pdfFile)
  } catch (error) {
    console.error('A reversed document kept its stored PDF', error)
  }
  return getInvoice(ws, id)
}

export function markPaid(ws: number, id: number, paidOn: string) {
  const invoice = getInvoice(ws, id)
  if (invoice.type !== 'invoice' || invoice.status !== 'issued') {
    throw new ApiError(409, 'Only issued invoices can be marked as paid')
  }
  const due = dueOf(invoice)
  if (due > 0) return addPayment(ws, id, { kind: 'payment', amount: due, paidOn, note: '' })
  // A total of 0 has nothing to record, so no row exists for settleInvoice to work from.
  db.update(invoices).set({ status: 'paid', paidOn }).where(byId(ws, id)).run()
  return getInvoice(ws, id)
}

export function markUnpaid(ws: number, id: number) {
  const invoice = getInvoice(ws, id)
  if (invoice.status !== 'paid') throw new ApiError(409, 'This invoice is not paid')
  const last = lastEnteredPayment(ws, id)
  if (last) removePayment(ws, last.id)
  else db.transaction((tx) => settleInvoice(tx, ws, id))
  return getInvoice(ws, id)
}

/** Cost is internal, so it stays editable after issue. */
export function updateLineCost(
  ws: number,
  invoiceId: number,
  lineId: number,
  input: {
    costAmount: number
    costCurrency: string
    costFxRate: number
    originalInvoiceLineId: number | null
  },
) {
  getInvoice(ws, invoiceId)
  const line = getLines(ws, invoiceId).find((row) => row.id === lineId)
  if (!line) throw notFound('Invoice line')
  assertOriginalLines(ws, [input.originalInvoiceLineId])
  const { baseCurrency } = getSettings(ws)
  const costFxRate = effectiveRate(input.costCurrency, input.costFxRate, baseCurrency)
  db.update(invoiceLines)
    .set({
      costAmount: input.costAmount,
      costCurrency: input.costCurrency,
      costFxRate,
      costBase: toBase(input.costAmount, costFxRate, baseCurrency),
      originalInvoiceLineId: input.originalInvoiceLineId,
    })
    .where(and(eq(invoiceLines.workspaceId, ws), eq(invoiceLines.id, lineId)))
    .run()
  return getLines(ws, invoiceId)
}

/**
 * A new draft with the same content. What only belongs to the source stays behind: its number,
 * date, payments and PDF. Periods are claimed afresh, so a period is never billed twice.
 */
function copyToDraft(ws: number, source: Invoice, changes: Partial<Invoice>) {
  const lines = getLines(ws, source.id)
  return db.transaction((tx) => {
    const { id: _id, createdAt: _c, updatedAt: _u, ...fields } = source
    const draft = tx
      .insert(invoices)
      .values({
        ...fields,
        workspaceId: ws,
        status: 'draft',
        number: null,
        issuerKey: null,
        issueDate: null,
        issuedOn: null,
        pdfFile: null,
        paidOn: null,
        paidAmount: 0,
        discountAmount: 0,
        revenueAdjustBase: 0,
        sellerSnapshot: null,
        customSnapshot: null,
        convertedFromId: null,
        ...changes,
      })
      .returning()
      .get()
    for (const { id: _lineId, invoiceId: _inv, ...line } of lines) {
      const periodStart = periodFor(ws, { ...line, periodStart: null }, draft.type, draft.id)
      tx.insert(invoiceLines)
        .values({ ...line, workspaceId: ws, invoiceId: draft.id, periodStart })
        .run()
    }
    return draft
  })
}

export function convertProforma(ws: number, id: number) {
  const proforma = getInvoice(ws, id)
  if (proforma.type !== 'proforma' || proforma.status !== 'issued') {
    throw new ApiError(409, 'Only issued proformas can be converted')
  }
  return db.transaction(() => {
    const draft = copyToDraft(ws, proforma, {
      type: 'invoice',
      validUntil: null,
      convertedFromId: proforma.id,
    })
    db.update(invoices).set({ status: 'converted' }).where(byId(ws, id)).run()
    return draft
  })
}

/** A copy is the owner's own work, so a renewal's copy is not a renewal draft. */
export function duplicateInvoice(ws: number, id: number) {
  return copyToDraft(ws, getInvoice(ws, id), { source: 'manual' })
}

export function listInvoices(
  ws: number,
  filter: { type?: string; status?: string; customerId?: number },
) {
  const conditions = [
    eq(invoices.workspaceId, ws),
    filter.type === 'invoice' || filter.type === 'proforma'
      ? eq(invoices.type, filter.type)
      : undefined,
    filter.customerId ? eq(invoices.customerId, filter.customerId) : undefined,
    filter.status
      ? inArray(invoices.status, filter.status.split(',') as Invoice['status'][])
      : undefined,
  ]
  return db
    .select({
      invoice: invoices,
      customerName: customers.name,
      customerCompany: customers.company,
      providerName: providers.name,
    })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .leftJoin(providers, eq(providers.id, invoices.providerId))
    .where(and(...conditions))
    .orderBy(desc(invoices.id))
    .all()
    .map(({ invoice, ...rest }) => ({ ...invoice, ...rest }))
}

/** The base currency locks once this workspace has data. Other workspaces do not count. */
export const hasFinancialData = (ws: number) =>
  Boolean(
    db.select({ id: invoices.id }).from(invoices).where(eq(invoices.workspaceId, ws)).get() ||
      db
        .select({ id: originalInvoices.id })
        .from(originalInvoices)
        .where(eq(originalInvoices.workspaceId, ws))
        .get(),
  )

export function originalLineOptions(ws: number) {
  return db
    .select({
      id: originalInvoiceLines.id,
      description: originalInvoiceLines.description,
      total: originalInvoiceLines.total,
      currency: originalInvoices.currency,
      number: originalInvoices.number,
      issuedOn: originalInvoices.issuedOn,
      providerName: providers.name,
    })
    .from(originalInvoiceLines)
    .innerJoin(originalInvoices, eq(originalInvoices.id, originalInvoiceLines.originalInvoiceId))
    .innerJoin(providers, eq(providers.id, originalInvoices.providerId))
    .where(
      and(
        eq(originalInvoiceLines.workspaceId, ws),
        eq(originalInvoices.workspaceId, ws),
        eq(providers.workspaceId, ws),
      ),
    )
    .orderBy(desc(originalInvoices.issuedOn))
    .limit(200)
    .all()
}
