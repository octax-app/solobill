import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import type { z } from 'zod'
import { todayISO } from '../../shared/dates.ts'
import { currencyDecimals, formatMoney, roundToCurrency } from '../../shared/money.ts'
import {
  allocatePayment,
  discountLimit,
  discountWithTax,
  dueOf,
  revenueAdjustment,
} from '../../shared/payments.ts'
import type { customerPaymentInput, paymentInput } from '../../shared/schemas.ts'
import { db, type schema as Schema, schema } from '../db/index.ts'
import { ApiError, notFound } from '../errors.ts'
import { getSettings } from './settings.ts'

const { customers, invoicePayments, invoices } = schema

type Invoice = typeof Schema.invoices.$inferSelect
type Payment = typeof Schema.invoicePayments.$inferSelect
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * The only writer of the stored payment figures, and of status and `paidOn` once a row exists.
 * An invoice with no rows is never settled here, or a total of 0 would mark itself paid.
 */
export function settleInvoice(tx: Transaction, ws: number, invoiceId: number) {
  const invoice = tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.workspaceId, ws), eq(invoices.id, invoiceId)))
    .get()
  if (invoice?.status !== 'issued' && invoice?.status !== 'paid') return
  const rows = tx
    .select()
    .from(invoicePayments)
    .where(and(eq(invoicePayments.workspaceId, ws), eq(invoicePayments.invoiceId, invoiceId)))
    .all()
  const totalOf = (kind: 'payment' | 'discount') =>
    rows.filter((row) => row.kind === kind).reduce((sum, row) => sum + row.amount, 0)
  const balance = {
    ...invoice,
    paidAmount: totalOf('payment'),
    discountAmount: totalOf('discount'),
  }
  const settled = rows.length > 0 && dueOf(balance) === 0
  tx.update(invoices)
    .set({
      paidAmount: balance.paidAmount,
      discountAmount: balance.discountAmount,
      revenueAdjustBase: revenueAdjustment(balance, getSettings(ws).baseCurrency),
      status: settled ? 'paid' : 'issued',
      paidOn: settled
        ? rows
            .map((row) => row.paidOn)
            .sort()
            .at(-1)
        : null,
    })
    .where(and(eq(invoices.workspaceId, ws), eq(invoices.id, invoiceId)))
    .run()
}

function assertFitsCurrency(amount: number, currency: string) {
  if (amount !== roundToCurrency(amount, currency)) {
    const decimals = currencyDecimals(currency)
    throw new ApiError(422, `${currency} amounts can have at most ${decimals} decimal places`)
  }
}

function assertTakesPayments(invoice: Invoice) {
  if (invoice.type !== 'invoice') throw new ApiError(409, 'Proformas cannot take payments.')
  if (invoice.status === 'paid') {
    throw new ApiError(409, 'This invoice is already paid. Remove a payment to change it.')
  }
  if (invoice.status === 'draft') {
    throw new ApiError(409, 'Issue this invoice before adding a payment.')
  }
  if (invoice.status !== 'issued') throw new ApiError(409, 'Voided invoices cannot take payments.')
}

export function addPayment(ws: number, invoiceId: number, input: z.output<typeof paymentInput>) {
  return db.transaction((tx) => {
    const invoice = tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.workspaceId, ws), eq(invoices.id, invoiceId)))
      .get()
    if (!invoice) throw notFound('Invoice')
    assertTakesPayments(invoice)
    assertFitsCurrency(input.amount, invoice.currency)
    const discounting = input.kind === 'discount'
    const amount = discounting ? discountWithTax(input.amount, invoice) : input.amount
    if (discounting && amount > dueOf(invoice)) {
      const allowed = formatMoney(discountLimit(invoice), invoice.currency)
      const basis = invoice.taxEnabled ? ' before tax' : ''
      throw new ApiError(422, `The discount cannot be more than ${allowed}${basis}`)
    }
    tx.insert(invoicePayments)
      .values({
        workspaceId: ws,
        invoiceId,
        kind: input.kind,
        amount,
        paidOn: input.paidOn ?? todayISO(),
        note: input.note,
      })
      .run()
    settleInvoice(tx, ws, invoiceId)
    return tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.workspaceId, ws), eq(invoices.id, invoiceId)))
      .get() as Invoice
  })
}

/** One amount spread over the customer's open invoices, stored as one group of rows. */
export function addCustomerPayment(
  ws: number,
  customerId: number,
  input: z.output<typeof customerPaymentInput>,
) {
  const customer = db
    .select()
    .from(customers)
    .where(and(eq(customers.workspaceId, ws), eq(customers.id, customerId)))
    .get()
  if (!customer) throw notFound('Customer')
  assertFitsCurrency(input.amount, input.currency)
  return db.transaction((tx) => {
    const issued = tx
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.workspaceId, ws),
          eq(invoices.customerId, customerId),
          eq(invoices.type, 'invoice'),
          eq(invoices.status, 'issued'),
          eq(invoices.currency, input.currency),
        ),
      )
      .all()
    const { allocations, excess } = allocatePayment(
      input.amount,
      issued.map((invoice) => ({ ...invoice, due: dueOf(invoice) })),
    )
    if (allocations.length === 0) {
      throw new ApiError(422, `No open ${input.currency} invoices for this customer`)
    }
    const groupId = randomUUID()
    const paidOn = input.paidOn ?? todayISO()
    for (const { invoiceId, amount } of allocations) {
      tx.insert(invoicePayments)
        .values({
          workspaceId: ws,
          invoiceId,
          kind: 'payment',
          amount,
          paidOn,
          note: input.note,
          groupId,
        })
        .run()
      settleInvoice(tx, ws, invoiceId)
    }
    const numberOf = new Map(issued.map((invoice) => [invoice.id, invoice.number ?? '']))
    return {
      allocations: allocations.map((row) => ({
        ...row,
        number: numberOf.get(row.invoiceId) ?? '',
      })),
      excess,
    }
  })
}

function deleteRows(tx: Transaction, ws: number, rows: Payment[]) {
  const invoiceIds = [...new Set(rows.map((item) => item.invoiceId))]
  const affected = tx
    .select({ status: invoices.status, number: invoices.number })
    .from(invoices)
    .where(and(eq(invoices.workspaceId, ws), inArray(invoices.id, invoiceIds)))
    .all()
  const locked = affected.find(({ status }) => status === 'void' || status === 'converted')
  if (locked) {
    throw new ApiError(409, `${locked.number} is ${locked.status}, so this cannot be removed.`)
  }
  tx.delete(invoicePayments)
    .where(
      and(
        eq(invoicePayments.workspaceId, ws),
        inArray(
          invoicePayments.id,
          rows.map((item) => item.id),
        ),
      ),
    )
    .run()
  for (const invoiceId of invoiceIds) settleInvoice(tx, ws, invoiceId)
}

/** A customer payment was one payment, so removing any of its rows removes them all. */
export function removePayment(ws: number, id: number) {
  db.transaction((tx) => {
    const row = tx
      .select()
      .from(invoicePayments)
      .where(and(eq(invoicePayments.workspaceId, ws), eq(invoicePayments.id, id)))
      .get()
    if (!row) throw notFound('Payment')
    const rows = row.groupId
      ? tx
          .select()
          .from(invoicePayments)
          .where(and(eq(invoicePayments.workspaceId, ws), eq(invoicePayments.groupId, row.groupId)))
          .all()
      : [row]
    deleteRows(tx, ws, rows)
  })
}

/**
 * Undoes a paid invoice, usually one marked as paid by mistake. Every row goes, including whole
 * customer payments among them. A partly paid invoice removes single rows with `removePayment`.
 */
export function undoPayments(ws: number, invoiceId: number) {
  return db.transaction((tx) => {
    const invoice = tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.workspaceId, ws), eq(invoices.id, invoiceId)))
      .get()
    if (!invoice) throw notFound('Invoice')
    if (invoice.status !== 'paid') throw new ApiError(409, 'This invoice is not paid')
    const own = tx
      .select()
      .from(invoicePayments)
      .where(and(eq(invoicePayments.workspaceId, ws), eq(invoicePayments.invoiceId, invoiceId)))
      .all()
    if (own.length === 0) {
      // A total of 0 was marked paid with no row to remove.
      settleInvoice(tx, ws, invoiceId)
    } else {
      const groupIds = own.flatMap((row) => (row.groupId ? [row.groupId] : []))
      const grouped = tx
        .select()
        .from(invoicePayments)
        .where(and(eq(invoicePayments.workspaceId, ws), inArray(invoicePayments.groupId, groupIds)))
        .all()
      const ids = new Set(own.map((row) => row.id))
      deleteRows(tx, ws, [...own, ...grouped.filter((row) => !ids.has(row.id))])
    }
    return tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.workspaceId, ws), eq(invoices.id, invoiceId)))
      .get() as Invoice
  })
}

export function getPayment(ws: number, id: number) {
  const row = db
    .select()
    .from(invoicePayments)
    .where(and(eq(invoicePayments.workspaceId, ws), eq(invoicePayments.id, id)))
    .get()
  if (!row) throw notFound('Payment')
  return row
}

export function listPayments(ws: number, invoiceId: number) {
  return db
    .select()
    .from(invoicePayments)
    .where(and(eq(invoicePayments.workspaceId, ws), eq(invoicePayments.invoiceId, invoiceId)))
    .orderBy(asc(invoicePayments.paidOn), asc(invoicePayments.id))
    .all()
}

/** The last row entered, whatever date it carries. That row is the one that settled the invoice. */
export function lastEnteredPayment(ws: number, invoiceId: number) {
  return db
    .select()
    .from(invoicePayments)
    .where(and(eq(invoicePayments.workspaceId, ws), eq(invoicePayments.invoiceId, invoiceId)))
    .orderBy(desc(invoicePayments.id))
    .get()
}
