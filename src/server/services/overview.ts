import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, sql, sum } from 'drizzle-orm'
import { addDays, todayISO } from '../../shared/dates.ts'
import { toBase } from '../../shared/money.ts'
import { dueOf } from '../../shared/payments.ts'
import { db, schema } from '../db/index.ts'
import { notFound } from '../errors.ts'
import { draftsAwaitingReview } from './renewals.ts'
import { getSettings } from './settings.ts'

const {
  customers,
  invoiceLines,
  invoices,
  originalInvoiceLines,
  originalInvoices,
  providers,
  services,
  subscriptions,
} = schema

const REVENUE_STATUSES = ['issued', 'paid'] as ('issued' | 'paid')[]
const isRevenue = and(eq(invoices.type, 'invoice'), inArray(invoices.status, REVENUE_STATUSES))
const num = (value: string | number | null | undefined) => Number(value ?? 0)

function inPeriod(from: string, to: string) {
  return and(gte(invoices.issuedOn, from), lte(invoices.issuedOn, to))
}

function revenueIn(ws: number, from: string, to: string, customerId?: number) {
  const where = and(
    eq(invoices.workspaceId, ws),
    isRevenue,
    inPeriod(from, to),
    customerId ? eq(invoices.customerId, customerId) : undefined,
  )
  const revenue = db
    .select({ value: sql<number>`sum(${invoices.baseSubtotal} + ${invoices.revenueAdjustBase})` })
    .from(invoices)
    .where(where)
    .get()
  const cost = db
    .select({ value: sum(invoiceLines.costBase) })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .where(and(eq(invoiceLines.workspaceId, ws), where))
    .get()
  return { revenue: num(revenue?.value), cost: num(cost?.value) }
}

function summarise(revenue: number, cost: number) {
  const profit = revenue - cost
  return { revenue, cost, profit, margin: revenue ? Math.round((profit / revenue) * 1000) / 10 : 0 }
}

export function receivables(ws: number) {
  const { baseCurrency } = getSettings(ws)
  return db
    .select({
      id: invoices.id,
      number: invoices.number,
      dueOn: invoices.dueOn,
      issuedOn: invoices.issuedOn,
      total: invoices.total,
      baseTotal: invoices.baseTotal,
      currency: invoices.currency,
      customerId: customers.id,
      customerName: customers.name,
      fxRate: invoices.fxRate,
      paidAmount: invoices.paidAmount,
      discountAmount: invoices.discountAmount,
    })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(
      and(
        eq(invoices.workspaceId, ws),
        eq(customers.workspaceId, ws),
        eq(invoices.type, 'invoice'),
        eq(invoices.status, 'issued'),
      ),
    )
    .orderBy(sql`${invoices.dueOn} is null`, asc(invoices.dueOn))
    .all()
    .map(({ fxRate, paidAmount, discountAmount, ...row }) => {
      const due = dueOf({ total: row.total, paidAmount, discountAmount })
      return { ...row, due, baseDue: toBase(due, fxRate, baseCurrency) }
    })
}

export function payables(ws: number) {
  return db
    .select({
      id: originalInvoices.id,
      number: originalInvoices.number,
      dueOn: originalInvoices.dueOn,
      issuedOn: originalInvoices.issuedOn,
      total: originalInvoices.total,
      baseTotal: originalInvoices.baseTotal,
      currency: originalInvoices.currency,
      providerId: providers.id,
      providerName: providers.name,
      providerLogo: providers.logoFile,
    })
    .from(originalInvoices)
    .innerJoin(providers, eq(providers.id, originalInvoices.providerId))
    .where(
      and(
        eq(originalInvoices.workspaceId, ws),
        eq(providers.workspaceId, ws),
        isNull(originalInvoices.paidOn),
      ),
    )
    .orderBy(sql`${originalInvoices.dueOn} is null`, asc(originalInvoices.dueOn))
    .all()
}

export function upcomingRenewals(ws: number, today: string, days = 30) {
  return db
    .select({
      id: subscriptions.id,
      label: subscriptions.label,
      nextRenewalOn: subscriptions.nextRenewalOn,
      priceAmount: subscriptions.priceAmount,
      priceCurrency: subscriptions.priceCurrency,
      customerId: customers.id,
      customerName: customers.name,
      serviceName: services.name,
    })
    .from(subscriptions)
    .innerJoin(customers, eq(customers.id, subscriptions.customerId))
    .innerJoin(services, eq(services.id, subscriptions.serviceId))
    .where(
      and(
        eq(subscriptions.workspaceId, ws),
        eq(customers.workspaceId, ws),
        eq(services.workspaceId, ws),
        eq(subscriptions.status, 'active'),
        isNotNull(subscriptions.nextRenewalOn),
        lte(subscriptions.nextRenewalOn, addDays(today, days)),
      ),
    )
    .orderBy(asc(subscriptions.nextRenewalOn))
    .all()
}

/** Provider cost not yet matched to a customer line. Shown separately, never subtracted. */
function unallocatedCost(ws: number, from: string, to: string) {
  const window = and(
    eq(originalInvoices.workspaceId, ws),
    gte(originalInvoices.issuedOn, from),
    lte(originalInvoices.issuedOn, to),
  )
  const billed = db
    .select({ value: sum(originalInvoices.baseSubtotal) })
    .from(originalInvoices)
    .where(window)
    .get()
  const linked = db
    .select({ value: sum(invoiceLines.costBase) })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .innerJoin(
      originalInvoiceLines,
      eq(originalInvoiceLines.id, invoiceLines.originalInvoiceLineId),
    )
    .innerJoin(originalInvoices, eq(originalInvoices.id, originalInvoiceLines.originalInvoiceId))
    .where(
      and(
        window,
        eq(invoiceLines.workspaceId, ws),
        eq(invoices.workspaceId, ws),
        eq(originalInvoiceLines.workspaceId, ws),
        isRevenue,
      ),
    )
    .get()
  return Math.max(0, num(billed?.value) - num(linked?.value))
}

function monthlyTrend(ws: number, today: string, months = 12) {
  const rows = []
  const [year, month] = today.split('-').map(Number)
  for (let offset = months - 1; offset >= 0; offset -= 1) {
    const start = new Date(Date.UTC(year, month - 1 - offset, 1))
    const end = new Date(Date.UTC(year, month - offset, 0))
    const from = start.toISOString().slice(0, 10)
    const to = end.toISOString().slice(0, 10)
    const { revenue, cost } = revenueIn(ws, from, to)
    rows.push({ month: from.slice(0, 7), revenue, cost, profit: revenue - cost })
  }
  return rows
}

export function overview(ws: number, from: string, to: string, today = todayISO()) {
  const { revenue, cost } = revenueIn(ws, from, to)
  const collect = receivables(ws)
  const pay = payables(ws)
  return {
    baseCurrency: getSettings(ws).baseCurrency,
    from,
    to,
    today,
    summary: summarise(revenue, cost),
    toCollect: collect,
    toCollectTotal: collect.reduce((total, row) => total + row.baseDue, 0),
    toPay: pay,
    toPayTotal: pay.reduce((total, row) => total + row.baseTotal, 0),
    renewals: upcomingRenewals(ws, today),
    trend: monthlyTrend(ws, today),
    unallocatedCost: unallocatedCost(ws, from, to),
    draftsToReview: draftsAwaitingReview(ws),
  }
}

export function customerSummary(ws: number, customerId: number) {
  const customer = db
    .select()
    .from(customers)
    .where(and(eq(customers.workspaceId, ws), eq(customers.id, customerId)))
    .get()
  if (!customer) throw notFound('Customer')
  const { revenue, cost } = revenueIn(ws, '0000-01-01', '9999-12-31', customerId)
  const pending = receivables(ws).filter((row) => row.customerId === customerId)
  const linkedOriginals = db
    .selectDistinct({
      id: originalInvoices.id,
      number: originalInvoices.number,
      issuedOn: originalInvoices.issuedOn,
      total: originalInvoices.total,
      currency: originalInvoices.currency,
      providerName: providers.name,
    })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .innerJoin(
      originalInvoiceLines,
      eq(originalInvoiceLines.id, invoiceLines.originalInvoiceLineId),
    )
    .innerJoin(originalInvoices, eq(originalInvoices.id, originalInvoiceLines.originalInvoiceId))
    .innerJoin(providers, eq(providers.id, originalInvoices.providerId))
    .where(
      and(
        eq(invoiceLines.workspaceId, ws),
        eq(invoices.workspaceId, ws),
        eq(originalInvoices.workspaceId, ws),
        eq(invoices.customerId, customerId),
      ),
    )
    .all()
  return {
    baseCurrency: getSettings(ws).baseCurrency,
    summary: summarise(revenue, cost),
    pending: pending.reduce((total, row) => total + row.baseDue, 0),
    linkedOriginals,
  }
}
