import type { Color, PDFFont, PDFPage } from '@cantoo/pdf-lib'
import bidiFactory from 'bidi-js'
import { DEFAULT_STYLE } from '../../shared/render.ts'

const bidi = bidiFactory()
const MIN_FONT_SIZE = 6

interface Run {
  text: string
  level: number
}

interface Typeface {
  font: PDFFont
  covers: (codePoint: number) => boolean
}

const STRONG = /[\p{L}\p{N}]/u

/** A font, plus the bundled font that draws any character it lacks. */
export class Face {
  primary: Typeface
  fallback: Typeface | null
  constructor(primary: Typeface, fallback: Typeface | null = null) {
    this.primary = primary
    this.fallback = fallback
  }

  /**
   * Splits one direction run by font. Spaces, punctuation and marks stay with their
   * neighbours, so an Arabic phrase on a Latin font shapes as one run.
   */
  private split(text: string, rtl: boolean): { text: string; font: PDFFont }[] {
    const { primary, fallback } = this
    if (!fallback) return [{ text, font: primary.font }]
    const pick = (char: string) => {
      const codePoint = char.codePointAt(0) ?? 0
      return primary.covers(codePoint) ? primary : fallback
    }
    const chars = [...text]
    let current = pick(chars.find((char) => STRONG.test(char)) ?? chars[0])
    const pieces: { text: string; face: Typeface }[] = []
    for (const char of chars) {
      if (STRONG.test(char)) current = pick(char)
      const codePoint = char.codePointAt(0) ?? 0
      const other = current === primary ? fallback : primary
      const face = current.covers(codePoint) || !other.covers(codePoint) ? current : other
      const last = pieces[pieces.length - 1]
      if (last?.face === face) last.text += char
      else pieces.push({ text: char, face })
    }
    if (rtl) pieces.reverse()
    return pieces.map((piece) => ({ text: piece.text, font: piece.face.font }))
  }

  /** Runs in visual order, left to right on the page, each with the font that draws it. */
  runs(text: string): { text: string; font: PDFFont }[] {
    return orderedRuns(text).flatMap((run) => this.split(run.text, run.level % 2 === 1))
  }
}

function mirror(text: string): string {
  return [...text].map((char) => bidi.getMirroredCharacter(char) ?? char).join('')
}

function orderedRuns(text: string): Run[] {
  if (!text) return []
  const { levels } = bidi.getEmbeddingLevels(text)
  const runs: Run[] = []
  let start = 0
  for (let index = 1; index <= text.length; index += 1) {
    if (index === text.length || levels[index] !== levels[start]) {
      runs.push({ text: text.slice(start, index), level: levels[start] })
      start = index
    }
  }
  const highest = Math.max(...runs.map((run) => run.level))
  const lowestOdd = Math.min(...runs.map((run) => run.level).filter((level) => level % 2 === 1), 99)
  for (let level = highest; level >= lowestOdd; level -= 1) {
    let index = 0
    while (index < runs.length) {
      if (runs[index].level < level) {
        index += 1
        continue
      }
      let end = index
      while (end + 1 < runs.length && runs[end + 1].level >= level) end += 1
      const reversed = runs.slice(index, end + 1).reverse()
      runs.splice(index, reversed.length, ...reversed)
      index = end + 1
    }
  }
  return runs.map((run) => (run.level % 2 === 1 ? { ...run, text: mirror(run.text) } : run))
}

/** Splits a logical string into runs in visual order, left to right on the page. */
export function visualRuns(text: string): string[] {
  return orderedRuns(text).map((run) => run.text)
}

export function textWidth(text: string, face: Face, size: number): number {
  return face.runs(text).reduce((sum, run) => sum + run.font.widthOfTextAtSize(run.text, size), 0)
}

export function drawLine(
  page: PDFPage,
  text: string,
  x: number,
  baseline: number,
  face: Face,
  size: number,
  color: Color,
) {
  let cursor = x
  for (const run of face.runs(text)) {
    page.drawText(run.text, { x: cursor, y: baseline, size, font: run.font, color })
    cursor += run.font.widthOfTextAtSize(run.text, size)
  }
}

function breakWord(word: string, face: Face, size: number, width: number): string[] {
  const parts: string[] = []
  let current = ''
  for (const char of word) {
    if (current && textWidth(current + char, face, size) > width) {
      parts.push(current)
      current = char
    } else current += char
  }
  if (current) parts.push(current)
  return parts
}

export function wrapText(text: string, face: Face, size: number, width: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.replace(/\t/g, ' ').split(/\r?\n/)) {
    let current = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = current ? `${current} ${word}` : word
      if (textWidth(candidate, face, size) <= width) {
        current = candidate
      } else if (textWidth(word, face, size) <= width) {
        if (current) lines.push(current)
        current = word
      } else {
        if (current) lines.push(current)
        const parts = breakWord(word, face, size, width)
        current = parts.pop() ?? ''
        lines.push(...parts)
      }
    }
    lines.push(current)
  }
  return lines
}

export interface BlockLine {
  text: string
  bold?: boolean
}

export interface Fonts {
  regular: Face
  bold: Face
}

/** `multiplier` is the region's line height, a multiple of the font size. */
export const lineHeight = (size: number, multiplier: number) => size * multiplier

function layout(lines: BlockLine[], fonts: Fonts, size: number, width: number) {
  return lines.flatMap((line) => {
    const face = line.bold ? fonts.bold : fonts.regular
    return wrapText(line.text, face, size, width).map((text) => ({ text, face }))
  })
}

/** Extra space set by a large line height goes between lines, not below the last one. */
function blockHeight(count: number, size: number, multiplier: number) {
  const line = lineHeight(size, multiplier)
  return count * line - Math.max(line - lineHeight(size, DEFAULT_STYLE.lineHeight), 0)
}

/** Shrinks text until it fits the box, so a long address is not silently cut off. */
export function fitBlock(
  lines: BlockLine[],
  fonts: Fonts,
  startSize: number,
  width: number,
  height: number,
  multiplier: number,
) {
  let size = startSize
  let wrapped = layout(lines, fonts, size, width)
  while (blockHeight(wrapped.length, size, multiplier) > height && size > MIN_FONT_SIZE) {
    size -= 0.5
    wrapped = layout(lines, fonts, size, width)
  }
  return { size, wrapped }
}
