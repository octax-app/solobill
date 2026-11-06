import { sql } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type {
  BorderMode,
  CustomField,
  CustomItem,
  CustomValues,
  Separator,
  TableColumn,
} from '../../shared/render.ts'

const id = integer('id').primaryKey({ autoIncrement: true })
const timestamps = {
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString())
    .$onUpdateFn(() => new Date().toISOString()),
}

/** One business. Every domain row belongs to exactly one (docs/ARCHITECTURE.md, rule 12). */
export const workspaces = sqliteTable('workspaces', {
  id,
  name: text('name').notNull(),
  ...timestamps,
})

const workspaceId = () =>
  integer('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' })

export const users = sqliteTable('users', {
  id,
  /** Stored lower case. */
  email: text('email').notNull().unique(),
  /** Null for a user who only signs in with Google or Apple (plan 23). */
  passwordHash: text('password_hash'),
  name: text('name'),
  /** Set by the email link, a password reset, or a Google or Apple sign-in. */
  emailVerifiedAt: text('email_verified_at'),
  totpSecret: text('totp_secret'),
  totpEnabled: integer('totp_enabled', { mode: 'boolean' }).notNull().default(false),
  ...timestamps,
})

/** A Google or Apple account linked to a user, found by the provider's `sub`, never by email. */
export const userIdentities = sqliteTable(
  'user_identities',
  {
    id,
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider', { enum: ['google', 'apple'] }).notNull(),
    subject: text('subject').notNull(),
    email: text('email'),
    /** Apple only. Revoked through Apple when the account is deleted, as Apple requires. */
    appleRefreshToken: text('apple_refresh_token'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('identity_per_subject').on(t.provider, t.subject),
    index('user_identities_user').on(t.userId),
  ],
)

/** Email verification and password reset links. Only the SHA-256 of the token is stored. */
export const emailTokens = sqliteTable(
  'email_tokens',
  {
    id,
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose', { enum: ['verify', 'reset'] }).notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: text('expires_at').notNull(),
    usedAt: text('used_at'),
    ...timestamps,
  },
  (t) => [index('email_tokens_user').on(t.userId, t.purpose)],
)

/** `owner` only for now. `admin` and `member` are reserved for teams. */
export const memberships = sqliteTable(
  'memberships',
  {
    id,
    workspaceId: workspaceId(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'admin', 'member'] }).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('membership_per_user').on(t.workspaceId, t.userId),
    index('memberships_user').on(t.userId),
  ],
)

export const authSessions = sqliteTable(
  'auth_sessions',
  {
    id,
    /** The active workspace, checked against `memberships` on every request. */
    workspaceId: workspaceId(),
    tokenHash: text('token_hash').notNull().unique(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: text('expires_at').notNull(),
    ...timestamps,
  },
  (t) => [index('auth_sessions_workspace').on(t.workspaceId)],
)

export const apiTokens = sqliteTable(
  'api_tokens',
  {
    id,
    /** The active workspace, checked against `memberships` on every request. */
    workspaceId: workspaceId(),
    tokenHash: text('token_hash').notNull().unique(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    lastUsedAt: text('last_used_at'),
    ...timestamps,
  },
  (t) => [index('api_tokens_workspace').on(t.workspaceId)],
)

/** Removed with the login token, so a revoked phone stops receiving customer details. */
export const deviceTokens = sqliteTable('device_tokens', {
  id,
  apiTokenId: integer('api_token_id')
    .notNull()
    .references(() => apiTokens.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  environment: text('environment', { enum: ['sandbox', 'production'] }).notNull(),
  ...timestamps,
})

export const settings = sqliteTable(
  'settings',
  {
    id,
    workspaceId: workspaceId(),
    baseCurrency: text('base_currency').notNull().default('USD'),
    renewalLeadDays: integer('renewal_lead_days').notNull().default(14),
    invoicePrefix: text('invoice_prefix').notNull().default('INV-'),
    proformaPrefix: text('proforma_prefix').notNull().default('PF-'),
    ...timestamps,
  },
  (t) => [uniqueIndex('settings_per_workspace').on(t.workspaceId)],
)

export const fonts = sqliteTable(
  'fonts',
  {
    id,
    workspaceId: workspaceId(),
    name: text('name').notNull(),
    regularFile: text('regular_file').notNull(),
    /** Without a bold file, bold text uses the regular file. */
    boldFile: text('bold_file'),
    coversArabic: integer('covers_arabic', { mode: 'boolean' }).notNull().default(false),
    ...timestamps,
  },
  (t) => [index('fonts_workspace').on(t.workspaceId)],
)

export const templates = sqliteTable(
  'templates',
  {
    id,
    workspaceId: workspaceId(),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['system', 'uploaded'] }).notNull(),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    pdfFile: text('pdf_file').notNull(),
    pageCount: integer('page_count').notNull().default(1),
    companyName: text('company_name').notNull().default(''),
    companyAddress: text('company_address').notNull().default(''),
    companyLogoFile: text('company_logo_file'),
    taxNumber: text('tax_number').notNull().default(''),
    bankDetails: text('bank_details').notNull().default(''),
    defaultTaxRate: integer('default_tax_rate').notNull().default(50_000),
    textColor: text('text_color').notNull().default('#1a1a21'),
    lineHeight: real('line_height').notNull().default(1.32),
    fontId: integer('font_id').references(() => fonts.id),
    separators: text('separators', { mode: 'json' }).$type<Separator[]>().notNull().default([]),
    customFields: text('custom_fields', { mode: 'json' })
      .$type<CustomField[]>()
      .notNull()
      .default([]),
    ...timestamps,
  },
  (t) => [index('templates_workspace').on(t.workspaceId)],
)

export const templateRegions = sqliteTable(
  'template_regions',
  {
    id,
    workspaceId: workspaceId(),
    templateId: integer('template_id')
      .notNull()
      .references(() => templates.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    page: integer('page').notNull().default(0),
    x: integer('x').notNull(),
    y: integer('y').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    fontSize: integer('font_size').notNull().default(10),
    align: text('align', { enum: ['left', 'center', 'right'] })
      .notNull()
      .default('left'),
    columns: text('columns', { mode: 'json' }).$type<TableColumn[]>(),
    rowHeight: integer('row_height'),
    showHeader: integer('show_header', { mode: 'boolean' }).notNull().default(true),
    color: text('color'),
    fontId: integer('font_id').references(() => fonts.id),
    lineHeight: real('line_height'),
    borders: text('borders').$type<BorderMode>(),
    borderColor: text('border_color'),
  },
  (t) => [
    index('template_regions_workspace').on(t.workspaceId),
    uniqueIndex('template_region_key').on(t.templateId, t.key),
  ],
)

export const providers = sqliteTable(
  'providers',
  {
    id,
    workspaceId: workspaceId(),
    name: text('name').notNull(),
    logoFile: text('logo_file'),
    website: text('website').notNull().default(''),
    details: text('details').notNull().default(''),
    defaultTemplateId: integer('default_template_id').references(() => templates.id),
    archivedAt: text('archived_at'),
    ...timestamps,
  },
  (t) => [index('providers_workspace').on(t.workspaceId)],
)

export const services = sqliteTable(
  'services',
  {
    id,
    workspaceId: workspaceId(),
    providerId: integer('provider_id')
      .notNull()
      .references(() => providers.id),
    name: text('name').notNull(),
    pricing: text('pricing', { enum: ['fixed', 'metered'] })
      .notNull()
      .default('fixed'),
    cycle: text('cycle', { enum: ['monthly', 'quarterly', 'yearly', 'once'] })
      .notNull()
      .default('monthly'),
    defaultCost: integer('default_cost').notNull().default(0),
    defaultPrice: integer('default_price').notNull().default(0),
    currency: text('currency').notNull().default('USD'),
    defaultTemplateId: integer('default_template_id').references(() => templates.id),
    archivedAt: text('archived_at'),
    ...timestamps,
  },
  (t) => [index('services_workspace').on(t.workspaceId)],
)

export const customers = sqliteTable(
  'customers',
  {
    id,
    workspaceId: workspaceId(),
    status: text('status', { enum: ['lead', 'active', 'archived'] })
      .notNull()
      .default('active'),
    name: text('name').notNull(),
    company: text('company').notNull().default(''),
    email: text('email').notNull().default(''),
    phone: text('phone').notNull().default(''),
    address: text('address').notNull().default(''),
    taxNumber: text('tax_number').notNull().default(''),
    currency: text('currency').notNull().default('USD'),
    notes: text('notes').notNull().default(''),
    ...timestamps,
  },
  (t) => [index('customers_workspace').on(t.workspaceId)],
)

export const subscriptions = sqliteTable(
  'subscriptions',
  {
    id,
    workspaceId: workspaceId(),
    customerId: integer('customer_id')
      .notNull()
      .references(() => customers.id),
    serviceId: integer('service_id')
      .notNull()
      .references(() => services.id),
    label: text('label').notNull().default(''),
    cycle: text('cycle', { enum: ['monthly', 'quarterly', 'yearly', 'once'] }).notNull(),
    startedOn: text('started_on').notNull(),
    nextRenewalOn: text('next_renewal_on'),
    costAmount: integer('cost_amount').notNull().default(0),
    costCurrency: text('cost_currency').notNull().default('USD'),
    priceAmount: integer('price_amount').notNull().default(0),
    priceCurrency: text('price_currency').notNull().default('USD'),
    status: text('status', { enum: ['active', 'paused', 'cancelled'] })
      .notNull()
      .default('active'),
    ...timestamps,
  },
  (t) => [
    index('subscriptions_workspace').on(t.workspaceId),
    index('subscriptions_renewal').on(t.status, t.nextRenewalOn),
  ],
)

/** The charges that renew together. `subscriptions` keeps their totals. */
export const subscriptionLines = sqliteTable(
  'subscription_lines',
  {
    id,
    workspaceId: workspaceId(),
    subscriptionId: integer('subscription_id')
      .notNull()
      .references(() => subscriptions.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    description: text('description').notNull(),
    costAmount: integer('cost_amount').notNull().default(0),
    priceAmount: integer('price_amount').notNull().default(0),
  },
  (t) => [
    index('subscription_lines_workspace').on(t.workspaceId),
    index('subscription_lines_subscription').on(t.subscriptionId),
  ],
)

export const originalInvoices = sqliteTable(
  'original_invoices',
  {
    id,
    workspaceId: workspaceId(),
    providerId: integer('provider_id')
      .notNull()
      .references(() => providers.id),
    serviceId: integer('service_id').references(() => services.id),
    number: text('number').notNull().default(''),
    issuedOn: text('issued_on').notNull(),
    dueOn: text('due_on'),
    currency: text('currency').notNull(),
    fxRate: integer('fx_rate').notNull(),
    subtotal: integer('subtotal').notNull().default(0),
    tax: integer('tax').notNull().default(0),
    total: integer('total').notNull().default(0),
    baseSubtotal: integer('base_subtotal').notNull().default(0),
    baseTotal: integer('base_total').notNull().default(0),
    paidOn: text('paid_on'),
    pdfFile: text('pdf_file'),
    notes: text('notes').notNull().default(''),
    ...timestamps,
  },
  (t) => [index('original_invoices_workspace').on(t.workspaceId)],
)

export const originalInvoiceLines = sqliteTable(
  'original_invoice_lines',
  {
    id,
    workspaceId: workspaceId(),
    originalInvoiceId: integer('original_invoice_id')
      .notNull()
      .references(() => originalInvoices.id, { onDelete: 'cascade' }),
    description: text('description').notNull(),
    quantity: integer('quantity').notNull(),
    unitPrice: integer('unit_price').notNull(),
    total: integer('total').notNull(),
  },
  (t) => [index('original_invoice_lines_workspace').on(t.workspaceId)],
)

export interface SellerSnapshot {
  companyName: string
  companyAddress: string
  taxNumber: string
  bankDetails: string
}

export const invoices = sqliteTable(
  'invoices',
  {
    id,
    workspaceId: workspaceId(),
    type: text('type', { enum: ['invoice', 'proforma'] }).notNull(),
    status: text('status', { enum: ['draft', 'issued', 'paid', 'converted', 'void'] })
      .notNull()
      .default('draft'),
    source: text('source', { enum: ['manual', 'renewal'] })
      .notNull()
      .default('manual'),
    number: text('number'),
    issuerKey: text('issuer_key'),
    customerId: integer('customer_id')
      .notNull()
      .references(() => customers.id),
    providerId: integer('provider_id').references(() => providers.id),
    serviceId: integer('service_id').references(() => services.id),
    templateId: integer('template_id')
      .notNull()
      .references(() => templates.id),
    /** Typed on a draft. It only becomes `issued_on` at issue, because that means issued. */
    issueDate: text('issue_date'),
    issuedOn: text('issued_on'),
    dueOn: text('due_on'),
    validUntil: text('valid_until'),
    currency: text('currency').notNull(),
    fxRate: integer('fx_rate').notNull(),
    taxEnabled: integer('tax_enabled', { mode: 'boolean' }).notNull().default(false),
    taxRate: integer('tax_rate').notNull().default(0),
    subtotal: integer('subtotal').notNull().default(0),
    tax: integer('tax').notNull().default(0),
    total: integer('total').notNull().default(0),
    baseSubtotal: integer('base_subtotal').notNull().default(0),
    baseTotal: integer('base_total').notNull().default(0),
    notes: text('notes').notNull().default(''),
    sellerSnapshot: text('seller_snapshot', { mode: 'json' }).$type<SellerSnapshot>(),
    paidAmount: integer('paid_amount').notNull().default(0),
    discountAmount: integer('discount_amount').notNull().default(0),
    revenueAdjustBase: integer('revenue_adjust_base').notNull().default(0),
    customValues: text('custom_values', { mode: 'json' })
      .$type<CustomValues>()
      .notNull()
      .default({}),
    customSnapshot: text('custom_snapshot', { mode: 'json' }).$type<CustomItem[]>(),
    pdfFile: text('pdf_file'),
    paidOn: text('paid_on'),
    convertedFromId: integer('converted_from_id'),
    ...timestamps,
  },
  (t) => [
    index('invoices_workspace').on(t.workspaceId),
    uniqueIndex('invoice_number_per_issuer')
      .on(t.workspaceId, t.issuerKey, t.type, t.number)
      .where(sql`status <> 'void'`),
    index('invoices_status').on(t.type, t.status),
  ],
)

export const invoicePayments = sqliteTable(
  'invoice_payments',
  {
    id,
    workspaceId: workspaceId(),
    invoiceId: integer('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['payment', 'discount'] }).notNull(),
    amount: integer('amount').notNull(),
    paidOn: text('paid_on').notNull(),
    note: text('note').notNull().default(''),
    /** Shared by the rows of one customer payment, so they are removed together. */
    groupId: text('group_id'),
    ...timestamps,
  },
  (t) => [
    index('invoice_payments_workspace').on(t.workspaceId),
    index('invoice_payments_invoice').on(t.invoiceId),
    index('invoice_payments_group').on(t.groupId),
  ],
)

export const invoiceLines = sqliteTable(
  'invoice_lines',
  {
    id,
    workspaceId: workspaceId(),
    invoiceId: integer('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    subscriptionId: integer('subscription_id').references(() => subscriptions.id),
    subscriptionLineId: integer('subscription_line_id').references(() => subscriptionLines.id, {
      onDelete: 'set null',
    }),
    periodStart: text('period_start'),
    description: text('description').notNull(),
    quantity: integer('quantity').notNull(),
    unitPrice: integer('unit_price').notNull(),
    net: integer('net').notNull().default(0),
    tax: integer('tax').notNull().default(0),
    total: integer('total').notNull().default(0),
    costAmount: integer('cost_amount').notNull().default(0),
    costCurrency: text('cost_currency').notNull(),
    costFxRate: integer('cost_fx_rate').notNull(),
    costBase: integer('cost_base').notNull().default(0),
    originalInvoiceLineId: integer('original_invoice_line_id').references(
      () => originalInvoiceLines.id,
      { onDelete: 'set null' },
    ),
    amountConfirmed: integer('amount_confirmed', { mode: 'boolean' }).notNull().default(true),
  },
  (t) => [
    index('invoice_lines_workspace').on(t.workspaceId),
    uniqueIndex('one_subscription_line_per_period')
      .on(t.subscriptionLineId, t.periodStart)
      .where(sql`subscription_line_id is not null and period_start is not null`),
  ],
)

export const numberSequences = sqliteTable(
  'number_sequences',
  {
    id,
    workspaceId: workspaceId(),
    issuerKey: text('issuer_key').notNull(),
    type: text('type', { enum: ['invoice', 'proforma'] }).notNull(),
    nextValue: integer('next_value').notNull().default(1),
  },
  (t) => [uniqueIndex('sequence_per_issuer').on(t.workspaceId, t.issuerKey, t.type)],
)

export const reminders = sqliteTable(
  'reminders',
  {
    id,
    workspaceId: workspaceId(),
    kind: text('kind', {
      enum: ['renewal_draft', 'invoice_overdue', 'original_due'],
    }).notNull(),
    refId: integer('ref_id').notNull(),
    message: text('message').notNull(),
    link: text('link').notNull(),
    readAt: text('read_at'),
    pushedAt: text('pushed_at'),
    ...timestamps,
  },
  (t) => [uniqueIndex('one_reminder_per_ref').on(t.workspaceId, t.kind, t.refId)],
)
