import type { z } from 'zod'
import type { RenderPayload } from '../../shared/render.ts'
import type { templateLayoutInput } from '../../shared/schemas.ts'
import type { schema } from '../db/index.ts'
import { fontIdsFor, renderDocument } from '../pdf/engine.ts'
import { readFile } from '../storage.ts'
import { loadFontFiles } from './fonts.ts'
import { getRegions } from './templates.ts'

/**
 * Loads what a template needs from storage and renders it. The engine itself stays pure.
 * `layout` holds unsaved edits from the layout page. Anything it leaves out comes from the
 * stored template.
 */
export async function renderWithTemplate(
  ws: number,
  template: typeof schema.templates.$inferSelect,
  payload: RenderPayload,
  layout?: z.infer<typeof templateLayoutInput>,
): Promise<Uint8Array> {
  const regions = layout?.regions ?? getRegions(ws, template.id)
  const style = layout?.style ?? {
    textColor: template.textColor,
    lineHeight: template.lineHeight,
    fontId: template.fontId,
  }
  return renderDocument({
    templatePdf: await readFile(template.pdfFile),
    regions,
    logo: template.companyLogoFile ? await readFile(template.companyLogoFile) : null,
    payload,
    style,
    separators: layout?.separators ?? template.separators,
    fontFiles: await loadFontFiles(ws, fontIdsFor(regions, style)),
  })
}
