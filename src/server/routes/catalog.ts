import { and, desc, eq, isNull, like, or } from 'drizzle-orm'
import { Hono } from 'hono'
import { renewalAfter, todayISO } from '../../shared/dates.ts'
import {
  customerInput,
  providerInput,
  serviceInput,
  subscriptionCreateInput,
  subscriptionUpdateInput,
} from '../../shared/schemas.ts'
import type { AuthEnv } from '../auth.ts'
import { db, schema } from '../db/index.ts'
import { ApiError, notFound } from '../errors.ts'
import { billFromStart } from '../services/renewals.ts'
import {
  deleteSubscription,
  lineDescription,
  linesBySubscription,
  linesFor,
  nextRenewalOnEdit,
  saveLines,
} from '../services/subscriptions.ts'
import { assertTemplateExists } from '../services/templates.ts'
import { removeFile, saveFile } from '../storage.ts'
import { body, hideWorkspaceId, idParam, uploaded } from './util.ts'

const { customers, invoices, originalInvoices, providers, services, subscriptions } = schema

const now = () => new Date().toISOString()

export const catalogRoutes = new Hono<AuthEnv>()
catalogRoutes.use('*', hideWorkspaceId)

/* Providers */

const providerById = (ws: number, id: number) =>
  and(eq(providers.workspaceId, ws), eq(providers.id, id))

function getProvider(ws: number, id: number) {
  const row = db.select().from(providers).where(providerById(ws, id)).get()
  if (!row) throw notFound('Provider')
  return row
}

catalogRoutes.get('/providers', (c) => {
  const archived = c.req.query('archived') === 'true'
  return c.json(
    db
      .select()
      .from(providers)
      .where(
        and(
          eq(providers.workspaceId, c.get('workspaceId')),
          archived ? undefined : isNull(providers.archivedAt),
        ),
      )
      .orderBy(providers.name)
      .all(),
  )
})

catalogRoutes.get('/providers/:id', (c) => c.json(getProvider(c.get('workspaceId'), idParam(c))))

catalogRoutes.post('/providers', async (c) => {
  const ws = c.get('workspaceId')
  const input = await body(c, providerInput)
  assertTemplateExists(ws, input.defaultTemplateId)
  return c.json(
    db
      .insert(providers)
      .values({ ...input, workspaceId: ws })
      .returning()
      .get(),
    201,
  )
})

catalogRoutes.put('/providers/:id', async (c) => {
  const ws = c.get('workspaceId')
  const id = idParam(c)
  getProvider(ws, id)
  const input = await body(c, providerInput)
  assertTemplateExists(ws, input.defaultTemplateId)
  return c.json(db.update(providers).set(input).where(providerById(ws, id)).returning().get())
})

catalogRoutes.post('/providers/:id/logo', async (c) => {
  const ws = c.get('workspaceId')
  const id = idParam(c)
  const existing = getProvider(ws, id)
  const logoFile = await saveFile('logos', await uploaded(c), 'image')
  await removeFile(existing.logoFile)
  return c.json(
    db.update(providers).set({ logoFile }).where(providerById(ws, id)).returning().get(),
  )
})

catalogRoutes.post('/providers/:id/archive', (c) => {
  const ws = c.get('workspaceId')
  const id = idParam(c)
  getProvider(ws, id)
  return c.json(
    db.update(providers).set({ archivedAt: now() }).where(providerById(ws, id)).returning().get(),
  )
})

catalogRoutes.post('/providers/:id/restore', (c) => {
  const ws = c.get('workspaceId')
  const id = idParam(c)
  getProvider(ws, id)
  return c.json(
    db.update(providers).set({ archivedAt: null }).where(providerById(ws, id)).returning().get(),
  )
})

catalogRoutes.delete('/providers/:id', async (c) => {
  const ws = c.get('workspaceId')
  const id = idParam(c)
  const row = getProvider(ws, id)
  const used =
    db
      .select({ id: services.id })
      .from(services)
      .where(and(eq(services.workspaceId, ws), eq(services.providerId, id)))
      .get() ||
    db
      .select({ id: originalInvoices.id })
      .from(originalInvoices)
      .where(and(eq(originalInvoices.workspaceId, ws), eq(originalInvoices.providerId, id)))
      .get() ||
    db
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(eq(invoices.workspaceId, ws), eq(invoices.providerId, id)))
      .get()
  if (used) throw new ApiError(409, 'This provider is in use. Archive it instead.')
  db.delete(providers).where(providerById(ws, id)).run()
  await removeFile(row.logoFile)
  return c.json({ ok: true })
})

/* Services */

const serviceById = (ws: number, id: number) =>
  and(eq(services.workspaceId, ws), eq(services.id, id))

function getService(ws: number, id: number) {
  const row = db.select().from(services).where(serviceById(ws, id)).get()
  if (!row) throw notFound('Service')
  return row
}

catalogRoutes.get('/services', (c) => {
  const archived = c.req.query('archived') === 'true'
  const providerId = Number(c.req.query('providerId')) || undefined
  return c.json(
    db
      .select({ service: services, providerName: providers.name })
      .from(services)
      .innerJoin(providers, eq(providers.id, services.providerId))
      .where(
        and(
          eq(services.workspaceId, c.get('workspaceId')),
          eq(providers.workspaceId, c.get('workspaceId')),
          archived ? undefined : isNull(services.archivedAt),
          providerId ? eq(services.providerId, providerId) : undefined,
        ),
      )
      .orderBy(providers.name, services.name)
      .all()
      .map(({ service, providerName }) => ({ ...service, providerName })),
  )
})

catalogRoutes.get('/services/:id', (c) => c.json(getService(c.get('workspaceId'), idParam(c))))

catalogRoutes.post('/services', async (c) => {
  const ws = c.get('workspaceId')
  const input = await body(c, serviceInput)
  getProvider(ws, input.providerId)
  assertTemplateExists(ws, input.defaultTemplateId)
  return c.json(
    db
      .insert(services)
      .values({ ...input, workspaceId: ws })
      .returning()
      .get(),
    201,
  )
})

catalogRoutes.put('/services/:id', async (c) => {
  const ws = c.get('workspaceId')
  const id = idParam(c)
  getService(ws, id)
  const input = await body(c, serviceInput)
  getProvider(ws, input.providerId)
  assertTemplateExists(ws, input.defaultTemplateId)
  return c.json(db.update(services).set(input).where(serviceById(ws, id)).returning().get())
})

catalogRoutes.post('/services/:id/archive', (c) => {
  const ws = c.get('workspaceId')
  const id = idParam(c)
  getService(ws, id)
  return c.json(
    db.update(services).set({ archivedAt: now() }).where(serviceById(ws, id)).returning().get(),
  )
})

catalogRoutes.post('/services/:id/restore', (c) => {
  const ws = c.get('workspaceId')
  const id = idParam(c)
  getService(ws, id)
  return c.json(
    db.update(services).set({ archivedAt: null }).where(serviceById(ws, id)).returning().get(),
  )
})

catalogRoutes.delete('/services/:id', (c) => {
  const ws = c.get('workspaceId')
  const id = idParam(c)
  getService(ws, id)
  const used =
    db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(and(eq(subscriptions.workspaceId, ws), eq(subscriptions.serviceId, id)))
      .get() ||
    db
      .select({ id: originalInvoices.id })
      .from(originalInvoices)
      .where(and(eq(originalInvoices.workspaceId, ws), eq(originalInvoices.serviceId, id)))
      .get() ||
    db
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(eq(invoices.workspaceId, ws), eq(invoices.serviceId, id)))
      .get()
  if (used) throw new ApiError(409, 'This service is in use. Archive it instead.')
  db.delete(services).where(serviceById(ws, id)).run()
  return c.json({ ok: true })
})

/* Customers */

const customerById = (ws: number, id: number) =>
  and(eq(customers.workspaceId, ws), eq(customers.id, id))

function getCustomer(ws: number, id: number) {
  const row = db.select().from(customers).where(customerById(ws, id)).get()
  if (!row) throw notFound('Customer')
  return row
}

catalogRoutes.get('/customers', (c) => {
  const search = c.req.query('q')?.trim()
  const status = c.req.query('status') as 'lead' | 'active' | 'archived' | undefined
  const term = `%${search}%`
  return c.json(
    db
      .select()
      .from(customers)
      .where(
        and(
          eq(customers.workspaceId, c.get('workspaceId')),
          status ? eq(customers.status, status) : undefined,
          search
            ? or(
                like(customers.name, term),
                like(customers.company, term),
                like(customers.email, term),
              )
            : undefined,
        ),
      )
      .orderBy(customers.name)
      .all(),
  )
})

catalogRoutes.get('/customers/:id', (c) => c.json(getCustomer(c.get('workspaceId'), idParam(c))))

catalogRoutes.post('/customers', async (c) => {
  const input = await body(c, customerInput)
  return c.json(
    db
      .insert(customers)
      .values({ ...input, workspaceId: c.get('workspaceId') })
      .returning()
      .get(),
    201,
  )
})

catalogRoutes.put('/customers/:id', async (c) => {
  const ws = c.get('workspaceId')
  const id = idParam(c)
  getCustomer(ws, id)
  const input = await body(c, customerInput)
  return c.json(db.update(customers).set(input).where(customerById(ws, id)).returning().get())
})

catalogRoutes.delete('/customers/:id', (c) => {
  const ws = c.get('workspaceId')
  const id = idParam(c)
  getCustomer(ws, id)
  const used =
    db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(and(eq(subscriptions.workspaceId, ws), eq(subscriptions.customerId, id)))
      .get() ||
    db
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(eq(invoices.workspaceId, ws), eq(invoices.customerId, id)))
      .get()
  if (used) throw new ApiError(409, 'This customer has records. Archive the customer instead.')
  db.delete(customers).where(customerById(ws, id)).run()
  return c.json({ ok: true })
})

/* Subscriptions */

const subscriptionById = (ws: number, id: number) =>
  and(eq(subscriptions.workspaceId, ws), eq(subscriptions.id, id))

function getSubscription(ws: number, id: number) {
  const row = db.select().from(subscriptions).where(subscriptionById(ws, id)).get()
  if (!row) throw notFound('Subscription')
  return row
}

catalogRoutes.get('/subscriptions', (c) => {
  const ws = c.get('workspaceId')
  const customerId = Number(c.req.query('customerId')) || undefined
  const rows = db
    .select({
      subscription: subscriptions,
      customerName: customers.name,
      serviceName: services.name,
      providerName: providers.name,
      pricing: services.pricing,
    })
    .from(subscriptions)
    .innerJoin(customers, eq(customers.id, subscriptions.customerId))
    .innerJoin(services, eq(services.id, subscriptions.serviceId))
    .innerJoin(providers, eq(providers.id, services.providerId))
    .where(
      and(
        eq(subscriptions.workspaceId, ws),
        eq(customers.workspaceId, ws),
        eq(services.workspaceId, ws),
        eq(providers.workspaceId, ws),
        customerId ? eq(subscriptions.customerId, customerId) : undefined,
      ),
    )
    .orderBy(desc(subscriptions.id))
    .all()
  const lines = linesBySubscription(
    ws,
    rows.map((row) => row.subscription.id),
  )
  return c.json(
    rows.map(({ subscription, ...names }) => ({
      ...subscription,
      ...names,
      lines: lines.get(subscription.id) ?? [],
    })),
  )
})

const withLines = (ws: number, id: number) => ({
  ...getSubscription(ws, id),
  lines: linesFor(ws, id),
})

catalogRoutes.get('/subscriptions/:id', (c) => c.json(withLines(c.get('workspaceId'), idParam(c))))

/** Cost and price are copied from the service, so later default changes do not affect this row. */
catalogRoutes.post('/subscriptions', async (c) => {
  const ws = c.get('workspaceId')
  const { lines, createFirstInvoice, ...input } = await body(c, subscriptionCreateInput)
  getCustomer(ws, input.customerId)
  const service = getService(ws, input.serviceId)
  const cycle = input.cycle ?? service.cycle
  const fromStart = createFirstInvoice && !input.nextRenewalOn
  const nextRenewalOn =
    cycle === 'once'
      ? null
      : (input.nextRenewalOn ??
        (fromStart ? input.startedOn : renewalAfter(input.startedOn, cycle, todayISO())))
  const { id, firstDraftId } = db.transaction((tx) => {
    const { id } = tx
      .insert(subscriptions)
      .values({
        ...input,
        workspaceId: ws,
        cycle,
        costCurrency: input.costCurrency ?? service.currency,
        priceCurrency: input.priceCurrency ?? service.currency,
        nextRenewalOn,
      })
      .returning()
      .get()
    saveLines(
      ws,
      id,
      lines ?? [
        { description: '', costAmount: service.defaultCost, priceAmount: service.defaultPrice },
      ],
      lineDescription(service.name, input.label),
    )
    return { id, firstDraftId: fromStart ? (billFromStart(ws, id)?.id ?? null) : null }
  })
  return c.json({ ...withLines(ws, id), firstDraftId }, 201)
})

catalogRoutes.put('/subscriptions/:id', async (c) => {
  const ws = c.get('workspaceId')
  const id = idParam(c)
  const existing = getSubscription(ws, id)
  const { lines, ...input } = await body(c, subscriptionUpdateInput)
  getCustomer(ws, input.customerId)
  const service = getService(ws, input.serviceId)
  const cycle = input.cycle ?? existing.cycle
  const nextRenewalOn = nextRenewalOnEdit(ws, existing, { ...input, cycle })
  db.transaction((tx) => {
    tx.update(subscriptions)
      .set({ ...input, cycle, nextRenewalOn })
      .where(subscriptionById(ws, id))
      .run()
    saveLines(ws, id, lines, lineDescription(service.name, input.label))
  })
  return c.json(withLines(ws, id))
})

catalogRoutes.delete('/subscriptions/:id', (c) => {
  const ws = c.get('workspaceId')
  const id = idParam(c)
  getSubscription(ws, id)
  deleteSubscription(ws, id)
  return c.json({ ok: true })
})
