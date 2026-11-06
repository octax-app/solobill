import { and, eq, isNull } from 'drizzle-orm'
import { REGION_LABELS, REQUIRED_REGIONS, type Region } from '../../shared/render.ts'
import { db, schema } from '../db/index.ts'
import { ApiError, notFound } from '../errors.ts'

const { providers, services, templateRegions, templates } = schema

export function defaultTemplate(ws: number) {
  const row = db
    .select()
    .from(templates)
    .where(and(eq(templates.workspaceId, ws), eq(templates.isDefault, true)))
    .get()
  if (!row) throw new Error('No default template')
  return row
}

/** First match wins: service, then provider, then the default template. */
export function resolveTemplateId(
  ws: number,
  serviceId?: number | null,
  providerId?: number | null,
): number {
  const providerTemplate = (id: number) =>
    db
      .select()
      .from(providers)
      .where(and(eq(providers.workspaceId, ws), eq(providers.id, id)))
      .get()?.defaultTemplateId
  if (serviceId) {
    const service = db
      .select()
      .from(services)
      .where(and(eq(services.workspaceId, ws), eq(services.id, serviceId)))
      .get()
    if (service?.defaultTemplateId) return service.defaultTemplateId
    const owner = service?.providerId ?? providerId
    const fromProvider = owner ? providerTemplate(owner) : null
    if (fromProvider) return fromProvider
  } else if (providerId) {
    const fromProvider = providerTemplate(providerId)
    if (fromProvider) return fromProvider
  }
  return defaultTemplate(ws).id
}

export function getRegions(ws: number, templateId: number): Region[] {
  return db
    .select()
    .from(templateRegions)
    .where(and(eq(templateRegions.workspaceId, ws), eq(templateRegions.templateId, templateId)))
    .all()
    .map(({ id: _id, workspaceId: _ws, templateId: _templateId, ...region }) => region as Region)
}

export function templateProblems(
  template: typeof templates.$inferSelect,
  regions: Region[],
  options: { tax?: boolean } = {},
): string[] {
  const problems: string[] = []
  const mapped = new Set(regions.map((region) => region.key))
  const missing = REQUIRED_REGIONS.filter((key) => !mapped.has(key))
  if (missing.length) problems.push(`Map the required regions: ${missing.join(', ')}`)
  // A PDF can print these itself, so they only matter when the app prints them.
  if (mapped.has('company') && !template.companyName) {
    problems.push('Enter the company name on the template')
  }
  if (options.tax && mapped.has('tax_details') && !template.taxNumber) {
    problems.push('Enter the tax number on the template')
  }
  for (const field of template.customFields) {
    if (field.required && !mapped.has(field.region)) {
      problems.push(`Map ${REGION_LABELS[field.region]} for the custom item ${field.label}`)
    }
  }
  return problems
}

export function getTemplate(ws: number, id: number) {
  const template = db
    .select()
    .from(templates)
    .where(and(eq(templates.workspaceId, ws), eq(templates.id, id)))
    .get()
  if (!template) throw notFound('Template')
  return template
}

export function templateUsage(ws: number, id: number) {
  return {
    providers: db
      .select({ id: providers.id, name: providers.name })
      .from(providers)
      .where(
        and(
          eq(providers.workspaceId, ws),
          eq(providers.defaultTemplateId, id),
          isNull(providers.archivedAt),
        ),
      )
      .all(),
    services: db
      .select({ id: services.id, name: services.name })
      .from(services)
      .where(
        and(
          eq(services.workspaceId, ws),
          eq(services.defaultTemplateId, id),
          isNull(services.archivedAt),
        ),
      )
      .all(),
  }
}

export function assertTemplateExists(ws: number, id: number | null | undefined) {
  if (
    id &&
    !db
      .select({ id: templates.id })
      .from(templates)
      .where(and(eq(templates.workspaceId, ws), eq(templates.id, id)))
      .get()
  ) {
    throw new ApiError(422, 'Choose a template that exists')
  }
}
