import { createApp } from '../app.ts'
import { hashPassword } from '../auth.ts'
import { db, runMigrations, schema } from '../db/index.ts'
import { seed } from '../db/seed.ts'
import { createWorkspace } from '../services/workspaces.ts'

export const EMAIL = 'owner@example.com'
export const PASSWORD = 'correct-horse-battery'

export async function setup() {
  runMigrations()
  const user = db
    .insert(schema.users)
    .values({
      email: EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      emailVerifiedAt: new Date().toISOString(),
    })
    .onConflictDoNothing()
    .returning()
    .get()
  if (user) await createWorkspace('Test workspace', user.id)
  await seed()
  return signIn(EMAIL, PASSWORD)
}

/**
 * Another business: a new user who owns a new, empty workspace, signed in (plan 22). Use it next
 * to `setup()` to check that one workspace cannot see or change another's data.
 */
export async function setupWorkspace(email: string, password: string, name: string) {
  runMigrations()
  const user = db
    .insert(schema.users)
    .values({
      email,
      passwordHash: await hashPassword(password),
      emailVerifiedAt: new Date().toISOString(),
    })
    .returning()
    .get()
  const workspace = await createWorkspace(name, user.id)
  return { ...(await signIn(email, password)), workspaceId: workspace.id, userId: user.id }
}

async function signIn(email: string, password: string) {
  const app = createApp()
  const login = await app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]

  async function api<T = any>(method: string, path: string, data?: unknown) {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
    })
    const type = res.headers.get('content-type') ?? ''
    const json = type.includes('json') ? await res.json() : null
    return { status: res.status, json: json as T, res }
  }
  return { app, api, cookie }
}

export async function configureTemplate(api: Awaited<ReturnType<typeof setup>>['api'], id: number) {
  return api('PUT', `/templates/${id}`, {
    name: 'System template',
    companyName: 'MG Trading',
    companyAddress: 'Muscat, Oman',
    taxNumber: 'OM1100',
    bankDetails: 'Bank: Example, IBAN OM00',
    defaultTaxRate: 50_000,
  })
}

export const line = (over: Record<string, unknown> = {}) => ({
  description: 'Dedicated server',
  quantity: 10_000,
  unitPrice: 1_000_000,
  costAmount: 600_000,
  costCurrency: 'USD',
  costFxRate: 100_000_000,
  ...over,
})

export const draftBody = (customerId: number, over: Record<string, unknown> = {}) => ({
  type: 'invoice',
  customerId,
  currency: 'USD',
  fxRate: 100_000_000,
  taxEnabled: false,
  taxRate: 50_000,
  lines: [line()],
  ...over,
})
