import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PDFDocument, type PDFFont } from '@cantoo/pdf-lib'
import { describe, expect, it } from 'vitest'
import type { CustomField, Region, RenderPayload, Separator } from '../../shared/render.ts'
import { activeColumns, inspectTemplate, type RenderInput, renderDocument } from './engine.ts'
import { samplePayload } from './sample.ts'
import { buildSystemTemplatePdf, SYSTEM_REGIONS } from './system-template.ts'
import {
  countInBox,
  embeddedFonts,
  fixtureFont,
  isBlue,
  isRed,
  pagePixels,
  pdfText,
  redAcross,
  redDown,
  textIn,
  wordHeight,
  wordTop,
} from './test-helpers.ts'
import { Face, visualRuns } from './text.ts'

const company = { name: 'MG Trading', address: 'Muscat', taxNumber: 'OM99' }
const options = { tax: true, long: false, arabic: false }
const uuid = (digit: number) => `00000000-0000-4000-8000-00000000000${digit}`

const LATIN_TTF = 1
const LATIN_OTF = 2
const fontFiles = new Map([
  [LATIN_TTF, { regular: fixtureFont('test-fonts/latin-only.ttf'), bold: null }],
  [LATIN_OTF, { regular: fixtureFont('test-fonts/latin-only.otf'), bold: null }],
])

const regionsWith = (key: Region['key'], patch: Partial<Region>) =>
  SYSTEM_REGIONS.map((region) => (region.key === key ? { ...region, ...patch } : region))

const boxOf = (key: Region['key']) => {
  const region = SYSTEM_REGIONS.find((item) => item.key === key)
  if (!region) throw new Error(`No region ${key}`)
  return region
}

async function render(over: Partial<RenderInput> = {}, sample = options, notes = '') {
  return renderDocument({
    templatePdf: await buildSystemTemplatePdf(),
    regions: SYSTEM_REGIONS,
    payload: samplePayload(company, notes, '5', sample),
    ...over,
  })
}

const style = { textColor: '#1a1a21', lineHeight: 1.32, fontId: null }

/** Positions read from pixels land within a point of the drawn line. */
const expectNear = (actual: number, expected: number) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1)

describe('pdf engine', () => {
  it('renders on the system template', async () => {
    const templatePdf = await buildSystemTemplatePdf()
    const bytes = await renderDocument({
      templatePdf,
      regions: SYSTEM_REGIONS,
      payload: samplePayload(company, 'Bank: Example', '5', {
        tax: true,
        long: false,
        arabic: true,
      }),
    })
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(1)
  })

  it('continues long tables on more pages', async () => {
    const templatePdf = await buildSystemTemplatePdf()
    const bytes = await renderDocument({
      templatePdf,
      regions: SYSTEM_REGIONS,
      payload: samplePayload(company, '', '5', { tax: true, long: true, arabic: false }),
    })
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(1)
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-')), 'long.pdf')
    fs.writeFileSync(file, bytes)
    const text = execFileSync('pdftotext', ['-layout', file, '-']).toString()
    for (let row = 1; row <= 45; row += 1) {
      expect(text.split(`(${row})`).length - 1).toBe(1)
    }
    expect(text.split('Subtotal').length - 1).toBe(1)
  })

  it('gives tax column widths to description when tax is off', () => {
    const table = SYSTEM_REGIONS.find((region) => region.key === 'line_table')
    const columns = table?.columns ?? []
    const withTax = activeColumns(columns, true, 515)
    const withoutTax = activeColumns(columns, false, 515)
    expect(withTax.map((column) => column.key)).toContain('tax_amount')
    expect(withoutTax.map((column) => column.key)).not.toContain('tax_amount')
    expect(withoutTax[0].width).toBe(withTax[0].width + 95)
  })

  it('reads PDFs with compressed object streams', async () => {
    const doc = await PDFDocument.create()
    doc.addPage([595, 842])
    const bytes = await doc.save({ useObjectStreams: true })
    expect((await inspectTemplate(bytes)).pageCount).toBe(1)
  })

  it('rejects unreadable and rotated PDFs', async () => {
    await expect(inspectTemplate(new TextEncoder().encode('%PDF-1.4 nope'))).rejects.toThrow()
    const doc = await PDFDocument.create()
    const page = doc.addPage()
    const { degrees } = await import('@cantoo/pdf-lib')
    page.setRotation(degrees(90))
    await expect(inspectTemplate(await doc.save())).rejects.toThrow(/rotated/)
  })

  it('orders mixed Arabic and Latin text visually', () => {
    expect(visualRuns('Invoice 123')).toEqual(['Invoice 123'])
    const runs = visualRuns('الرقم 123')
    expect(runs).toHaveLength(2)
    expect(runs[0]).toBe('123')
  })

  it('has no cost or provider fields in the render payload', () => {
    const payload: RenderPayload = samplePayload(company, '', '5', {
      tax: true,
      long: false,
      arabic: false,
    })
    const keys = JSON.stringify(payload).toLowerCase()
    expect(keys).not.toContain('cost')
    expect(keys).not.toContain('provider')
  })
})

describe('template styles', () => {
  it('uses the template color, and a region color beats it', async () => {
    const bytes = await render({
      regions: regionsWith('document_title', { color: '#ff0000' }),
      style: { ...style, textColor: '#0000ff' },
    })
    const pixels = pagePixels(bytes)
    const title = boxOf('document_title')
    expect(countInBox(pixels, title, isRed)).toBeGreaterThan(50)
    expect(countInBox(pixels, title, isBlue)).toBe(0)
    expect(countInBox(pixels, boxOf('customer'), isBlue)).toBeGreaterThan(50)
    expect(countInBox(pixels, boxOf('customer'), isRed)).toBe(0)
    expect(countInBox(pixels, boxOf('totals'), isBlue)).toBeGreaterThan(50)
    expect(countInBox(pixels, boxOf('line_table'), isBlue)).toBeGreaterThan(50)
  })

  it('uses the template line height, and a region line height beats it', async () => {
    const bytes = await render({
      regions: regionsWith('customer', { lineHeight: 1.5 }),
      style: { ...style, lineHeight: 2 },
    })
    expect(wordTop(bytes, 'Sara') - wordTop(bytes, 'Example')).toBeCloseTo(15, 0)
    expect(wordTop(bytes, 'Muscat') - wordTop(bytes, 'MG')).toBeCloseTo(18, 0)
  })

  it('grows table rows and totals with the line height', async () => {
    const before = await render()
    const after = await render({ style: { ...style, lineHeight: 3 } })
    expect(wordTop(before, 'Domain') - wordTop(before, 'Dedicated')).toBeCloseTo(20, 0)
    expect(wordTop(after, 'Domain') - wordTop(after, 'Dedicated')).toBeCloseTo(33, 0)
    const gap = (bytes: Uint8Array) => wordTop(bytes, 'Total') - wordTop(bytes, 'Subtotal')
    expect(gap(after)).toBeGreaterThan(gap(before))
  })

  it('does not shrink a single line that fits when the line height is large', async () => {
    const before = await render()
    const after = await render({ style: { ...style, lineHeight: 3 } })
    expect(wordHeight(after, 'Invoice')).toBeCloseTo(wordHeight(before, 'Invoice'), 1)
  })

  it('uses the template font, and a region font beats it', async () => {
    const whole = await render({ style: { ...style, fontId: LATIN_TTF }, fontFiles })
    expect(embeddedFonts(whole)).toContain('FixtureLatin-Regular')
    expect(pdfText(whole)).toContain('Example Trading LLC')

    const mixed = await render({
      regions: regionsWith('customer', { fontId: LATIN_OTF }),
      style: { ...style, fontId: LATIN_TTF },
      fontFiles,
    })
    expect(embeddedFonts(mixed)).toContain('FixtureLatinOTF-Regular')
    expect(embeddedFonts(mixed)).toContain('FixtureLatin-Regular')
    expect(pdfText(mixed)).toContain('Example Trading LLC')
  })

  it('embeds only the fonts the render uses', async () => {
    const regions = SYSTEM_REGIONS.map((region) => ({ ...region, fontId: LATIN_OTF }))
    const fonts = embeddedFonts(
      await render({ regions, style: { ...style, fontId: LATIN_TTF }, fontFiles }),
    )
    expect(fonts).toContain('FixtureLatinOTF-Regular')
    expect(fonts).not.toContain('FixtureLatin-Regular')
    expect(embeddedFonts(await render())).not.toContain('Fixture')
  })

  it('draws characters the font lacks with IBM Plex', async () => {
    const latin = await render(
      { style: { ...style, fontId: LATIN_TTF }, fontFiles },
      { ...options, arabic: true },
    )
    const plex = await render({}, { ...options, arabic: true })
    const words = (bytes: Uint8Array) => pdfText(bytes).split(/\s+/).sort()
    expect(words(latin)).toEqual(words(plex))
    expect(embeddedFonts(latin)).toContain('IBMPlexSansArabic')
    expect(embeddedFonts(latin)).toContain('FixtureLatin-Regular')
  })

  it('keeps an Arabic phrase in one run on a font without Arabic', () => {
    const latinFont = { name: 'latin' } as unknown as PDFFont
    const plexFont = { name: 'plex' } as unknown as PDFFont
    const face = new Face(
      { font: latinFont, covers: (codePoint) => codePoint < 0x80 },
      { font: plexFont, covers: () => true },
    )
    const name = (font: PDFFont) => (font === latinFont ? 'latin' : 'plex')
    const runs = (text: string) => face.runs(text).map((run) => [run.text, name(run.font)])
    expect(runs('Plain text.')).toEqual([['Plain text.', 'latin']])
    expect(runs('شركة المثال')).toEqual([['شركة المثال', 'plex']])
    expect(runs('caf\u00e9')).toEqual([
      ['caf', 'latin'],
      ['\u00e9', 'plex'],
    ])
    expect(runs('Name شركة')).toEqual([
      ['Name ', 'latin'],
      ['شركة', 'plex'],
    ])
  })
})

describe('table borders', () => {
  const table = boxOf('line_table')
  const left = table.x
  const right = left + 515
  const headerBottom = table.y + 20
  const insideColumn = left + 215
  const insideHeader = table.y + 5
  const borders = (mode: Region['borders'], over: Partial<Region> = {}) =>
    regionsWith('line_table', { borders: mode, borderColor: '#ff0000', ...over })

  it('keeps one colored rule under the header with none', async () => {
    const pixels = pagePixels(await render({ regions: borders('none') }))
    const lines = redDown(pixels, insideColumn)
    expect(lines).toHaveLength(1)
    expectNear(lines[0].start, headerBottom)
    expect(redAcross(pixels, insideHeader)).toHaveLength(0)
  })

  it('draws lines above the header, between rows and below the last row', async () => {
    const pixels = pagePixels(await render({ regions: borders('horizontal') }))
    const lines = redDown(pixels, insideColumn)
    expect(lines.map((line) => Math.round(line.end))).toEqual([270, 290, 310, 330])
    expect(redAcross(pixels, insideHeader)).toHaveLength(0)
  })

  it('draws a line at each column edge, ending at the last row', async () => {
    const pixels = pagePixels(await render({ regions: borders('vertical') }))
    expect(redDown(pixels, insideColumn)).toHaveLength(0)
    const edges = redAcross(pixels, insideHeader)
    expect(edges).toHaveLength(7)
    expectNear(edges[0].start, left)
    expectNear(edges[6].end, right)
    const edge = redDown(pixels, left)
    expect(edge).toHaveLength(1)
    expectNear(edge[0].start, table.y)
    expectNear(edge[0].end, 330)
  })

  it('draws a grid across the header and the rows with both', async () => {
    const pixels = pagePixels(await render({ regions: borders('both') }))
    expect(redDown(pixels, insideColumn)).toHaveLength(4)
    expect(redAcross(pixels, insideHeader)).toHaveLength(7)
    expect(redAcross(pixels, 300)).toHaveLength(7)
  })

  it('starts at the first row when the header is hidden', async () => {
    const regions = borders('both', { showHeader: false })
    const lines = redDown(pagePixels(await render({ regions })), insideColumn)
    expect(lines.map((line) => Math.round(line.end))).toEqual([270, 290, 310])
    const none = borders('none', { showHeader: false })
    expect(redDown(pagePixels(await render({ regions: none })), insideColumn)).toHaveLength(0)
  })

  it('ends at the last row of each page when the table overflows', async () => {
    const sample = { ...options, long: true }
    for (const [mode, rules] of [
      ['horizontal', true],
      ['both', true],
      ['vertical', false],
    ] as const) {
      const bytes = await render({ regions: borders(mode) }, sample)
      const full = pagePixels(bytes, 0)
      const last = pagePixels(bytes, 2)
      if (rules) {
        expect(redDown(full, insideColumn)).toHaveLength(18)
        expect(redDown(last, insideColumn)).toHaveLength(15)
        expect(Math.round(redDown(last, insideColumn)[14].end)).toBe(550)
      }
      if (mode !== 'horizontal') {
        expect(Math.round(redDown(full, left)[0].end)).toBe(610)
        expect(Math.round(redDown(last, left)[0].end)).toBe(550)
      }
    }
  })
})

describe('separators', () => {
  const across: Separator = {
    id: uuid(1),
    page: 0,
    x: 100,
    y: 170,
    length: 200,
    orientation: 'horizontal',
    thickness: 2,
    color: '#ff0000',
  }
  const down: Separator = {
    ...across,
    id: uuid(2),
    x: 20,
    y: 300,
    length: 100,
    orientation: 'vertical',
  }

  it('prints where placed, in both directions', async () => {
    const pixels = pagePixels(await render({ separators: [across, down] }))
    const horizontal = redAcross(pixels, 170)
    expectNear(horizontal[0].start, 100)
    expectNear(horizontal[0].end, 300)
    const vertical = redDown(pixels, 20)
    expectNear(vertical[0].start, 300)
    expectNear(vertical[0].end, 400)
  })

  it('repeats on continuation pages of the table', async () => {
    const bytes = await render({ separators: [across] }, { ...options, long: true })
    for (const page of [0, 1, 2]) {
      expect(redAcross(pagePixels(bytes, page), 170)).toHaveLength(1)
    }
  })

  it('moves back with later pages when the table overflows', async () => {
    const doc = await PDFDocument.create()
    doc.addPage([595, 842])
    doc.addPage([595, 842])
    const bytes = await render(
      {
        templatePdf: await doc.save(),
        separators: [{ ...across, page: 1 }],
      },
      { ...options, long: true },
    )
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(4)
    for (const page of [0, 1, 2]) {
      expect(redAcross(pagePixels(bytes, page), 170)).toHaveLength(0)
    }
    expect(redAcross(pagePixels(bytes, 3), 170)).toHaveLength(1)
  })
})

describe('custom items', () => {
  const field = (
    digit: number,
    region: CustomField['region'],
    label: string,
    type: CustomField['type'] = 'text',
  ): CustomField => ({ id: uuid(digit), label, type, required: false, order: digit, region })

  it('prints each item in its region, after the built-in lines', async () => {
    const fields = [
      field(1, 'document_meta', 'PO'),
      field(2, 'customer', 'Customer ID', 'number'),
      field(3, 'company', 'License', 'date'),
      field(4, 'notes', 'Reference'),
    ]
    const payload = samplePayload(company, 'Bank: Example', '5', options, fields)
    const bytes = await render({ payload })
    const inRegion = (key: Region['key']) => textIn(bytes, boxOf(key))
    expect(inRegion('document_meta')).toContain('PO: ABC-123')
    expect(inRegion('customer')).toContain('Customer ID: 1000')
    expect(inRegion('company')).toContain('License: 2026-11-01')
    expect(inRegion('notes')).toContain('Reference: ABC-123')
    const notes = inRegion('notes')
    expect(notes.indexOf('Reference')).toBeGreaterThan(notes.indexOf('Bank'))
    const meta = inRegion('document_meta')
    expect(meta.indexOf('PO')).toBeGreaterThan(meta.indexOf('Due date'))
  })

  it('prints items in their set order', async () => {
    const fields = [
      { ...field(1, 'customer', 'Second'), order: 5 },
      { ...field(2, 'customer', 'First'), order: 1 },
    ]
    const payload = samplePayload(company, '', '5', options, fields)
    const customer = textIn(await render({ payload }), boxOf('customer'))
    expect(customer.indexOf('First')).toBeLessThan(customer.indexOf('Second'))
  })

  it('prints notes that hold only custom items', async () => {
    const payload = samplePayload(company, '', '5', options, [field(1, 'notes', 'Reference')])
    expect(textIn(await render({ payload }), boxOf('notes'))).toContain('Reference: ABC-123')
  })
})
