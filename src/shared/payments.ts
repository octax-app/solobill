import { netShare, taxOf, toBase } from './money.ts'

export interface InvoiceBalance {
  total: number
  paidAmount: number
  discountAmount: number
}

/** What the customer still owes. Never below zero. */
export const dueOf = (invoice: InvoiceBalance) =>
  Math.max(0, invoice.total - invoice.paidAmount - invoice.discountAmount)

/** What the customer paid beyond the total. This is profit. */
export const overpaidOf = (invoice: InvoiceBalance) =>
  Math.max(0, invoice.paidAmount + invoice.discountAmount - invoice.total)

/** `partial` is only a display label. The stored status stays `issued` until settled. */
export function paymentLabel(invoice: InvoiceBalance & { status: string }) {
  const started = invoice.paidAmount > 0 || invoice.discountAmount > 0
  return invoice.status === 'issued' && started ? 'partial' : invoice.status
}

/**
 * The change to an invoice's revenue, in the base currency. A discount only takes its net share
 * off, because profit excludes tax. An overpayment adds all of it.
 */
export function revenueAdjustment(
  invoice: InvoiceBalance & { subtotal: number; currency: string; fxRate: number },
  baseCurrency: string,
) {
  const discount = netShare(
    invoice.discountAmount,
    invoice.subtotal,
    invoice.total,
    invoice.currency,
  )
  return toBase(overpaidOf(invoice) - discount, invoice.fxRate, baseCurrency)
}

type Discountable = InvoiceBalance & {
  subtotal: number
  taxEnabled: boolean
  taxRate: number
  currency: string
}

/**
 * The figures after any discount, which comes off before tax. Stored `tax` and `total` stay as
 * issued and discounts are stored with their tax, so these always add up to what the customer owes.
 */
export function discountedTotals(
  invoice: Pick<InvoiceBalance, 'total' | 'discountAmount'> & {
    subtotal: number
    tax: number
    currency: string
  },
) {
  const { subtotal, tax, total, discountAmount, currency } = invoice
  const discount = netShare(discountAmount, subtotal, total, currency)
  return { discount, tax: tax - (discountAmount - discount), total: total - discountAmount }
}

/** The most that can be given, before tax. */
export const discountLimit = (invoice: Discountable) =>
  netShare(dueOf(invoice), invoice.subtotal, invoice.total, invoice.currency)

/**
 * A discount is entered before tax, and comes off the due with its tax. The full limit, or the
 * due itself as older iOS builds send, closes the invoice with no rounding left over.
 */
export function discountWithTax(amount: number, invoice: Discountable) {
  const due = dueOf(invoice)
  if (amount === due || amount === discountLimit(invoice)) return due
  return amount + (invoice.taxEnabled ? taxOf(amount, invoice.taxRate, invoice.currency) : 0)
}

export interface OpenInvoice {
  id: number
  issuedOn: string | null
  due: number
}

export interface PaymentSplit {
  allocations: { invoiceId: number; amount: number }[]
  /** Already included in the last allocation. */
  excess: number
}

/** Fills open invoices oldest first. Anything left stays on the last one as an overpayment. */
export function allocatePayment(amount: number, open: OpenInvoice[]): PaymentSplit {
  const oldestFirst = open
    .filter((invoice) => invoice.due > 0)
    .sort((a, b) => (a.issuedOn ?? '').localeCompare(b.issuedOn ?? '') || a.id - b.id)
  const allocations: PaymentSplit['allocations'] = []
  let left = amount
  for (const invoice of oldestFirst) {
    if (left <= 0) break
    const applied = Math.min(left, invoice.due)
    allocations.push({ invoiceId: invoice.id, amount: applied })
    left -= applied
  }
  const last = allocations.at(-1)
  if (last) last.amount += left
  return { allocations, excess: last ? left : 0 }
}
