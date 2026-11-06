import fs from 'node:fs'
import path from 'node:path'
import { type Color, PDFDocument, type PDFPage, rgb } from '@cantoo/pdf-lib'
import * as fontkit from 'fontkit'
import {
  type ColumnKey,
  DEFAULT_BORDER_COLOR,
  DEFAULT_STYLE,
  type Region,
  type RegionKey,
  type RenderLine,
  type RenderPayload,
  type Separator,
  type TableColumn,
  type TemplateStyle,
} from '../../shared/render.ts'
import { ApiError } from '../errors.ts'
import {
  type BlockLine,
  drawLine,
  Face,
  type Fonts,
  fitBlock,
  lineHeight,
  textWidth,
  wrapText,
} from './text.ts'

const FONT_DIR = path.join(import.meta.dirname, 'fonts')
const regularBytes = fs.readFileSync(path.join(FONT_DIR, 'IBMPlexSansArabic-Regular.woff'))
const boldBytes = fs.readFileSync(path.join(FONT_DIR, 'IBMPlexSansArabic-SemiBold.woff'))

/** Turns a #RRGGBB value, already validated by the schema, into a PDF color. */
export function colorFromHex(hex: string): Color {
  const channel = (start: number) => Number.parseInt(hex.slice(start, start + 2), 16) / 255
  return rgb(channel(1), channel(3), channel(5))
}

const RULE = colorFromHex(DEFAULT_BORDER_COLOR)
const CELL_PADDING = 3
const LINE_THICKNESS = 0.6

interface FontFile {
  regular: Uint8Array
  bold: Uint8Array | null
}

async function embedTypeface(doc: PDFDocument, bytes: Uint8Array) {
  const parsed = fontkit.create(bytes)
  return {
    font: await doc.embedFont(bytes, { subset: true }),
    covers: (codePoint: number): boolean => parsed.hasGlyphForCodePoint(codePoint),
  }
}

async function embedBundled(doc: PDFDocument) {
  doc.registerFontkit(fontkit as never)
  return {
    regular: await embedTypeface(doc, regularBytes),
    bold: await embedTypeface(doc, boldBytes),
  }
}

export async function embedFonts(doc: PDFDocument): Promise<Fonts> {
  const bundled = await embedBundled(doc)
  return { regular: new Face(bundled.regular), bold: new Face(bundled.bold) }
}

/** Embeds the fonts this render uses. Each font is a subset, and IBM Plex is the fallback. */
async function embedForRegions(
  doc: PDFDocument,
  fontIds: Set<number>,
  fontFiles: Map<number, FontFile> | undefined,
) {
  const bundled = await embedBundled(doc)
  const standard = { regular: new Face(bundled.regular), bold: new Face(bundled.bold) }
  const chosen = new Map<number, Fonts>()
  for (const id of fontIds) {
    const files = fontFiles?.get(id)
    if (!files) continue
    const regular = await embedTypeface(doc, files.regular)
    const bold = files.bold ? await embedTypeface(doc, files.bold) : regular
    chosen.set(id, {
      regular: new Face(regular, bundled.regular),
      bold: new Face(bold, bundled.bold),
    })
  }
  return (id: number | null) => (id !== null && chosen.get(id)) || standard
}

export interface TemplateInfo {
  pageCount: number
  pages: { width: number; height: number }[]
}

/** Rejects PDFs the engine cannot place text on reliably. */
export async function inspectTemplate(bytes: Uint8Array): Promise<TemplateInfo> {
  let doc: PDFDocument
  try {
    doc = await PDFDocument.load(bytes)
  } catch (error) {
    if (error instanceof Error && /encrypt/i.test(error.message)) {
      throw new ApiError(422, 'This PDF is password protected. Remove the password and upload it.')
    }
    throw new ApiError(422, 'This PDF could not be read. Save it again and upload the new copy.')
  }
  const pages = doc.getPages()
  if (pages.some((page) => page.getRotation().angle % 360 !== 0)) {
    throw new ApiError(422, 'This PDF has rotated pages. Save it upright and upload it again.')
  }
  return {
    pageCount: pages.length,
    pages: pages.map((page) => {
      const box = page.getCropBox()
      return { width: box.width, height: box.height }
    }),
  }
}

/** Tax columns drop out when an invoice has no tax, and description takes their width. */
export function activeColumns(
  columns: TableColumn[],
  taxEnabled: boolean,
  regionWidth: number,
): TableColumn[] {
  const removed = columns.filter((column) => column.taxOnly && !taxEnabled)
  const freed = removed.reduce((sum, column) => sum + column.width, 0)
  const active = columns
    .filter((column) => taxEnabled || !column.taxOnly)
    .map((column) => ({
      ...column,
      width: column.key === 'description' ? column.width + freed : column.width,
    }))
  const total = active.reduce((sum, column) => sum + column.width, 0)
  if (total <= regionWidth) return active
  const scale = regionWidth / total
  return active.map((column) => ({ ...column, width: column.width * scale }))
}

const CELL_VALUE: Record<ColumnKey, (line: RenderLine) => string> = {
  description: (line) => line.description,
  quantity: (line) => line.quantity,
  unit_price: (line) => line.unitPrice,
  tax_rate: (line) => line.taxRate,
  tax_amount: (line) => line.taxAmount,
  total: (line) => line.total,
}

interface Row {
  cells: { lines: string[]; column: TableColumn; x: number }[]
  height: number
}

function buildRows(
  lines: RenderLine[],
  columns: TableColumn[],
  face: Face,
  size: number,
  rowHeight: number,
  multiplier: number,
): Row[] {
  return lines.map((line) => {
    let x = 0
    const cells = columns.map((column) => {
      const wrapped = wrapText(
        CELL_VALUE[column.key](line),
        face,
        size,
        column.width - CELL_PADDING * 2,
      )
      const cell = { lines: wrapped, column, x }
      x += column.width
      return cell
    })
    const lineCount = Math.max(...cells.map((cell) => cell.lines.length))
    const textHeight = lineCount * lineHeight(size, multiplier)
    return { cells, height: Math.max(rowHeight, textHeight + 6) }
  })
}

function paginate(rows: Row[], available: number): Row[][] {
  const pages: Row[][] = [[]]
  let used = 0
  for (const row of rows) {
    const current = pages[pages.length - 1]
    if (used + row.height > available && current.length > 0) {
      pages.push([row])
      used = row.height
    } else {
      current.push(row)
      used += row.height
    }
  }
  return pages
}

class Canvas {
  page: PDFPage
  originX: number
  top: number
  constructor(page: PDFPage) {
    this.page = page
    const box = page.getCropBox()
    this.originX = box.x
    this.top = box.y + box.height
  }
  x(value: number) {
    return this.originX + value
  }
  y(value: number) {
    return this.top - value
  }
}

function alignedX(
  left: number,
  width: number,
  textW: number,
  align: 'left' | 'center' | 'right',
): number {
  if (align === 'right') return left + width - textW
  if (align === 'center') return left + (width - textW) / 2
  return left
}

interface RegionStyle {
  fonts: Fonts
  color: Color
  lineHeight: number
  /** How far this line height is from the default, for rows sized from the font. */
  scale: number
}

function drawBlock(canvas: Canvas, region: Region, lines: BlockLine[], style: RegionStyle) {
  const { fonts, color } = style
  const { size, wrapped } = fitBlock(
    lines,
    fonts,
    region.fontSize,
    region.width,
    region.height,
    style.lineHeight,
  )
  let cursor = region.y + size
  for (const line of wrapped) {
    if (cursor > region.y + region.height + size * 0.4) break
    const x = alignedX(region.x, region.width, textWidth(line.text, line.face, size), region.align)
    drawLine(canvas.page, line.text, canvas.x(x), canvas.y(cursor), line.face, size, color)
    cursor += lineHeight(size, style.lineHeight)
  }
}

function drawRule(canvas: Canvas, from: [number, number], to: [number, number], color: Color) {
  canvas.page.drawLine({
    start: { x: canvas.x(from[0]), y: canvas.y(from[1]) },
    end: { x: canvas.x(to[0]), y: canvas.y(to[1]) },
    thickness: LINE_THICKNESS,
    color,
  })
}

/** Lines stop at the last row on this page, not at the bottom of the region. */
function drawBorders(
  canvas: Canvas,
  region: Region,
  columns: TableColumn[],
  rows: Row[],
  headerHeight: number,
) {
  const color = colorFromHex(region.borderColor ?? DEFAULT_BORDER_COLOR)
  const mode = region.borders ?? 'none'
  const left = region.x
  const right = left + columns.reduce((sum, column) => sum + column.width, 0)
  const top = region.y
  const rowsTop = top + headerHeight

  if (mode === 'none') {
    if (headerHeight > 0) drawRule(canvas, [left, rowsTop], [right, rowsTop], color)
    return
  }

  const bottom = rows.reduce((y, row) => y + row.height, rowsTop)
  if (mode === 'horizontal' || mode === 'both') {
    const edges = [top]
    if (headerHeight > 0) edges.push(rowsTop)
    let y = rowsTop
    for (const row of rows) {
      y += row.height
      edges.push(y)
    }
    for (const edge of edges) drawRule(canvas, [left, edge], [right, edge], color)
  }
  if (mode === 'vertical' || mode === 'both') {
    let x = left
    drawRule(canvas, [x, top], [x, bottom], color)
    for (const column of columns) {
      x += column.width
      drawRule(canvas, [x, top], [x, bottom], color)
    }
  }
}

function drawTable(
  canvas: Canvas,
  region: Region,
  columns: TableColumn[],
  rows: Row[],
  style: RegionStyle,
  headerHeight: number,
) {
  const { fonts, color } = style
  const size = region.fontSize
  const line = lineHeight(size, style.lineHeight)
  // The first line sits in the middle of its taller or shorter line box.
  const leading = (line - lineHeight(size, DEFAULT_STYLE.lineHeight)) / 2
  let cursor = region.y
  if (region.showHeader !== false) {
    let x = region.x
    for (const column of columns) {
      const textW = textWidth(column.label, fonts.bold, size)
      const textX = alignedX(x + CELL_PADDING, column.width - CELL_PADDING * 2, textW, column.align)
      const baseline = canvas.y(cursor + (headerHeight + size) / 2 - 1)
      drawLine(canvas.page, column.label, canvas.x(textX), baseline, fonts.bold, size, color)
      x += column.width
    }
    cursor += headerHeight
  }
  for (const row of rows) {
    for (const cell of row.cells) {
      let baseline = cursor + size + 3 + leading
      for (const text of cell.lines) {
        const textW = textWidth(text, fonts.regular, size)
        const textX = alignedX(
          region.x + cell.x + CELL_PADDING,
          cell.column.width - CELL_PADDING * 2,
          textW,
          cell.column.align,
        )
        drawLine(canvas.page, text, canvas.x(textX), canvas.y(baseline), fonts.regular, size, color)
        baseline += line
      }
    }
    cursor += row.height
  }
  drawBorders(canvas, region, columns, rows, headerHeight)
}

function drawTotals(
  canvas: Canvas,
  region: Region,
  totals: RenderPayload['totals'],
  style: RegionStyle,
) {
  const { fonts, color, scale } = style
  const rowHeight = Math.min(
    region.fontSize * 1.7 * scale,
    region.height / Math.max(totals.length, 1),
  )
  const size = Math.min(region.fontSize, rowHeight / (1.3 * scale))
  let cursor = region.y
  for (const row of totals) {
    const face = row.strong ? fonts.bold : fonts.regular
    if (row.strong) {
      drawRule(canvas, [region.x, cursor], [region.x + region.width, cursor], RULE)
    }
    const baseline = canvas.y(cursor + (rowHeight + size) / 2 - 1)
    drawLine(canvas.page, row.label, canvas.x(region.x), baseline, face, size, color)
    const valueX = region.x + region.width - textWidth(row.value, face, size)
    drawLine(canvas.page, row.value, canvas.x(valueX), baseline, face, size, color)
    cursor += rowHeight
  }
}

function drawSeparator(canvas: Canvas, separator: Separator) {
  const { x, y, length, orientation, thickness, color } = separator
  canvas.page.drawLine({
    start: { x: canvas.x(x), y: canvas.y(y) },
    end:
      orientation === 'horizontal'
        ? { x: canvas.x(x + length), y: canvas.y(y) }
        : { x: canvas.x(x), y: canvas.y(y + length) },
    thickness,
    color: colorFromHex(color),
  })
}

async function drawLogo(doc: PDFDocument, canvas: Canvas, region: Region, logo: Uint8Array) {
  const isPng = logo[0] === 0x89
  const image = isPng ? await doc.embedPng(logo) : await doc.embedJpg(logo)
  const scale = Math.min(region.width / image.width, region.height / image.height, 1)
  const width = image.width * scale
  const height = image.height * scale
  const x = alignedX(region.x, region.width, width, region.align)
  canvas.page.drawImage(image, {
    x: canvas.x(x),
    y: canvas.y(region.y + height),
    width,
    height,
  })
}

function blockFor(key: RegionKey, payload: RenderPayload): BlockLine[] | null {
  const custom = payload.customItems
    .filter((item) => item.region === key)
    .map((item) => ({ text: `${item.label}: ${item.value}` }))
  switch (key) {
    case 'document_title':
      return [{ text: payload.title, bold: true }]
    case 'document_meta':
      return [...payload.meta.map((row) => ({ text: `${row.label}: ${row.value}` })), ...custom]
    case 'customer':
      return [
        ...payload.customerLines.map((text, index) => ({ text, bold: index === 0 })),
        ...custom,
      ]
    case 'tax_details':
      return payload.taxEnabled ? payload.taxLines.map((text) => ({ text })) : null
    case 'company': {
      const lines: BlockLine[] = [{ text: payload.company.name, bold: true }]
      if (payload.company.address) lines.push({ text: payload.company.address })
      if (payload.company.taxNumber) {
        lines.push({ text: `Tax number: ${payload.company.taxNumber}` })
      }
      return [...lines, ...custom]
    }
    case 'notes': {
      const lines = [...(payload.notes ? [{ text: payload.notes }] : []), ...custom]
      return lines.length ? lines : null
    }
    default:
      return null
  }
}

const FIRST_PAGE_ONLY: RegionKey[] = ['customer']
const LAST_PAGE_ONLY: RegionKey[] = ['totals', 'tax_details', 'notes']

export interface RenderInput {
  templatePdf: Uint8Array
  regions: Region[]
  logo?: Uint8Array | null
  payload: RenderPayload
  style?: TemplateStyle
  separators?: Separator[]
  /** Uploaded fonts by id. An id with no entry here draws with bundled IBM Plex. */
  fontFiles?: Map<number, FontFile>
}

/** Every font id a render needs. Logos print no text. */
export function fontIdsFor(regions: Region[], style: TemplateStyle): Set<number> {
  const ids = regions
    .filter((region) => region.key !== 'logo')
    .map((region) => region.fontId ?? style.fontId)
  return new Set(ids.filter((id) => id !== null))
}

export async function renderDocument({
  templatePdf,
  regions,
  logo,
  payload,
  style = DEFAULT_STYLE,
  separators = [],
  fontFiles,
}: RenderInput): Promise<Uint8Array> {
  const doc = await PDFDocument.load(templatePdf)
  const fontsFor = await embedForRegions(doc, fontIdsFor(regions, style), fontFiles)
  const table = regions.find((region) => region.key === 'line_table')
  if (!table) throw new ApiError(422, 'This template has no content table mapped')

  const styleFor = (region: Region): RegionStyle => {
    const multiplier = region.lineHeight ?? style.lineHeight
    return {
      fonts: fontsFor(region.fontId ?? style.fontId),
      color: colorFromHex(region.color ?? style.textColor),
      lineHeight: multiplier,
      scale: multiplier / DEFAULT_STYLE.lineHeight,
    }
  }

  const tableStyle = styleFor(table)
  const columns = activeColumns(table.columns ?? [], payload.taxEnabled, table.width)
  const rowHeight = table.rowHeight ?? 20
  const headerHeight =
    table.showHeader === false ? 0 : Math.max(rowHeight, table.fontSize * 2 * tableStyle.scale)
  const rows = buildRows(
    payload.lines,
    columns,
    tableStyle.fonts.regular,
    table.fontSize,
    rowHeight,
    tableStyle.lineHeight,
  )
  const chunks = paginate(rows, table.height - headerHeight)
  const extraPages = chunks.length - 1

  if (extraPages > 0) {
    // Each page gets its own copy call. Copies from one call share a content stream,
    // so drawing on one would print on all of them.
    const pristine = await PDFDocument.load(templatePdf)
    for (let index = 0; index < extraPages; index += 1) {
      const [copy] = await doc.copyPages(pristine, [table.page])
      doc.insertPage(table.page + 1 + index, copy)
    }
  }

  const pageTotal = doc.getPageCount()
  // Anything on the table's page repeats on its continuation pages, and later pages move back.
  const pagesFor = (page: number) => {
    if (page === table.page) return chunks.map((_, index) => table.page + index)
    return [page < table.page ? page : page + extraPages]
  }

  for (let index = 0; index < chunks.length; index += 1) {
    const canvas = new Canvas(doc.getPage(table.page + index))
    drawTable(canvas, table, columns, chunks[index], tableStyle, headerHeight)
  }

  for (const separator of separators) {
    for (const pageIndex of pagesFor(separator.page)) {
      if (pageIndex < pageTotal) drawSeparator(new Canvas(doc.getPage(pageIndex)), separator)
    }
  }

  for (const region of regions) {
    if (region.key === 'line_table') continue
    const repeats = region.page === table.page
    const regionStyle = styleFor(region)
    for (const pageIndex of pagesFor(region.page)) {
      if (pageIndex >= pageTotal) continue
      const chunkIndex = pageIndex - table.page
      if (repeats && FIRST_PAGE_ONLY.includes(region.key) && chunkIndex !== 0) continue
      if (repeats && LAST_PAGE_ONLY.includes(region.key) && chunkIndex !== extraPages) continue

      const canvas = new Canvas(doc.getPage(pageIndex))
      if (region.key === 'totals') {
        drawTotals(canvas, region, payload.totals, regionStyle)
      } else if (region.key === 'logo') {
        if (logo) await drawLogo(doc, canvas, region, logo)
      } else {
        const pagePayload =
          region.key === 'document_meta' && extraPages > 0 && repeats
            ? {
                ...payload,
                meta: [
                  ...payload.meta,
                  { label: 'Page', value: `${chunkIndex + 1} of ${chunks.length}` },
                ],
              }
            : payload
        const lines = blockFor(region.key, pagePayload)
        if (lines) drawBlock(canvas, region, lines, regionStyle)
      }
    }
  }
  return doc.save()
}
