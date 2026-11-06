import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BORDER_COLOR,
  DEFAULT_STYLE,
  type Region,
  type Separator,
} from '../../shared/render.ts'
import {
  customFieldNote,
  isHexColor,
  type LayoutDraft,
  moveSeparator,
  newCustomField,
  newSeparator,
  parseLayout,
  resizeSeparator,
  sortFields,
} from './template-layout.ts'

const ID_A = '6f1c2f3e-8c55-4d0b-9f3e-0a1b2c3d4e5f'
const ID_B = '7a2d3e4f-9d66-4e1c-8a4f-1b2c3d4e5f60'
const PAGE = { width: 595, height: 842 }

const region: Region = {
  key: 'customer',
  page: 0,
  x: 10,
  y: 20,
  width: 100,
  height: 50,
  fontSize: 10,
  align: 'left',
}

const draft = (patch: Partial<LayoutDraft> = {}): LayoutDraft => ({
  regions: [region],
  style: DEFAULT_STYLE,
  separators: [],
  customFields: [],
  ...patch,
})

const problem = (patch: Partial<LayoutDraft>) => {
  const result = parseLayout(draft(patch))
  return result.ok ? null : result.problem
}

describe('parseLayout', () => {
  it('accepts a region without the newer style fields', () => {
    const result = parseLayout(draft())
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.layout.regions[0]?.columns).toBeNull()
  })

  it('names the region and the rule for a half-typed number', () => {
    expect(problem({ regions: [{ ...region, fontSize: Number.NaN }] })).toBe(
      'Customer details: font size must be a whole number from 6 to 48',
    )
    expect(problem({ regions: [{ ...region, lineHeight: 0.5 }] })).toBe(
      'Customer details: line height must be from 1 to 3',
    )
  })

  it('accepts null as inherit on a region', () => {
    expect(problem({ regions: [{ ...region, lineHeight: null, color: null }] })).toBeNull()
  })

  it('refuses a template line height out of range', () => {
    expect(problem({ style: { ...DEFAULT_STYLE, lineHeight: 3.5 } })).toBe(
      'Whole template: line height must be from 1 to 3',
    )
  })

  it('refuses a fractional or half-typed separator length', () => {
    const line = newSeparator(0, PAGE, ID_A)
    expect(problem({ separators: [line] })).toBeNull()
    expect(problem({ separators: [{ ...line, length: 20.5 }] })).toBe(
      'Line 1: length must be a whole number from 10 to 2000',
    )
  })

  it('refuses a column width that is too small', () => {
    const table: Region = {
      ...region,
      key: 'line_table',
      columns: [{ key: 'total', label: 'Total', width: 0, align: 'right', taxOnly: false }],
    }
    expect(problem({ regions: [table] })).toBe(
      'Content table: column width must be a whole number from 10 to 2000',
    )
  })

  it('asks for a label on a blank custom item', () => {
    expect(problem({ customFields: [newCustomField([], ID_A)] })).toBe(
      'Custom item 1: Enter a label for the custom item',
    )
  })

  it('sends custom items in order with labels trimmed', () => {
    const first = { ...newCustomField([], ID_A), label: ' Customer ID ', order: 5 }
    const second = { ...newCustomField([], ID_B), label: 'PO', order: 1 }
    const result = parseLayout(draft({ customFields: [first, second] }))
    expect(result.ok && result.layout.customFields?.map((field) => field.label)).toEqual([
      'PO',
      'Customer ID',
    ])
  })
})

describe('isHexColor', () => {
  it('takes #RRGGBB in either case and nothing else', () => {
    expect(isHexColor('#1a1A21')).toBe(true)
    for (const value of ['', '#12345', '1a1a21', '#12345g', '#1a1a2100', 'red']) {
      expect(isHexColor(value)).toBe(false)
    }
  })
})

describe('separators', () => {
  const line: Separator = newSeparator(1, PAGE, ID_A)

  it('starts horizontal in the middle of the current page', () => {
    expect(line).toEqual({
      id: ID_A,
      page: 1,
      x: 198,
      y: 421,
      length: 200,
      orientation: 'horizontal',
      thickness: 0.75,
      color: DEFAULT_BORDER_COLOR,
    })
  })

  it('keeps a moved line on the page', () => {
    expect(moveSeparator(line, -500, 10, PAGE)).toEqual({ x: 0, y: 431 })
    expect(moveSeparator(line, 900, 900, PAGE)).toEqual({ x: 594, y: 841 })
  })

  it('resizes along the length only', () => {
    expect(resizeSeparator(line, 50, 999, PAGE)).toEqual({ length: 250 })
    const vertical: Separator = { ...line, orientation: 'vertical' }
    expect(resizeSeparator(vertical, 999, 50, PAGE)).toEqual({ length: 250 })
  })

  it('keeps the length within the page and the schema', () => {
    expect(resizeSeparator(line, -999, 0, PAGE)).toEqual({ length: 10 })
    expect(resizeSeparator(line, 999, 0, PAGE)).toEqual({ length: 397 })
    const large = { width: 4000, height: 4000 }
    expect(resizeSeparator(line, 3000, 0, large)).toEqual({ length: 2000 })
  })
})

describe('custom items', () => {
  const field = (id: string, order: number) => ({ ...newCustomField([], id), order })

  it('adds after the highest order, starting from zero', () => {
    expect(newCustomField([], ID_A).order).toBe(0)
    expect(newCustomField([field(ID_A, 4), field(ID_B, 2)], ID_B).order).toBe(5)
    expect(newCustomField([field(ID_A, 999)], ID_B).order).toBe(999)
    expect(newCustomField([field(ID_A, Number.NaN)], ID_B).order).toBe(0)
  })

  it('sorts by order and puts a half-typed order last', () => {
    const rows = [field(ID_A, Number.NaN), field(ID_B, 3)]
    expect(sortFields(rows).map((row) => row.id)).toEqual([ID_B, ID_A])
  })

  it('explains an item whose block is not on the page', () => {
    const mapped = new Set(['customer'] as const)
    expect(customFieldNote({ region: 'customer', required: true }, mapped)).toBeNull()
    expect(customFieldNote({ region: 'notes', required: true }, mapped)).toContain('blocks issue')
    expect(customFieldNote({ region: 'notes', required: false }, mapped)).toContain('not print')
  })
})
