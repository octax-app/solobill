import { Hono } from 'hono'
import { fontNameInput } from '../../shared/schemas.ts'
import type { AuthEnv } from '../auth.ts'
import { ApiError } from '../errors.ts'
import { addFont, deleteFont, listFonts } from '../services/fonts.ts'
import { hideWorkspaceId, idParam } from './util.ts'

export const fontRoutes = new Hono<AuthEnv>()
fontRoutes.use('*', hideWorkspaceId)

fontRoutes.get('/', (c) => c.json(listFonts(c.get('workspaceId'))))

fontRoutes.post('/', async (c) => {
  const form = await c.req.parseBody()
  const name = fontNameInput.parse(typeof form.name === 'string' ? form.name : '')
  if (!(form.file instanceof File) || form.file.size === 0) {
    throw new ApiError(422, 'Choose a font file to upload')
  }
  const regular = new Uint8Array(await form.file.arrayBuffer())
  // A form with no bold file chosen sends an empty one.
  const hasBold = form.bold instanceof File && form.bold.size > 0
  const bold = hasBold ? new Uint8Array(await (form.bold as File).arrayBuffer()) : null
  return c.json(await addFont(c.get('workspaceId'), name, regular, bold), 201)
})

fontRoutes.delete('/:id', async (c) => {
  await deleteFont(c.get('workspaceId'), idParam(c))
  return c.json({ ok: true })
})
