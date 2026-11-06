import { and, asc, eq, inArray, isNull, max, ne, or } from 'drizzle-orm'
import type { Cycle } from '../../shared/dates.ts'
import { renewalAfter, todayISO } from '../../shared/dates.ts'
import type { SubscriptionLineInput } from '../../shared/schemas.ts'
import { db, type schema as Schema, schema } from '../db/index.ts'
import { ApiError } from '../errors.ts'

const { invoiceLines, invoices, reminders, subscriptionLines, subscriptions } = schema

type Subscription = typeof Schema.subscriptions.$inferSelect

export function linesFor(ws: number, subscriptionId: number) {
  return db
    .select()
    .from(subscriptionLines)
    .where(
      and(
        eq(subscriptionLines.workspaceId, ws),
        eq(subscriptionLines.subscriptionId, subscriptionId),
      ),
    )
    .orderBy(asc(subscriptionLines.position))
    .all()
}

export function linesBySubscription(ws: number, ids: number[]) {
  const grouped = new Map<number, ReturnType<typeof linesFor>>()
  if (ids.length === 0) return grouped
  const rows = db
    .select()
    .from(subscriptionLines)
    .where(
      and(eq(subscriptionLines.workspaceId, ws), inArray(subscriptionLines.subscriptionId, ids)),
    )
    .orderBy(asc(subscriptionLines.position))
    .all()
  for (const row of rows) {
    grouped.set(row.subscriptionId, [...(grouped.get(row.subscriptionId) ?? []), row])
  }
  return grouped
}

export const lineDescription = (serviceName: string, label: string) =>
  label ? `${serviceName}, ${label}` : serviceName

/** Saves the lines and keeps the totals on the subscription equal to their sum. */
export function saveLines(
  ws: number,
  subscriptionId: number,
  input: SubscriptionLineInput[],
  fallbackDescription: string,
) {
  const current = linesFor(ws, subscriptionId)
  const kept = input.flatMap((line) => (line.id ? [line.id] : []))
  const known = new Set(current.map((line) => line.id))
  if (new Set(kept).size !== kept.length || kept.some((id) => !known.has(id))) {
    throw new ApiError(422, 'These lines do not belong to this subscription')
  }
  const removed = current.filter((line) => !kept.includes(line.id)).map((line) => line.id)
  if (removed.length) {
    db.delete(subscriptionLines)
      .where(and(eq(subscriptionLines.workspaceId, ws), inArray(subscriptionLines.id, removed)))
      .run()
  }
  input.forEach((line, position) => {
    const values = {
      workspaceId: ws,
      subscriptionId,
      position,
      description: line.description || fallbackDescription,
      costAmount: line.costAmount,
      priceAmount: line.priceAmount,
    }
    if (line.id) {
      db.update(subscriptionLines)
        .set(values)
        .where(and(eq(subscriptionLines.workspaceId, ws), eq(subscriptionLines.id, line.id)))
        .run()
    } else {
      db.insert(subscriptionLines).values(values).run()
    }
  })
  db.update(subscriptions)
    .set({
      costAmount: input.reduce((sum, line) => sum + line.costAmount, 0),
      priceAmount: input.reduce((sum, line) => sum + line.priceAmount, 0),
    })
    .where(and(eq(subscriptions.workspaceId, ws), eq(subscriptions.id, subscriptionId)))
    .run()
}

function hasOpenRenewalDraft(ws: number, subscriptionId: number) {
  return Boolean(
    db
      .select({ id: invoiceLines.id })
      .from(invoiceLines)
      .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
      .where(
        and(
          eq(invoiceLines.workspaceId, ws),
          eq(invoiceLines.subscriptionId, subscriptionId),
          eq(invoices.workspaceId, ws),
          eq(invoices.source, 'renewal'),
          eq(invoices.status, 'draft'),
        ),
      )
      .get(),
  )
}

function lastBilledPeriod(ws: number, subscriptionId: number) {
  return db
    .select({ period: max(invoiceLines.periodStart) })
    .from(invoiceLines)
    .where(and(eq(invoiceLines.workspaceId, ws), eq(invoiceLines.subscriptionId, subscriptionId)))
    .get()?.period
}

/**
 * Works out the renewal date on edit. A typed date wins. Otherwise a changed cycle or start
 * date moves it forward from the last billed period, and earlier periods are never billed.
 */
export function nextRenewalOnEdit(
  ws: number,
  existing: Subscription,
  input: { cycle: Cycle; startedOn: string; nextRenewalOn?: string | null },
  today = todayISO(),
) {
  const { cycle, startedOn, nextRenewalOn: typed } = input
  const changed = cycle !== existing.cycle || startedOn !== existing.startedOn
  if (changed && hasOpenRenewalDraft(ws, existing.id)) {
    throw new ApiError(
      409,
      'A renewal draft is open and uses the old dates. Issue or discard it first.',
    )
  }
  if (cycle === 'once') return null
  if (typed && typed !== existing.nextRenewalOn) return typed
  if (!changed) return typed ?? existing.nextRenewalOn
  // The first period has not been billed yet, so it still starts on the start date.
  if (existing.nextRenewalOn === existing.startedOn) return startedOn
  return renewalAfter(lastBilledPeriod(ws, existing.id) ?? startedOn, cycle, today, startedOn)
}

/**
 * Only renewal drafts that were never issued may go with the subscription, so a subscription
 * added by mistake can be removed. Issued documents, even voided ones, keep it in place.
 */
export function deleteSubscription(ws: number, id: number) {
  const references = db
    .select({ invoiceId: invoices.id, source: invoices.source, issuedOn: invoices.issuedOn })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .where(
      and(
        eq(invoiceLines.workspaceId, ws),
        eq(invoices.workspaceId, ws),
        eq(invoiceLines.subscriptionId, id),
      ),
    )
    .all()
  if (references.some((row) => row.issuedOn)) {
    throw new ApiError(409, 'This subscription has issued invoices. Cancel it instead.')
  }
  if (references.some((row) => row.source !== 'renewal')) {
    throw new ApiError(409, 'This subscription is on a draft. Remove it from that draft first.')
  }
  const draftIds = [...new Set(references.map((row) => row.invoiceId))]
  if (draftIds.length) {
    const shared = db
      .select({ id: invoiceLines.id })
      .from(invoiceLines)
      .where(
        and(
          eq(invoiceLines.workspaceId, ws),
          inArray(invoiceLines.invoiceId, draftIds),
          or(isNull(invoiceLines.subscriptionId), ne(invoiceLines.subscriptionId, id)),
        ),
      )
      .get()
    if (shared) {
      throw new ApiError(409, 'A renewal draft has other lines. Discard or edit it first.')
    }
  }
  db.transaction((tx) => {
    if (draftIds.length) {
      tx.delete(reminders)
        .where(
          and(
            eq(reminders.workspaceId, ws),
            eq(reminders.kind, 'renewal_draft'),
            inArray(reminders.refId, draftIds),
          ),
        )
        .run()
      tx.delete(invoices)
        .where(and(eq(invoices.workspaceId, ws), inArray(invoices.id, draftIds)))
        .run()
    }
    tx.delete(subscriptions)
      .where(and(eq(subscriptions.workspaceId, ws), eq(subscriptions.id, id)))
      .run()
  })
}
