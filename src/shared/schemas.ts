import { z } from 'zod'
import { CURRENCY_CODES } from './money.ts'
import { customFieldSchema, regionSchema, separatorSchema, templateStyleSchema } from './render.ts'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
const realDate = isoDate.refine((value) => {
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value)
}, 'Enter a real date')
const amount = z.number().int().safe()
const positive = z.number().int().positive().safe()
const currency = z.enum(CURRENCY_CODES as [string, ...string[]])
const cycle = z.enum(['monthly', 'quarterly', 'yearly', 'once'])
const id = z.number().int().positive()
const rate = z.number().int().min(0).safe()

export const settingsInput = z.object({
  baseCurrency: currency,
  renewalLeadDays: z.number().int().min(1).max(120),
  invoicePrefix: z.string().max(12),
  proformaPrefix: z.string().max(12),
})

export const providerInput = z.object({
  name: z.string().trim().min(1, 'Enter a provider name').max(120),
  website: z.string().trim().max(200).default(''),
  details: z.string().max(4000).default(''),
  defaultTemplateId: id.nullable().default(null),
})

export const serviceInput = z.object({
  providerId: id,
  name: z.string().trim().min(1, 'Enter a service name').max(120),
  pricing: z.enum(['fixed', 'metered']),
  cycle,
  defaultCost: amount.min(0),
  defaultPrice: amount.min(0),
  currency,
  defaultTemplateId: id.nullable().default(null),
})

export const customerInput = z.object({
  status: z.enum(['lead', 'active', 'archived']).default('active'),
  name: z.string().trim().min(1, 'Enter a customer name').max(160),
  company: z.string().trim().max(160).default(''),
  email: z.union([z.literal(''), z.email('Enter a valid email')]).default(''),
  phone: z.string().trim().max(40).default(''),
  address: z.string().max(1000).default(''),
  taxNumber: z.string().trim().max(60).default(''),
  currency,
  notes: z.string().max(4000).default(''),
})

const subscriptionLine = z.object({
  id: id.optional(),
  description: z.string().trim().max(1000).default(''),
  costAmount: amount.min(0),
  priceAmount: amount.min(0),
})

const subscriptionLines = z.array(subscriptionLine).min(1, 'Add at least one line').max(50)

const subscriptionFields = z.object({
  customerId: id,
  serviceId: id,
  label: z.string().trim().max(160).default(''),
  cycle: cycle.optional(),
  startedOn: isoDate,
  nextRenewalOn: isoDate.nullable().optional(),
  costCurrency: currency.optional(),
  priceCurrency: currency.optional(),
  status: z.enum(['active', 'paused', 'cancelled']).default('active'),
})

export const subscriptionCreateInput = subscriptionFields.extend({
  lines: subscriptionLines.optional(),
  createFirstInvoice: z.boolean().default(false),
})

export const subscriptionUpdateInput = subscriptionFields.extend({ lines: subscriptionLines })

export const templateDetailsInput = z.object({
  name: z.string().trim().min(1, 'Enter a template name').max(120),
  companyName: z.string().trim().max(200),
  companyAddress: z.string().max(1000),
  taxNumber: z.string().trim().max(60),
  bankDetails: z.string().max(1000),
  defaultTaxRate: z.number().int().min(0).max(1_000_000),
})

/** `style`, `separators` and `customFields` keep what is stored when they are absent. */
export const templateLayoutInput = z.object({
  regions: z.array(regionSchema).max(20),
  style: templateStyleSchema.optional(),
  separators: z.array(separatorSchema).max(50).optional(),
  customFields: z.array(customFieldSchema).max(20).optional(),
})

/** `layout` renders unsaved edits. Nothing in it is stored. */
export const previewInput = z.object({
  tax: z.boolean().default(true),
  long: z.boolean().default(false),
  arabic: z.boolean().default(false),
  layout: templateLayoutInput.optional(),
})

export const fontNameInput = z.string().trim().min(1, 'Enter a font name').max(120)

const originalLine = z.object({
  description: z.string().trim().min(1, 'Enter a description').max(500),
  quantity: positive,
  unitPrice: amount,
})

export const originalInvoiceInput = z.object({
  providerId: id,
  serviceId: id.nullable().default(null),
  number: z.string().trim().max(80).default(''),
  issuedOn: isoDate,
  dueOn: isoDate.nullable().default(null),
  currency,
  fxRate: rate,
  tax: amount.min(0).default(0),
  notes: z.string().max(4000).default(''),
  lines: z.array(originalLine).min(1, 'Add at least one line').max(500),
})

const invoiceLine = z.object({
  subscriptionId: id.nullable().default(null),
  subscriptionLineId: id.nullable().default(null),
  periodStart: isoDate.nullable().default(null),
  description: z.string().trim().min(1, 'Enter a description').max(1000),
  quantity: positive,
  unitPrice: amount.min(0),
  costAmount: amount.min(0).default(0),
  costCurrency: currency,
  costFxRate: rate,
  originalInvoiceLineId: id.nullable().default(null),
  amountConfirmed: z.boolean().default(true),
})

export const invoiceInput = z.object({
  type: z.enum(['invoice', 'proforma']),
  number: z
    .string()
    .trim()
    .max(40, 'Use 40 characters or fewer for the number')
    .transform((value) => value || null)
    .nullable()
    .default(null),
  customerId: id,
  providerId: id.nullable().default(null),
  serviceId: id.nullable().default(null),
  templateId: id.nullable().default(null),
  /** Absent keeps what is stored. iOS sends drafts back without this. */
  issueDate: realDate.nullable().optional(),
  dueOn: isoDate.nullable().default(null),
  validUntil: isoDate.nullable().default(null),
  currency,
  fxRate: rate,
  taxEnabled: z.boolean(),
  taxRate: z.number().int().min(0).max(1_000_000),
  notes: z.string().max(4000).default(''),
  /** Absent keeps what is stored. iOS sends drafts back without these. */
  customValues: z.record(z.string(), z.string().max(500)).optional(),
  lines: z.array(invoiceLine).min(1, 'Add at least one line').max(500),
})

export const lineCostInput = z.object({
  costAmount: amount.min(0),
  costCurrency: currency,
  costFxRate: rate,
  originalInvoiceLineId: id.nullable().default(null),
})

export const paidInput = z.object({ paidOn: isoDate.optional() })

const paymentFields = {
  amount: positive,
  paidOn: isoDate.optional(),
  note: z.string().trim().max(500).default(''),
}

export const paymentInput = z.object({
  kind: z.enum(['payment', 'discount']),
  ...paymentFields,
})

export const customerPaymentInput = z.object({ currency, ...paymentFields })

export const deviceInput = z.object({
  token: z.string().regex(/^[0-9a-f]{32,200}$/, 'That is not a device token'),
  environment: z.enum(['sandbox', 'production']),
})

export type InvoiceInput = z.infer<typeof invoiceInput>
export type SubscriptionLineInput = z.infer<typeof subscriptionLine>
export type OriginalInvoiceInput = z.infer<typeof originalInvoiceInput>
