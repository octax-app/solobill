import { PDFDocument, rgb } from '@cantoo/pdf-lib'
import { DEFAULT_COLUMNS, type Region } from '../../shared/render.ts'
import { embedFonts } from './engine.ts'
import { drawLine } from './text.ts'

/** A clean A4 page. The owner's details are drawn by the same engine as uploaded templates. */
export async function buildSystemTemplatePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const fonts = await embedFonts(doc)
  const page = doc.addPage([595, 842])
  const rule = rgb(0.17, 0.2, 0.47)
  page.drawRectangle({ x: 0, y: 830, width: 595, height: 12, color: rule })
  drawLine(page, 'Bill to', 40, 842 - 176, fonts.bold, 9, rgb(0.1, 0.1, 0.13))
  page.drawLine({
    start: { x: 40, y: 40 },
    end: { x: 555, y: 40 },
    thickness: 0.5,
    color: rgb(0.72, 0.74, 0.78),
  })
  return doc.save()
}

const base = { page: 0, align: 'left', fontSize: 10 } as const

export const SYSTEM_REGIONS: Region[] = [
  { ...base, key: 'logo', x: 40, y: 34, width: 130, height: 48 },
  { ...base, key: 'company', x: 40, y: 88, width: 250, height: 70, fontSize: 9 },
  {
    ...base,
    key: 'document_title',
    x: 310,
    y: 36,
    width: 245,
    height: 32,
    fontSize: 20,
    align: 'right',
  },
  {
    ...base,
    key: 'document_meta',
    x: 310,
    y: 76,
    width: 245,
    height: 70,
    fontSize: 9,
    align: 'right',
  },
  { ...base, key: 'customer', x: 40, y: 182, width: 300, height: 76 },
  {
    ...base,
    key: 'line_table',
    x: 40,
    y: 270,
    width: 515,
    height: 350,
    fontSize: 9,
    rowHeight: 20,
    showHeader: true,
    columns: DEFAULT_COLUMNS.map((column) =>
      column.key === 'description' ? { ...column, width: 225 } : column,
    ),
  },
  { ...base, key: 'totals', x: 345, y: 632, width: 210, height: 84 },
  { ...base, key: 'tax_details', x: 40, y: 632, width: 280, height: 40, fontSize: 9 },
  { ...base, key: 'notes', x: 40, y: 682, width: 280, height: 110, fontSize: 9 },
]
