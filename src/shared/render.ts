import { z } from 'zod'

export const REGION_KEYS = [
  'document_title',
  'document_meta',
  'customer',
  'line_table',
  'totals',
  'tax_details',
  'company',
  'logo',
  'notes',
] as const
export type RegionKey = (typeof REGION_KEYS)[number]

export const REQUIRED_REGIONS: RegionKey[] = ['document_meta', 'customer', 'line_table', 'totals']

export const REGION_LABELS: Record<RegionKey, string> = {
  document_title: 'Document title',
  document_meta: 'Number and dates',
  customer: 'Customer details',
  line_table: 'Content table',
  totals: 'Totals',
  tax_details: 'Tax details',
  company: 'Your company',
  logo: 'Your logo',
  notes: 'Bank details and notes',
}

export const COLUMN_KEYS = [
  'description',
  'quantity',
  'unit_price',
  'tax_rate',
  'tax_amount',
  'total',
] as const
export type ColumnKey = (typeof COLUMN_KEYS)[number]

export const tableColumnSchema = z.object({
  key: z.enum(COLUMN_KEYS),
  label: z.string().max(40),
  width: z.number().int().min(10).max(2000),
  align: z.enum(['left', 'center', 'right']),
  taxOnly: z.boolean(),
})
export type TableColumn = z.infer<typeof tableColumnSchema>

export const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Enter a color as #RRGGBB')

/** A multiplier of the font size. */
export const lineHeightValue = z.number().min(1).max(3)

export const BORDER_MODES = ['none', 'horizontal', 'vertical', 'both'] as const
export type BorderMode = (typeof BORDER_MODES)[number]

/** Coordinates are PDF points from the top left of the page. */
export const regionSchema = z.object({
  key: z.enum(REGION_KEYS),
  page: z.number().int().min(0),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().min(10),
  height: z.number().int().min(10),
  fontSize: z.number().int().min(6).max(48),
  align: z.enum(['left', 'center', 'right']),
  columns: z.array(tableColumnSchema).nullable().optional(),
  rowHeight: z.number().int().min(10).max(120).nullable().optional(),
  showHeader: z.boolean().optional(),
  /** Null means the region uses the template's value. */
  color: hexColor.nullable().optional(),
  fontId: z.number().int().positive().nullable().optional(),
  lineHeight: lineHeightValue.nullable().optional(),
  /** Only used on the content table. Null means `none`. */
  borders: z.enum(BORDER_MODES).nullable().optional(),
  borderColor: hexColor.nullable().optional(),
})
export type Region = z.infer<typeof regionSchema>

export const templateStyleSchema = z.object({
  textColor: hexColor,
  lineHeight: lineHeightValue,
  /** Null is the bundled IBM Plex Sans Arabic. */
  fontId: z.number().int().positive().nullable(),
})
export type TemplateStyle = z.infer<typeof templateStyleSchema>

/** These match what the engine printed before styles existed. */
export const DEFAULT_STYLE: TemplateStyle = {
  textColor: '#1a1a21',
  lineHeight: 1.32,
  fontId: null,
}

export const DEFAULT_BORDER_COLOR = '#b8bdc7'

/** A line placed on the page. Coordinates are PDF points from the top left of the page. */
export const separatorSchema = z.object({
  id: z.uuid(),
  page: z.number().int().min(0),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  length: z.number().int().min(10).max(2000),
  orientation: z.enum(['horizontal', 'vertical']),
  thickness: z.number().min(0.25).max(6),
  color: hexColor,
})
export type Separator = z.infer<typeof separatorSchema>

export const CUSTOM_FIELD_TYPES = ['text', 'number', 'date'] as const
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number]

/** Blocks of label and value text, so an extra line reads naturally in them. */
export const CUSTOM_FIELD_REGIONS = ['document_meta', 'customer', 'company', 'notes'] as const
export type CustomFieldRegion = (typeof CUSTOM_FIELD_REGIONS)[number]

export const customFieldSchema = z.object({
  id: z.uuid(),
  label: z.string().trim().min(1, 'Enter a label for the custom item').max(60),
  type: z.enum(CUSTOM_FIELD_TYPES),
  required: z.boolean(),
  order: z.number().int().min(0).max(999),
  region: z.enum(CUSTOM_FIELD_REGIONS),
})
export type CustomField = z.infer<typeof customFieldSchema>

export const customItemSchema = z.object({
  region: z.enum(CUSTOM_FIELD_REGIONS),
  label: z.string(),
  value: z.string(),
})
/** One custom item as printed on a document. */
export type CustomItem = z.infer<typeof customItemSchema>

/** Item id to the text typed on the invoice. */
export type CustomValues = Record<string, string>

const isRealDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value)
}

/** Why this value cannot be issued, or null when it is fine. Blank optional items are fine. */
export function customValueProblem(field: CustomField, value: string | undefined): string | null {
  const text = value?.trim() ?? ''
  if (!text) return field.required ? `Enter ${field.label}` : null
  if (field.type === 'number' && !/^-?\d+(\.\d+)?$/.test(text)) {
    return `${field.label} must be a number`
  }
  if (field.type === 'date' && !isRealDate(text)) {
    return `${field.label} must be a date as YYYY-MM-DD`
  }
  return null
}

/** The items to print, in order. Items with no value are left off. */
export function customItemsFor(fields: CustomField[], values: CustomValues): CustomItem[] {
  return [...fields]
    .sort((a, b) => a.order - b.order)
    .flatMap((field) => {
      const value = values[field.id]?.trim()
      return value ? [{ region: field.region, label: field.label, value }] : []
    })
}

export const DEFAULT_COLUMNS: TableColumn[] = [
  { key: 'description', label: 'Description', width: 215, align: 'left', taxOnly: false },
  { key: 'quantity', label: 'Qty', width: 40, align: 'right', taxOnly: false },
  { key: 'unit_price', label: 'Unit price', width: 75, align: 'right', taxOnly: false },
  { key: 'tax_rate', label: 'Tax %', width: 40, align: 'right', taxOnly: true },
  { key: 'tax_amount', label: 'Tax', width: 55, align: 'right', taxOnly: true },
  { key: 'total', label: 'Total', width: 80, align: 'right', taxOnly: false },
]

export interface RenderLine {
  description: string
  quantity: string
  unitPrice: string
  taxRate: string
  taxAmount: string
  total: string
}

/**
 * Everything printed on a customer document. It is pre-formatted text, with no cost
 * or provider fields, so internal data cannot reach a customer PDF.
 */
export interface RenderPayload {
  title: string
  meta: { label: string; value: string }[]
  customerLines: string[]
  lines: RenderLine[]
  totals: { label: string; value: string; strong?: boolean }[]
  taxEnabled: boolean
  taxLines: string[]
  company: { name: string; address: string; taxNumber: string }
  notes: string
  customItems: CustomItem[]
}
