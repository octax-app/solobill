import { z } from 'zod'

/**
 * The shape of each `/api/v1` response the iOS app reads. The objects are strict, so a new
 * server field fails the contract test until it is added here and to the Swift models.
 *
 * Amounts stay integers scaled by 10,000 and rates integers scaled by 100,000,000. `margin`
 * is a percentage for display only.
 */
const id = z.number().int()
const nullableId = id.nullable()
const amount = z.number().int()
const text = z.string()
const nullableText = z.string().nullable()
const timestamps = { createdAt: text, updatedAt: text }

export const okResponse = z.strictObject({ ok: z.literal(true) })

export const apiTokenResponse = z.strictObject({ id, name: text, token: text })

export const meResponse = z.strictObject({
  email: text,
  name: nullableText,
  totpEnabled: z.boolean(),
  /** False for a user who only signs in with Google or Apple. */
  hasPassword: z.boolean(),
  workspace: z.strictObject({ id, name: text }),
  role: z.enum(['owner', 'admin', 'member']),
})

/** Public. What the sign-in screen offers. Client ids are public values. */
export const authProvidersResponse = z.strictObject({
  registration: z.boolean(),
  google: z.boolean(),
  apple: z.boolean(),
  googleIosClientId: nullableText,
  googleAndroidClientId: nullableText,
})

export const identityResponse = z.strictObject({
  provider: z.enum(['google', 'apple']),
  email: nullableText,
  createdAt: text,
})

export const workspaceResponse = z.strictObject({ id, name: text })

export const totpStateResponse = z.strictObject({ totpEnabled: z.boolean() })

export const settingsResponse = z.strictObject({
  id,
  baseCurrency: text,
  renewalLeadDays: z.number().int(),
  invoicePrefix: text,
  proformaPrefix: text,
  ...timestamps,
  baseCurrencyLocked: z.boolean(),
  currencies: z.record(z.string(), z.strictObject({ decimals: z.number().int(), name: text })),
})

const profitSummary = z.strictObject({
  revenue: amount,
  cost: amount,
  profit: amount,
  margin: z.number(),
})

export const overviewResponse = z.strictObject({
  baseCurrency: text,
  from: text,
  to: text,
  today: text,
  summary: profitSummary,
  toCollect: z.array(
    z.strictObject({
      id,
      number: nullableText,
      dueOn: nullableText,
      issuedOn: nullableText,
      total: amount,
      baseTotal: amount,
      due: amount,
      baseDue: amount,
      currency: text,
      customerId: id,
      customerName: text,
    }),
  ),
  toCollectTotal: amount,
  toPay: z.array(
    z.strictObject({
      id,
      number: text,
      dueOn: nullableText,
      issuedOn: text,
      total: amount,
      baseTotal: amount,
      currency: text,
      providerId: id,
      providerName: text,
      providerLogo: nullableText,
    }),
  ),
  toPayTotal: amount,
  renewals: z.array(
    z.strictObject({
      id,
      label: text,
      nextRenewalOn: nullableText,
      priceAmount: amount,
      priceCurrency: text,
      customerId: id,
      customerName: text,
      serviceName: text,
    }),
  ),
  trend: z.array(z.strictObject({ month: text, revenue: amount, cost: amount, profit: amount })),
  unallocatedCost: amount,
  draftsToReview: z.number().int(),
})

export const customerResponse = z.strictObject({
  id,
  status: z.enum(['lead', 'active', 'archived']),
  name: text,
  company: text,
  email: text,
  phone: text,
  address: text,
  taxNumber: text,
  currency: text,
  notes: text,
  ...timestamps,
})

export const customerSummaryResponse = z.strictObject({
  baseCurrency: text,
  summary: profitSummary,
  pending: amount,
  linkedOriginals: z.array(
    z.strictObject({
      id,
      number: text,
      issuedOn: text,
      total: amount,
      currency: text,
      providerName: text,
    }),
  ),
})

const cycle = z.enum(['monthly', 'quarterly', 'yearly', 'once'])
const pricing = z.enum(['fixed', 'metered'])

export const providerResponse = z.strictObject({
  id,
  name: text,
  logoFile: nullableText,
  website: text,
  details: text,
  defaultTemplateId: nullableId,
  archivedAt: nullableText,
  ...timestamps,
})

export const serviceResponse = z.strictObject({
  id,
  providerId: id,
  name: text,
  pricing,
  cycle,
  defaultCost: amount,
  defaultPrice: amount,
  currency: text,
  defaultTemplateId: nullableId,
  archivedAt: nullableText,
  ...timestamps,
  providerName: text,
})

export const subscriptionLineResponse = z.strictObject({
  id,
  subscriptionId: id,
  position: z.number().int(),
  description: text,
  costAmount: amount,
  priceAmount: amount,
})

export const subscriptionResponse = z.strictObject({
  id,
  customerId: id,
  serviceId: id,
  label: text,
  cycle,
  startedOn: text,
  nextRenewalOn: nullableText,
  costAmount: amount,
  costCurrency: text,
  priceAmount: amount,
  priceCurrency: text,
  status: z.enum(['active', 'paused', 'cancelled']),
  ...timestamps,
  customerName: text,
  serviceName: text,
  providerName: text,
  pricing,
  lines: z.array(subscriptionLineResponse),
})

/** The app only reads these fields. It never edits templates. */
export const templateResponse = z.looseObject({
  id,
  name: text,
  isDefault: z.boolean(),
  defaultTaxRate: z.number().int(),
  ready: z.boolean(),
  problems: z.array(text),
})

const invoiceFields = {
  id,
  type: z.enum(['invoice', 'proforma']),
  status: z.enum(['draft', 'issued', 'paid', 'converted', 'void']),
  source: z.enum(['manual', 'renewal']),
  number: nullableText,
  issuerKey: nullableText,
  customerId: id,
  providerId: nullableId,
  serviceId: nullableId,
  templateId: id,
  issueDate: nullableText,
  issuedOn: nullableText,
  dueOn: nullableText,
  validUntil: nullableText,
  currency: text,
  fxRate: amount,
  taxEnabled: z.boolean(),
  taxRate: z.number().int(),
  subtotal: amount,
  tax: amount,
  total: amount,
  baseSubtotal: amount,
  baseTotal: amount,
  notes: text,
  sellerSnapshot: z
    .strictObject({
      companyName: text,
      companyAddress: text,
      taxNumber: text,
      bankDetails: text,
    })
    .nullable(),
  paidAmount: amount,
  discountAmount: amount,
  revenueAdjustBase: amount,
  customValues: z.record(text, text),
  customSnapshot: z.array(z.strictObject({ region: text, label: text, value: text })).nullable(),
  pdfFile: nullableText,
  paidOn: nullableText,
  convertedFromId: nullableId,
  ...timestamps,
}

export const invoiceLineResponse = z.strictObject({
  id,
  invoiceId: id,
  position: z.number().int(),
  subscriptionId: nullableId,
  subscriptionLineId: nullableId,
  periodStart: nullableText,
  description: text,
  quantity: amount,
  unitPrice: amount,
  net: amount,
  tax: amount,
  total: amount,
  costAmount: amount,
  costCurrency: text,
  costFxRate: amount,
  costBase: amount,
  originalInvoiceLineId: nullableId,
  amountConfirmed: z.boolean(),
})

export const invoiceResponse = z.strictObject(invoiceFields)

export const paymentResponse = z.strictObject({
  id,
  invoiceId: id,
  kind: z.enum(['payment', 'discount']),
  amount,
  paidOn: text,
  note: text,
  groupId: nullableText,
  ...timestamps,
})

export const invoiceFullResponse = z.strictObject({
  ...invoiceFields,
  lines: z.array(invoiceLineResponse),
  payments: z.array(paymentResponse),
})

export const customerPaymentResponse = z.strictObject({
  allocations: z.array(z.strictObject({ invoiceId: id, number: text, amount })),
  excess: amount,
})

export const invoiceRowResponse = z.strictObject({
  ...invoiceFields,
  customerName: text,
  customerCompany: text,
  providerName: nullableText,
})

export const fxRateResponse = z.strictObject({ rate: amount.nullable() })

export const resolvedTemplateResponse = z.strictObject({ templateId: id })

const originalFields = {
  id,
  providerId: id,
  serviceId: nullableId,
  number: text,
  issuedOn: text,
  dueOn: nullableText,
  currency: text,
  fxRate: amount,
  subtotal: amount,
  tax: amount,
  total: amount,
  baseSubtotal: amount,
  baseTotal: amount,
  paidOn: nullableText,
  pdfFile: nullableText,
  notes: text,
  ...timestamps,
}

export const originalLineResponse = z.strictObject({
  id,
  originalInvoiceId: id,
  description: text,
  quantity: amount,
  unitPrice: amount,
  total: amount,
})

export const originalRowResponse = z.strictObject({ ...originalFields, providerName: text })

export const originalFullResponse = z.strictObject({
  ...originalFields,
  lines: z.array(originalLineResponse),
})

export const reminderResponse = z.strictObject({
  id,
  kind: z.enum(['renewal_draft', 'invoice_overdue', 'original_due']),
  refId: id,
  message: text,
  link: text,
  readAt: nullableText,
  pushedAt: nullableText,
  ...timestamps,
})

export const errorResponse = z.strictObject({
  error: text,
  fields: z.array(z.strictObject({ path: text, message: text })).optional(),
})
