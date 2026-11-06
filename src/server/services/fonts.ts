import { PDFDocument } from '@cantoo/pdf-lib'
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import * as fontkit from 'fontkit'
import { db, schema } from '../db/index.ts'
import { ApiError, notFound } from '../errors.ts'
import { fileProblem, readFile, removeFile, saveFile } from '../storage.ts'

const { fonts, templateRegions, templates } = schema

const ARABIC_SAMPLE = 'ابتسمنلهي'
const SAMPLE_TEXT = 'The quick brown fox jumps over the lazy dog 0123456789'
const CACHE_SIZE = 8

/** Object names are random and files never change, so nothing here can go stale. */
const cache = new Map<string, Uint8Array>()

export async function fontBytes(key: string): Promise<Uint8Array> {
  const cached = cache.get(key)
  if (cached) {
    cache.delete(key)
    cache.set(key, cached)
    return cached
  }
  const bytes = await readFile(key)
  cache.set(key, bytes)
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string)
  return bytes
}

/** Template names using each font, on the whole template or on a region. */
function usageByFont(ws: number): Map<number, string[]> {
  const direct = db
    .select({ fontId: templates.fontId, name: templates.name })
    .from(templates)
    .where(and(eq(templates.workspaceId, ws), isNotNull(templates.fontId)))
    .all()
  const viaRegions = db
    .select({ fontId: templateRegions.fontId, name: templates.name })
    .from(templateRegions)
    .innerJoin(templates, eq(templates.id, templateRegions.templateId))
    .where(
      and(
        eq(templateRegions.workspaceId, ws),
        eq(templates.workspaceId, ws),
        isNotNull(templateRegions.fontId),
      ),
    )
    .all()
  const names = new Map<number, Set<string>>()
  for (const { fontId, name } of [...direct, ...viaRegions]) {
    if (fontId === null) continue
    names.set(fontId, (names.get(fontId) ?? new Set()).add(name))
  }
  return new Map([...names].map(([fontId, set]) => [fontId, [...set].sort()]))
}

export function listFonts(ws: number) {
  const usage = usageByFont(ws)
  return db
    .select()
    .from(fonts)
    .where(eq(fonts.workspaceId, ws))
    .orderBy(fonts.name)
    .all()
    .map((font) => ({ ...font, usedBy: usage.get(font.id) ?? [] }))
}

/** Parses the file and really subsets it into a PDF, so a bad font fails here and not on issue. */
async function inspectFont(bytes: Uint8Array): Promise<{ coversArabic: boolean }> {
  const problem = fileProblem(bytes, 'font')
  if (problem) throw new ApiError(422, problem)
  try {
    const parsed = fontkit.create(bytes)
    const coversArabic = [...ARABIC_SAMPLE].every((char) =>
      parsed.hasGlyphForCodePoint(char.codePointAt(0)),
    )
    const doc = await PDFDocument.create()
    doc.registerFontkit(fontkit as never)
    const font = await doc.embedFont(bytes, { subset: true })
    const text = coversArabic ? `${SAMPLE_TEXT} ${ARABIC_SAMPLE}` : SAMPLE_TEXT
    doc.addPage().drawText(text, { font, size: 12 })
    await doc.save()
    return { coversArabic }
  } catch {
    throw new ApiError(422, 'This font could not be read or embedded. Try another copy of it.')
  }
}

/** Checks come first, so a refused font never reaches storage. */
export async function addFont(
  ws: number,
  name: string,
  regular: Uint8Array,
  bold: Uint8Array | null,
) {
  const { coversArabic } = await inspectFont(regular)
  if (bold) await inspectFont(bold)
  const saved: string[] = []
  const save = async (bytes: Uint8Array) => {
    const key = await saveFile('fonts', bytes, 'font')
    saved.push(key)
    return key
  }
  try {
    const regularFile = await save(regular)
    const boldFile = bold ? await save(bold) : null
    const font = db
      .insert(fonts)
      .values({ workspaceId: ws, name, regularFile, boldFile, coversArabic })
      .returning()
      .get()
    return { ...font, usedBy: [] as string[] }
  } catch (error) {
    await Promise.allSettled(saved.map((key) => removeFile(key)))
    throw error
  }
}

export async function deleteFont(ws: number, id: number) {
  const font = db
    .select()
    .from(fonts)
    .where(and(eq(fonts.workspaceId, ws), eq(fonts.id, id)))
    .get()
  if (!font) throw notFound('Font')
  const usedBy = usageByFont(ws).get(id) ?? []
  if (usedBy.length) {
    throw new ApiError(409, `This font is used by ${usedBy.join(', ')}, so it cannot be deleted`)
  }
  db.delete(fonts)
    .where(and(eq(fonts.workspaceId, ws), eq(fonts.id, id)))
    .run()
  await removeFile(font.regularFile)
  await removeFile(font.boldFile)
}

export function assertFontsExist(ws: number, ids: (number | null | undefined)[]) {
  const wanted = [...new Set(ids.filter((id) => id != null))]
  if (!wanted.length) return
  const found = db
    .select({ id: fonts.id })
    .from(fonts)
    .where(and(eq(fonts.workspaceId, ws), inArray(fonts.id, wanted)))
    .all()
  if (found.length !== wanted.length) throw new ApiError(422, 'Choose a font that exists')
}

/** Loads what the engine needs for these fonts. */
export async function loadFontFiles(ws: number, ids: Set<number>) {
  const files = new Map<number, { regular: Uint8Array; bold: Uint8Array | null }>()
  if (!ids.size) return files
  const rows = db
    .select()
    .from(fonts)
    .where(and(eq(fonts.workspaceId, ws), inArray(fonts.id, [...ids])))
    .all()
  for (const row of rows) {
    files.set(row.id, {
      regular: await fontBytes(row.regularFile),
      bold: row.boldFile ? await fontBytes(row.boldFile) : null,
    })
  }
  return files
}
