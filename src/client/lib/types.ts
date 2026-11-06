import type { z } from 'zod'
import type * as s from '../../server/db/schema.ts'
import type * as res from '../../shared/api-responses.ts'
import type { Region } from '../../shared/render.ts'

export type Me = z.infer<typeof res.meResponse>
export type AuthProviders = z.infer<typeof res.authProvidersResponse>
export type Identity = z.infer<typeof res.identityResponse>

export type Provider = typeof s.providers.$inferSelect
export type Service = typeof s.services.$inferSelect & { providerName: string }
export type Customer = typeof s.customers.$inferSelect
export type Subscription = typeof s.subscriptions.$inferSelect & {
  customerName: string
  serviceName: string
  providerName: string
  pricing: 'fixed' | 'metered'
  lines: (typeof s.subscriptionLines.$inferSelect)[]
}
export type Template = typeof s.templates.$inferSelect & {
  regions: Region[]
  problems: string[]
  ready: boolean
  usage?: { providers: { id: number; name: string }[]; services: { id: number; name: string }[] }
}
export type Font = typeof s.fonts.$inferSelect & { usedBy: string[] }
export type InvoiceLine = typeof s.invoiceLines.$inferSelect
export type Invoice = typeof s.invoices.$inferSelect
export type InvoicePayment = typeof s.invoicePayments.$inferSelect
export type InvoiceFull = Invoice & { lines: InvoiceLine[]; payments: InvoicePayment[] }
export type InvoiceRow = Invoice & {
  customerName: string
  customerCompany: string
  providerName: string | null
}
export type OriginalLine = typeof s.originalInvoiceLines.$inferSelect
export type Original = typeof s.originalInvoices.$inferSelect & { providerName: string }
export type OriginalFull = typeof s.originalInvoices.$inferSelect & { lines: OriginalLine[] }
export type Reminder = typeof s.reminders.$inferSelect
export type Settings = typeof s.settings.$inferSelect & {
  baseCurrencyLocked: boolean
}
export interface ApiTokenRow {
  id: number
  name: string
  lastUsedAt: string | null
  createdAt: string
}
export interface OriginalLineOption {
  id: number
  description: string
  total: number
  currency: string
  number: string
  issuedOn: string
  providerName: string
}

export interface Overview {
  baseCurrency: string
  from: string
  to: string
  today: string
  summary: { revenue: number; cost: number; profit: number; margin: number }
  toCollect: {
    id: number
    number: string | null
    dueOn: string | null
    total: number
    baseTotal: number
    due: number
    baseDue: number
    currency: string
    customerId: number
    customerName: string
  }[]
  toCollectTotal: number
  toPay: {
    id: number
    number: string
    dueOn: string | null
    total: number
    baseTotal: number
    currency: string
    providerName: string
  }[]
  toPayTotal: number
  renewals: {
    id: number
    label: string
    nextRenewalOn: string
    priceAmount: number
    priceCurrency: string
    customerId: number
    customerName: string
    serviceName: string
  }[]
  trend: { month: string; revenue: number; cost: number; profit: number }[]
  unallocatedCost: number
  draftsToReview: number
}

export interface CustomerPayment {
  allocations: { invoiceId: number; number: string; amount: number }[]
  excess: number
}

export interface CustomerSummary {
  baseCurrency: string
  summary: Overview['summary']
  pending: number
  linkedOriginals: {
    id: number
    number: string
    issuedOn: string
    total: number
    currency: string
    providerName: string
  }[]
}
