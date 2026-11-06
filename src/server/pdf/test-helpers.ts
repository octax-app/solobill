import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DPI = 144
const SCALE = DPI / 72

export const fixtureFont = (name: string) => fs.readFileSync(path.join(import.meta.dirname, name))

function tempFile(bytes: Uint8Array) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-')), 'doc.pdf')
  fs.writeFileSync(file, bytes)
  return file
}

export const pdfText = (bytes: Uint8Array) =>
  execFileSync('pdftotext', ['-layout', tempFile(bytes), '-']).toString()

export const embeddedFonts = (bytes: Uint8Array) =>
  execFileSync('pdffonts', [tempFile(bytes)]).toString()

/** Text inside a box given in PDF points from the top left of the page. */
export function textIn(
  bytes: Uint8Array,
  box: { x: number; y: number; width: number; height: number },
  page = 0,
) {
  const crop = [box.x, box.y, box.width, box.height].map((value) => String(value))
  const args = ['-r', '72', '-f', String(page + 1), '-l', String(page + 1)]
  const options = [...args, '-x', crop[0], '-y', crop[1], '-W', crop[2], '-H', crop[3], '-layout']
  return execFileSync('pdftotext', [...options, tempFile(bytes), '-']).toString()
}

/** The first word equal to `word`, in PDF points from the top of the page. */
function wordBox(bytes: Uint8Array, word: string) {
  const html = execFileSync('pdftotext', ['-bbox', tempFile(bytes), '-']).toString()
  const match = html.match(new RegExp(`yMin="([\\d.]+)"[^>]*yMax="([\\d.]+)">${word}<`))
  if (!match) throw new Error(`${word} is not on the page`)
  return { top: Number(match[1]), height: Number(match[2]) - Number(match[1]) }
}

export const wordTop = (bytes: Uint8Array, word: string) => wordBox(bytes, word).top
export const wordHeight = (bytes: Uint8Array, word: string) => wordBox(bytes, word).height

export interface Pixels {
  width: number
  height: number
  at: (x: number, y: number) => [number, number, number]
}

/** Rasterises one page. Pixel positions are PDF points times two. */
export function pagePixels(bytes: Uint8Array, page = 0): Pixels {
  const args = ['-r', String(DPI), '-f', String(page + 1), '-l', String(page + 1), '-singlefile']
  const out = execFileSync('pdftoppm', [...args, tempFile(bytes)], { maxBuffer: 2 ** 26 })
  const header = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(out.subarray(0, 32).toString('latin1'))
  if (!header) throw new Error('Unexpected pdftoppm output')
  const width = Number(header[1])
  const start = header[0].length
  return {
    width,
    height: Number(header[2]),
    at: (x, y) => {
      const offset = start + (y * width + x) * 3
      return [out[offset], out[offset + 1], out[offset + 2]]
    },
  }
}

export const isRed = ([r, g, b]: number[]) => r - g > 60 && r - b > 60
export const isBlue = ([r, g, b]: number[]) => b - r > 60 && b - g > 60

function runs(length: number, test: (index: number) => boolean) {
  const found: { start: number; end: number }[] = []
  for (let index = 0; index < length; index += 1) {
    if (!test(index)) continue
    const last = found[found.length - 1]
    if (last && last.end === index / SCALE - 1 / SCALE) last.end = index / SCALE
    else found.push({ start: index / SCALE, end: index / SCALE })
  }
  return found
}

/** Unbroken red stretches on a vertical line at `x`, as positions in points. */
export const redDown = (pixels: Pixels, x: number) =>
  runs(pixels.height, (y) => isRed(pixels.at(x * SCALE, y)))

/** Unbroken red stretches on a horizontal line at `y`, as positions in points. */
export const redAcross = (pixels: Pixels, y: number) =>
  runs(pixels.width, (x) => isRed(pixels.at(x, y * SCALE)))

export function countInBox(
  pixels: Pixels,
  box: { x: number; y: number; width: number; height: number },
  test: (pixel: number[]) => boolean,
) {
  let count = 0
  for (let y = box.y * SCALE; y < (box.y + box.height) * SCALE; y += 1) {
    for (let x = box.x * SCALE; x < (box.x + box.width) * SCALE; x += 1) {
      if (test(pixels.at(x, y))) count += 1
    }
  }
  return count
}
