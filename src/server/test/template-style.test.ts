import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { config } from '../config.ts'
import { samplePayload } from '../pdf/sample.ts'
import { fixtureFont, pdfText } from '../pdf/test-helpers.ts'
import { addFont, listFonts } from '../services/fonts.ts'
import { renderWithTemplate } from '../services/template-render.ts'
import { getTemplate } from '../services/templates.ts'
import { sniff } from '../storage.ts'
import { configureTemplate, setup } from './helpers.ts'

const uuid = (digit: number) => `00000000-0000-4000-8000-00000000000${digit}`
const TTF = fixtureFont('test-fonts/latin-only.ttf')
const OTF = fixtureFont('test-fonts/latin-only.otf')
const WOFF = fixtureFont('fonts/IBMPlexSansArabic-Regular.woff')

const separator = {
  id: uuid(1),
  page: 0,
  x: 100,
  y: 170,
  length: 200,
  orientation: 'horizontal',
  thickness: 1,
  color: '#ff0000',
}
const customField = {
  id: uuid(2),
  label: 'Customer ID',
  type: 'text',
  required: true,
  order: 0,
  region: 'document_meta',
}

let ctx: Awaited<ReturnType<typeof setup>>
let templateId: number
let ws: number
let systemRegions: { key: string; fontId?: number | null }[]

const storedFonts = () => {
  const folder = path.join(config.filesDir, 'fonts')
  return fs.existsSync(folder) ? fs.readdirSync(folder) : []
}

async function upload(name: string, file: Uint8Array | null, bold?: Uint8Array) {
  const form = new FormData()
  form.set('name', name)
  if (file) form.set('file', new File([file as BlobPart], 'font.bin'))
  if (bold) form.set('bold', new File([bold as BlobPart], 'bold.bin'))
  const res = await ctx.app.request('/api/v1/fonts', {
    method: 'POST',
    headers: { Cookie: ctx.cookie },
    body: form,
  })
  return { status: res.status, json: (await res.json()) as any }
}

const saveLayout = (layout: Record<string, unknown>, id = templateId) =>
  ctx.api('PUT', `/templates/${id}/regions`, { regions: systemRegions, ...layout })

beforeAll(async () => {
  ctx = await setup()
  ws = (await ctx.api('GET', '/auth/me')).json.workspace.id
  templateId = (await ctx.api('GET', '/templates')).json[0].id
  await configureTemplate(ctx.api, templateId)
  systemRegions = (await ctx.api('GET', `/templates/${templateId}`)).json.regions
})

describe('font files in storage', () => {
  it('recognises fonts by content', () => {
    expect(sniff(TTF)?.contentType).toBe('font/ttf')
    expect(sniff(OTF)?.contentType).toBe('font/otf')
    expect(sniff(WOFF)?.contentType).toBe('font/woff')
    expect(sniff(new TextEncoder().encode('true....'))?.extension).toBe('ttf')
    expect(sniff(new TextEncoder().encode('wOF2....'))).toBeNull()
  })

  it('does not take a font as a logo or a logo as a font', async () => {
    const form = new FormData()
    form.set('file', new File([TTF as BlobPart], 'logo.png'))
    const res = await ctx.app.request(`/api/v1/templates/${templateId}/logo`, {
      method: 'POST',
      headers: { Cookie: ctx.cookie },
      body: form,
    })
    expect(res.status).toBe(415)
    expect(((await res.json()) as { error: string }).error).toBe('Upload a PNG or JPEG image')
  })
})

describe('fonts api', () => {
  it('needs a login', async () => {
    expect((await ctx.app.request('/api/v1/fonts')).status).toBe(401)
  })

  it('uploads a TTF, an OTF and a WOFF under random names', async () => {
    const before = storedFonts().length
    const ttf = await upload('B Latin', TTF)
    const otf = await upload('A Latin', OTF, OTF)
    const woff = await upload('C Plex', WOFF)
    expect([ttf.status, otf.status, woff.status]).toEqual([201, 201, 201])
    expect(ttf.json.regularFile).toMatch(/^fonts\/[0-9a-f-]{36}\.ttf$/)
    expect(otf.json.regularFile).toMatch(/^fonts\/[0-9a-f-]{36}\.otf$/)
    expect(otf.json.boldFile).toMatch(/^fonts\/[0-9a-f-]{36}\.otf$/)
    expect(woff.json.regularFile).toMatch(/^fonts\/[0-9a-f-]{36}\.woff$/)
    expect(ttf.json.boldFile).toBeNull()
    expect([ttf.json.coversArabic, otf.json.coversArabic, woff.json.coversArabic]).toEqual([
      false,
      false,
      true,
    ])
    expect(ttf.json.usedBy).toEqual([])
    expect(storedFonts().length).toBe(before + 4)

    const list = (await ctx.api('GET', '/fonts')).json
    expect(list.map((font: { name: string }) => font.name)).toEqual([
      'A Latin',
      'B Latin',
      'C Plex',
    ])
    expect(Object.keys(list[0]).sort()).toEqual([...Object.keys(ttf.json)].sort())
    for (const font of list) await ctx.api('DELETE', `/fonts/${font.id}`)
    expect((await ctx.api('GET', '/fonts')).json).toEqual([])
    expect(storedFonts().length).toBe(before)
  })

  it('refuses bad files and leaves nothing in storage', async () => {
    const before = storedFonts().length
    const png = fixtureFont('fonts/OFL-LICENSE.txt')
    const signed = new Uint8Array(64)
    signed.set([0x00, 0x01, 0x00, 0x00])
    const pdf = new TextEncoder().encode('%PDF-1.4 nope')
    const woff2 = new TextEncoder().encode('wOF2 and more bytes')
    for (const bytes of [png, signed, pdf]) {
      const res = await upload('Bad', bytes)
      expect(res.status).toBe(422)
      expect(res.json.error).toMatch(/font/i)
    }
    expect((await upload('Bad', woff2)).json.error).toMatch(/WOFF2 is not supported/)
    expect((await upload('Bad', TTF, signed)).status).toBe(422)
    expect((await upload('', TTF)).json.error).toBe('Enter a font name')
    expect((await upload('No file', null)).json.error).toBe('Choose a font file to upload')
    expect(storedFonts().length).toBe(before)
    expect(listFonts(ws)).toEqual([])
  })

  it('removes what it saved when a later save fails', async () => {
    const before = storedFonts().length
    const tooBig = new Uint8Array(config.maxUploadBytes + 1)
    tooBig.set(TTF)
    await expect(addFont(ws, 'Too big', TTF, tooBig)).rejects.toThrow(/limit/)
    expect(storedFonts().length).toBe(before)
  })

  it('refuses to delete a font in use, on a template or on a region', async () => {
    const whole = (await upload('Whole', TTF)).json
    const region = (await upload('Region', TTF)).json
    const style = { textColor: '#1a1a21', lineHeight: 1.32, fontId: whole.id }
    const regions = systemRegions.map((item) =>
      item.key === 'customer' ? { ...item, fontId: region.id } : item,
    )
    expect((await saveLayout({ regions, style })).status).toBe(200)

    const fonts = (await ctx.api('GET', '/fonts')).json
    expect(fonts.map((font: { usedBy: string[] }) => font.usedBy)).toEqual([
      ['System template'],
      ['System template'],
    ])
    for (const font of [whole, region]) {
      const refused = await ctx.api('DELETE', `/fonts/${font.id}`)
      expect(refused.status).toBe(409)
      expect(refused.json.error).toContain('System template')
    }

    await saveLayout({ regions: systemRegions, style: { ...style, fontId: null } })
    expect((await ctx.api('DELETE', `/fonts/${whole.id}`)).status).toBe(200)
    expect((await ctx.api('DELETE', `/fonts/${region.id}`)).status).toBe(200)
    expect((await ctx.api('DELETE', `/fonts/${region.id}`)).status).toBe(404)
  })
})

describe('saving a layout', () => {
  it('stores style, separators, custom fields and region styles', async () => {
    const style = { textColor: '#123456', lineHeight: 1.5, fontId: null }
    const regions = systemRegions.map((item) =>
      item.key === 'line_table'
        ? { ...item, color: '#ff0000', lineHeight: 2, borders: 'both', borderColor: '#00ff00' }
        : item,
    )
    const saved = await saveLayout({
      regions,
      style,
      separators: [separator],
      customFields: [{ ...customField, required: false }],
    })
    expect(saved.status).toBe(200)
    expect(saved.json).toMatchObject({ textColor: '#123456', lineHeight: 1.5 })
    expect(saved.json.separators).toEqual([separator])
    expect(saved.json.customFields).toHaveLength(1)
    const table = saved.json.regions.find((item: { key: string }) => item.key === 'line_table')
    expect(table).toMatchObject({
      color: '#ff0000',
      lineHeight: 2,
      borders: 'both',
      borderColor: '#00ff00',
    })

    const kept = await saveLayout({ regions })
    expect(kept.json).toMatchObject({ textColor: '#123456', lineHeight: 1.5 })
    expect(kept.json.separators).toEqual([separator])
    expect(kept.json.customFields).toHaveLength(1)
    await saveLayout({
      regions: systemRegions,
      style: { textColor: '#1a1a21', lineHeight: 1.32, fontId: null },
      separators: [],
      customFields: [],
    })
  })

  it('refuses a layout that cannot be used', async () => {
    const style = { textColor: '#1a1a21', lineHeight: 1.32, fontId: 9999 }
    const missing = await saveLayout({ style })
    expect(missing.status).toBe(422)
    expect(missing.json.error).toBe('Choose a font that exists')
    const regions = systemRegions.map((item) => ({ ...item, fontId: 9999 }))
    expect((await saveLayout({ regions })).json.error).toBe('Choose a font that exists')
    expect((await saveLayout({ separators: [{ ...separator, page: 4 }] })).status).toBe(422)
    expect((await saveLayout({ separators: [separator, separator] })).status).toBe(422)
    expect((await saveLayout({ customFields: [customField, customField] })).status).toBe(422)
    expect(
      (await saveLayout({ style: { textColor: 'red', lineHeight: 1.32, fontId: null } })).json
        .error,
    ).toBe('Enter a color as #RRGGBB')
    const stored = getTemplate(ws, templateId)
    expect(stored.separators).toEqual([])
    expect(stored.customFields).toEqual([])
  })

  it('reports a required custom item whose region is not mapped', async () => {
    const regions = systemRegions.filter((item) => item.key !== 'notes')
    const field = { ...customField, region: 'notes' }
    const saved = await saveLayout({ regions, customFields: [field] })
    expect(saved.json.ready).toBe(false)
    expect(saved.json.problems).toContain(
      'Map Bank details and notes for the custom item Customer ID',
    )
    const optional = await saveLayout({ regions, customFields: [{ ...field, required: false }] })
    expect(optional.json.ready).toBe(true)
    await saveLayout({ customFields: [] })
  })
})

describe('preview with an unsaved layout', () => {
  const rawPreview = async (data: Record<string, unknown>) => {
    const res = await ctx.app.request(`/api/v1/templates/${templateId}/preview`, {
      method: 'POST',
      headers: { Cookie: ctx.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    const isPdf = res.headers.get('content-type')?.includes('pdf')
    return {
      status: res.status,
      bytes: isPdf ? new Uint8Array(await res.arrayBuffer()) : new Uint8Array(),
      json: (isPdf ? null : await res.json()) as { error: string } | null,
    }
  }

  it('renders the edits and stores nothing', async () => {
    const before = await ctx.api('GET', `/templates/${templateId}`)
    const shown = await rawPreview({
      layout: {
        regions: systemRegions,
        style: { textColor: '#ff0000', lineHeight: 2, fontId: null },
        separators: [separator],
        customFields: [customField],
      },
    })
    expect(shown.status).toBe(200)
    expect(pdfText(shown.bytes)).toContain('Customer ID: ABC-123')
    const after = await ctx.api('GET', `/templates/${templateId}`)
    expect(after.json).toEqual(before.json)
  })

  it('uses stored custom fields when the layout has none', async () => {
    await saveLayout({ customFields: [customField] })
    const shown = await rawPreview({ layout: { regions: systemRegions } })
    expect(pdfText(shown.bytes)).toContain('Customer ID: ABC-123')
    await saveLayout({ customFields: [] })
  })

  it('refuses a layout with no content table or a bad page', async () => {
    const regions = systemRegions.filter((item) => item.key !== 'line_table')
    const noTable = await rawPreview({ layout: { regions } })
    expect(noTable.status).toBe(422)
    expect(noTable.json?.error).toBe('This template has no content table mapped')
    const offPage = systemRegions.map((item) =>
      item.key === 'line_table' ? { ...item, page: 7 } : item,
    )
    expect((await rawPreview({ layout: { regions: offPage } })).status).toBe(422)
    const badFont = { textColor: '#1a1a21', lineHeight: 1.32, fontId: 9999 }
    const noFont = await rawPreview({ layout: { regions: systemRegions, style: badFont } })
    expect(noFont.json?.error).toBe('Choose a font that exists')
  })

  it('draws with an uploaded font without saving it on the template', async () => {
    const font = (await upload('Preview', TTF)).json
    const style = { textColor: '#1a1a21', lineHeight: 1.32, fontId: font.id }
    const shown = await rawPreview({ layout: { regions: systemRegions, style } })
    expect(shown.status).toBe(200)
    expect(pdfText(shown.bytes)).toContain('Example Trading LLC')
    expect(getTemplate(ws, templateId).fontId).toBeNull()
    await ctx.api('DELETE', `/fonts/${font.id}`)
  })
})

describe('rendering a stored template', () => {
  it('applies the stored style with two arguments', async () => {
    const font = (await upload('Stored', TTF)).json
    await saveLayout({
      style: { textColor: '#1a1a21', lineHeight: 1.32, fontId: font.id },
      separators: [separator],
    })
    const payload = samplePayload({ name: 'MG Trading', address: '', taxNumber: '' }, '', '5', {
      tax: true,
      long: false,
      arabic: true,
    })
    const bytes = await renderWithTemplate(ws, getTemplate(ws, templateId), payload)
    expect(pdfText(bytes)).toContain('MG Trading')
    await saveLayout({
      style: { textColor: '#1a1a21', lineHeight: 1.32, fontId: null },
      separators: [],
    })
    await ctx.api('DELETE', `/fonts/${font.id}`)
  })
})
