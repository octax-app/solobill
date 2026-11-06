import { and, asc, desc, eq, isNull, lt, lte } from 'drizzle-orm'
import { addDays, billingPeriods, todayISO } from '../../shared/dates.ts'
import { formatMoney } from '../../shared/money.ts'
import { dueOf } from '../../shared/payments.ts'
import { db, type schema as Schema, schema } from '../db/index.ts'
import { createDraft, lastFxRate } from './invoices.ts'
import { getSettings } from './settings.ts'
import { linesFor } from './subscriptions.ts'
import { getTemplate, resolveTemplateId } from './templates.ts'

const {
  customers,
  invoiceLines,
  invoices,
  originalInvoices,
  providers,
  reminders,
  services,
  subscriptions,
  workspaces,
} = schema

function addReminder(
  ws: number,
  kind: 'renewal_draft' | 'invoice_overdue' | 'original_due',
  refId: number,
  message: string,
  link: string,
) {
  db.insert(reminders)
    .values({ workspaceId: ws, kind, refId, message, link })
    .onConflictDoNothing()
    .run()
}

type Subscription = typeof Schema.subscriptions.$inferSelect
type Service = typeof Schema.services.$inferSelect
type Customer = typeof Schema.customers.$inferSelect

function isClaimed(ws: number, subscriptionId: number, period: string) {
  return Boolean(
    db
      .select({ id: invoiceLines.id })
      .from(invoiceLines)
      .where(
        and(
          eq(invoiceLines.workspaceId, ws),
          eq(invoiceLines.subscriptionId, subscriptionId),
          eq(invoiceLines.periodStart, period),
        ),
      )
      .get(),
  )
}

/** Stops at the first period on a document, so periods are always billed in order. */
function periodsToBill(ws: number, subscription: Subscription, horizon: string) {
  if (!subscription.nextRenewalOn) return []
  const { periods } = billingPeriods(
    subscription.nextRenewalOn,
    subscription.cycle,
    horizon,
    subscription.startedOn,
  )
  const claimed = periods.findIndex((period) => isClaimed(ws, subscription.id, period))
  return claimed === -1 ? periods : periods.slice(0, claimed)
}

function lastCharge(ws: number, subscriptionLineId: number) {
  return db
    .select({ unitPrice: invoiceLines.unitPrice, costAmount: invoiceLines.costAmount })
    .from(invoiceLines)
    .where(
      and(
        eq(invoiceLines.workspaceId, ws),
        eq(invoiceLines.subscriptionLineId, subscriptionLineId),
      ),
    )
    .orderBy(desc(invoiceLines.id))
    .get()
}

/** One draft for these periods, with one invoice line per subscription line in each. */
function createBillingDraft(
  ws: number,
  subscription: Subscription,
  service: Service,
  customer: Customer,
  periods: string[],
  today: string,
) {
  const metered = service.pricing === 'metered'
  const templateId = resolveTemplateId(ws, service.id, service.providerId)
  const charges = linesFor(ws, subscription.id).map((line) => ({
    line,
    last: metered ? lastCharge(ws, line.id) : undefined,
  }))
  const costFxRate = lastFxRate(ws, subscription.costCurrency) ?? 0
  const label = subscription.label ? `, ${subscription.label}` : ''
  const draft = createDraft(
    ws,
    {
      type: 'invoice',
      number: null,
      customerId: customer.id,
      providerId: service.providerId,
      serviceId: service.id,
      templateId,
      dueOn: periods[0] > today ? periods[0] : today,
      validUntil: null,
      currency: subscription.priceCurrency,
      fxRate: lastFxRate(ws, subscription.priceCurrency) ?? 0,
      taxEnabled: false,
      taxRate: getTemplate(ws, templateId).defaultTaxRate,
      notes: '',
      lines: periods.flatMap((period) =>
        charges.map(({ line, last }) => ({
          subscriptionId: subscription.id,
          subscriptionLineId: line.id,
          periodStart: period,
          description:
            subscription.cycle === 'once' ? line.description : `${line.description} from ${period}`,
          quantity: 10_000,
          unitPrice: last?.unitPrice ?? line.priceAmount,
          costAmount: last?.costAmount ?? line.costAmount,
          costCurrency: subscription.costCurrency,
          costFxRate,
          originalInvoiceLineId: null,
          amountConfirmed: !metered,
        })),
      ),
    },
    'renewal',
  )
  addReminder(
    ws,
    'renewal_draft',
    draft.id,
    `Review the renewal draft for ${customer.name}: ${service.name}${label}`,
    `/invoices/${draft.id}`,
  )
  return draft
}

const billableSubscriptions = () =>
  db
    .select({ subscription: subscriptions, service: services, customer: customers })
    .from(subscriptions)
    .innerJoin(services, eq(services.id, subscriptions.serviceId))
    .innerJoin(customers, eq(customers.id, subscriptions.customerId))

/** All workspace ids, for the daily jobs. */
export function workspaceIds() {
  return db
    .select({ id: workspaces.id })
    .from(workspaces)
    .orderBy(asc(workspaces.id))
    .all()
    .map((row) => row.id)
}

/** Only `ws`, or every workspace. A failure in one is logged and the others still run. */
function eachWorkspace(ws: number | undefined, job: string, run: (ws: number) => number) {
  if (ws !== undefined) return run(ws)
  let total = 0
  for (const id of workspaceIds()) {
    try {
      total += run(id)
    } catch (error) {
      console.error(`${job} failed for workspace ${id}`, error)
    }
  }
  return total
}

/**
 * Creates one draft for everything a subscription owes within the lead time. It checks a
 * window, not one date, so a run missed during downtime is caught by the next one, and
 * repeat runs create nothing new. Without `ws` it runs for every workspace.
 */
export function runRenewals(ws?: number, today = todayISO()) {
  return eachWorkspace(ws, 'Renewals', (id) => renewalsFor(id, today))
}

function renewalsFor(ws: number, today: string) {
  const horizon = addDays(today, getSettings(ws).renewalLeadDays)
  const due = billableSubscriptions()
    .where(
      and(
        eq(subscriptions.workspaceId, ws),
        eq(services.workspaceId, ws),
        eq(customers.workspaceId, ws),
        eq(subscriptions.status, 'active'),
        lte(subscriptions.nextRenewalOn, horizon),
      ),
    )
    .all()

  let created = 0
  for (const { subscription, service, customer } of due) {
    const periods = periodsToBill(ws, subscription, horizon)
    if (periods.length === 0) continue
    createBillingDraft(ws, subscription, service, customer, periods, today)
    created += 1
  }
  return created
}

/** Bills a newly added subscription from its start date. Returns the draft, if one was due. */
export function billFromStart(ws: number, subscriptionId: number, today = todayISO()) {
  const row = billableSubscriptions()
    .where(
      and(
        eq(subscriptions.workspaceId, ws),
        eq(services.workspaceId, ws),
        eq(customers.workspaceId, ws),
        eq(subscriptions.id, subscriptionId),
      ),
    )
    .get()
  if (row?.subscription.status !== 'active') return null
  const { subscription, service, customer } = row
  const horizon = addDays(today, getSettings(ws).renewalLeadDays)
  const periods =
    subscription.cycle === 'once'
      ? [subscription.startedOn]
      : periodsToBill(ws, subscription, horizon)
  if (periods.length === 0) return null
  return createBillingDraft(ws, subscription, service, customer, periods, today)
}

/** Without `ws` it runs for every workspace. */
export function runReminders(ws?: number, today = todayISO()) {
  eachWorkspace(ws, 'Reminders', (id) => {
    remindersFor(id, today)
    return 0
  })
}

function remindersFor(ws: number, today: string) {
  const overdue = db
    .select({ invoice: invoices, customerName: customers.name })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(
      and(
        eq(invoices.workspaceId, ws),
        eq(customers.workspaceId, ws),
        eq(invoices.type, 'invoice'),
        eq(invoices.status, 'issued'),
        lt(invoices.dueOn, today),
      ),
    )
    .all()
  for (const { invoice, customerName } of overdue) {
    addReminder(
      ws,
      'invoice_overdue',
      invoice.id,
      `${invoice.number} for ${customerName} is overdue: ${formatMoney(dueOf(invoice), invoice.currency)}`,
      `/invoices/${invoice.id}`,
    )
  }
  const comingDue = db
    .select({ original: originalInvoices, providerName: providers.name })
    .from(originalInvoices)
    .innerJoin(providers, eq(providers.id, originalInvoices.providerId))
    .where(
      and(
        eq(originalInvoices.workspaceId, ws),
        eq(providers.workspaceId, ws),
        isNull(originalInvoices.paidOn),
        lte(originalInvoices.dueOn, addDays(today, 7)),
      ),
    )
    .all()
  for (const { original, providerName } of comingDue) {
    addReminder(
      ws,
      'original_due',
      original.id,
      `${providerName} invoice ${original.number} is due on ${original.dueOn}`,
      `/originals/${original.id}`,
    )
  }
}

export function draftsAwaitingReview(ws: number) {
  return db
    .select({ id: invoices.id })
    .from(invoices)
    .where(
      and(
        eq(invoices.workspaceId, ws),
        eq(invoices.status, 'draft'),
        eq(invoices.source, 'renewal'),
      ),
    )
    .all().length
}
