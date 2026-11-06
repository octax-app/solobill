import { and, desc, eq } from 'drizzle-orm'
import { lineNet, toBase } from '../../shared/money.ts'
import type { OriginalInvoiceInput } from '../../shared/schemas.ts'
import { db, schema } from '../db/index.ts'
import { ApiError, notFound } from '../errors.ts'
import { removeFile } from '../storage.ts'
import { effectiveRate } from './invoices.ts'
import { getSettings } from './settings.ts'

const { invoiceLines, originalInvoiceLines, originalInvoices, providers, services } = schema

export function listOriginals(ws: number) {
  return db
    .select({ original: originalInvoices, providerName: providers.name })
    .from(originalInvoices)
    .innerJoin(providers, eq(providers.id, originalInvoices.providerId))
    .where(and(eq(originalInvoices.workspaceId, ws), eq(providers.workspaceId, ws)))
    .orderBy(desc(originalInvoices.issuedOn), desc(originalInvoices.id))
    .all()
    .map(({ original, providerName }) => ({ ...original, providerName }))
}

export function getOriginal(ws: number, id: number) {
  const row = db
    .select()
    .from(originalInvoices)
    .where(and(eq(originalInvoices.workspaceId, ws), eq(originalInvoices.id, id)))
    .get()
  if (!row) throw notFound('Original invoice')
  const lines = db
    .select()
    .from(originalInvoiceLines)
    .where(
      and(eq(originalInvoiceLines.workspaceId, ws), eq(originalInvoiceLines.originalInvoiceId, id)),
    )
    .all()
  return { ...row, lines }
}

/** The provider and service named in the body must be in this workspace. */
function assertReferences(ws: number, input: OriginalInvoiceInput) {
  const provider = db
    .select({ id: providers.id })
    .from(providers)
    .where(and(eq(providers.workspaceId, ws), eq(providers.id, input.providerId)))
    .get()
  if (!provider) throw new ApiError(422, 'Choose a provider that exists')
  if (
    input.serviceId &&
    !db
      .select({ id: services.id })
      .from(services)
      .where(and(eq(services.workspaceId, ws), eq(services.id, input.serviceId)))
      .get()
  ) {
    throw new ApiError(422, 'Choose a service that exists')
  }
}

export function saveOriginal(
  ws: number,
  id: number | null,
  input: OriginalInvoiceInput,
  pdfFile?: string,
) {
  assertReferences(ws, input)
  const { baseCurrency } = getSettings(ws)
  const fxRate = effectiveRate(input.currency, input.fxRate, baseCurrency)
  if (fxRate <= 0) throw new ApiError(422, `Enter the exchange rate for ${input.currency}`)
  const lines = input.lines.map((line) => ({
    ...line,
    workspaceId: ws,
    total: lineNet(line.quantity, line.unitPrice, input.currency),
  }))
  const subtotal = lines.reduce((sum, line) => sum + line.total, 0)
  const total = subtotal + input.tax
  const values = {
    workspaceId: ws,
    providerId: input.providerId,
    serviceId: input.serviceId,
    number: input.number,
    issuedOn: input.issuedOn,
    dueOn: input.dueOn,
    currency: input.currency,
    fxRate,
    subtotal,
    tax: input.tax,
    total,
    baseSubtotal: toBase(subtotal, fxRate, baseCurrency),
    baseTotal: toBase(total, fxRate, baseCurrency),
    notes: input.notes,
    ...(pdfFile ? { pdfFile } : {}),
  }
  const savedId = db.transaction((tx) => {
    if (id) {
      const existing = tx
        .select({ id: originalInvoiceLines.id, description: originalInvoiceLines.description })
        .from(originalInvoiceLines)
        .where(
          and(
            eq(originalInvoiceLines.workspaceId, ws),
            eq(originalInvoiceLines.originalInvoiceId, id),
          ),
        )
        .all()
      tx.update(originalInvoices)
        .set(values)
        .where(and(eq(originalInvoices.workspaceId, ws), eq(originalInvoices.id, id)))
        .run()
      for (const row of existing) {
        const stillThere = lines.some((line) => line.description === row.description)
        if (!stillThere) {
          tx.update(invoiceLines)
            .set({ originalInvoiceLineId: null })
            .where(
              and(eq(invoiceLines.workspaceId, ws), eq(invoiceLines.originalInvoiceLineId, row.id)),
            )
            .run()
        }
      }
      // Keep line ids where the description matches, so links from customer lines survive.
      const remaining = [...existing]
      for (const line of lines) {
        const index = remaining.findIndex((row) => row.description === line.description)
        if (index >= 0) {
          const [match] = remaining.splice(index, 1)
          tx.update(originalInvoiceLines)
            .set(line)
            .where(
              and(eq(originalInvoiceLines.workspaceId, ws), eq(originalInvoiceLines.id, match.id)),
            )
            .run()
        } else {
          tx.insert(originalInvoiceLines)
            .values({ ...line, originalInvoiceId: id })
            .run()
        }
      }
      for (const row of remaining) {
        tx.delete(originalInvoiceLines)
          .where(and(eq(originalInvoiceLines.workspaceId, ws), eq(originalInvoiceLines.id, row.id)))
          .run()
      }
      return id
    }
    const created = tx.insert(originalInvoices).values(values).returning().get()
    tx.insert(originalInvoiceLines)
      .values(lines.map((line) => ({ ...line, originalInvoiceId: created.id })))
      .run()
    return created.id
  })
  return getOriginal(ws, savedId)
}

export async function deleteOriginal(ws: number, id: number) {
  const row = getOriginal(ws, id)
  db.delete(originalInvoices)
    .where(and(eq(originalInvoices.workspaceId, ws), eq(originalInvoices.id, id)))
    .run()
  await removeFile(row.pdfFile)
}

export function setOriginalPaid(ws: number, id: number, paidOn: string | null) {
  getOriginal(ws, id)
  db.update(originalInvoices)
    .set({ paidOn })
    .where(and(eq(originalInvoices.workspaceId, ws), eq(originalInvoices.id, id)))
    .run()
  return getOriginal(ws, id)
}
