import {
  type CustomField,
  type CustomFieldRegion,
  DEFAULT_BORDER_COLOR,
  hexColor,
  REGION_LABELS,
  type Region,
  type RegionKey,
  type Separator,
  type TemplateStyle,
} from '../../shared/render.ts'
import { templateLayoutInput } from '../../shared/schemas.ts'

/** What the editor holds. Numbers may be half typed, so this is checked before it is sent. */
export interface LayoutDraft {
  regions: Region[]
  style: TemplateStyle
  separators: Separator[]
  customFields: CustomField[]
}

export type TemplateLayout = ReturnType<typeof templateLayoutInput.parse>
export type ParsedLayout = { ok: true; layout: TemplateLayout } | { ok: false; problem: string }

export const MAX_SEPARATORS = 50
export const MAX_CUSTOM_FIELDS = 20
const MAX_ORDER = 999
const MIN_LENGTH = 10
const MAX_LENGTH = 2000

const FIELD_RULES: Record<string, string> = {
  fontSize: 'font size must be a whole number from 6 to 48',
  lineHeight: 'line height must be from 1 to 3',
  rowHeight: 'row height must be a whole number from 10 to 120',
  length: 'length must be a whole number from 10 to 2000',
  thickness: 'thickness must be from 0.25 to 6',
  order: 'order must be a whole number from 0 to 999',
}

function problemText(draft: LayoutDraft, path: PropertyKey[], message: string) {
  const [section, index, field, , columnField] = path
  const at = Number(index)
  if (section === 'style') return `Whole template: ${FIELD_RULES[String(index)] ?? message}`
  if (section === 'regions') {
    const name = REGION_LABELS[draft.regions[at]?.key as RegionKey] ?? 'Region'
    if (field === 'columns') {
      const rule =
        columnField === 'width'
          ? 'column width must be a whole number from 10 to 2000'
          : 'column label must be 40 characters or fewer'
      return `${name}: ${rule}`
    }
    return `${name}: ${FIELD_RULES[String(field)] ?? message}`
  }
  if (section === 'separators') {
    return `Line ${at + 1}: ${FIELD_RULES[String(field)] ?? message}`
  }
  if (section === 'customFields') {
    const name = draft.customFields[at]?.label.trim() || `Custom item ${at + 1}`
    return `${name}: ${FIELD_RULES[String(field)] ?? message}`
  }
  return message
}

/** The one check in front of save, live result and the preview dialog. */
export function parseLayout(draft: LayoutDraft): ParsedLayout {
  const parsed = templateLayoutInput.safeParse({
    ...draft,
    regions: draft.regions.map((region) => ({ ...region, columns: region.columns ?? null })),
    customFields: sortFields(draft.customFields),
  })
  if (parsed.success) return { ok: true, layout: parsed.data }
  const issue = parsed.error.issues[0]
  return { ok: false, problem: problemText(draft, issue?.path ?? [], issue?.message ?? '') }
}

export const isHexColor = (value: string) => hexColor.safeParse(value).success

export function newSeparator(
  page: number,
  size: { width: number; height: number },
  id: string = crypto.randomUUID(),
): Separator {
  const length = 200
  return {
    id,
    page,
    x: Math.max(0, Math.round((size.width - length) / 2)),
    y: Math.round(size.height / 2),
    length,
    orientation: 'horizontal',
    thickness: 0.75,
    color: DEFAULT_BORDER_COLOR,
  }
}

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), Math.max(low, high))

/** Lines stay on the page, so one can never be dragged out of reach. */
export function moveSeparator(
  origin: Separator,
  dx: number,
  dy: number,
  size: { width: number; height: number },
): Pick<Separator, 'x' | 'y'> {
  return {
    x: clamp(origin.x + dx, 0, Math.floor(size.width) - 1),
    y: clamp(origin.y + dy, 0, Math.floor(size.height) - 1),
  }
}

export function resizeSeparator(
  origin: Separator,
  dx: number,
  dy: number,
  size: { width: number; height: number },
): Pick<Separator, 'length'> {
  const horizontal = origin.orientation === 'horizontal'
  const room = horizontal ? size.width - origin.x : size.height - origin.y
  return {
    length: clamp(
      origin.length + (horizontal ? dx : dy),
      MIN_LENGTH,
      Math.min(MAX_LENGTH, Math.floor(room)),
    ),
  }
}

export function newCustomField(
  fields: CustomField[],
  id: string = crypto.randomUUID(),
): CustomField {
  const orders = fields.map((field) => field.order).filter(Number.isFinite)
  return {
    id,
    label: '',
    type: 'text',
    required: false,
    order: Math.min(MAX_ORDER, Math.max(-1, ...orders) + 1),
    region: 'document_meta',
  }
}

/** A half-typed order sorts last, because NaN would otherwise break the comparison. */
export function sortFields(fields: CustomField[]): CustomField[] {
  const rank = (field: CustomField) => (Number.isFinite(field.order) ? field.order : Infinity)
  return [...fields].sort((a, b) => {
    if (rank(a) === rank(b)) return 0
    return rank(a) < rank(b) ? -1 : 1
  })
}

/** Why an item will not print, or null when its block is on the page. */
export function customFieldNote(
  field: Pick<CustomField, 'region' | 'required'>,
  mapped: ReadonlySet<RegionKey>,
): string | null {
  if (mapped.has(field.region)) return null
  const block: CustomFieldRegion = field.region
  return field.required
    ? `${REGION_LABELS[block]} is not on the page, so this required item blocks issue.`
    : `${REGION_LABELS[block]} is not on the page, so this item will not print.`
}
