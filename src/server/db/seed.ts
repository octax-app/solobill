import { eq } from 'drizzle-orm'
import { provisionWorkspace } from '../services/workspaces.ts'
import { db, schema } from './index.ts'

const { providers, services, workspaces } = schema

type Pricing = 'fixed' | 'metered'
type Cycle = 'monthly' | 'yearly' | 'once'

const CATALOG: { provider: string; website: string; items: [string, Pricing, Cycle][] }[] = [
  {
    provider: 'Cloudflare',
    website: 'https://www.cloudflare.com',
    items: [
      ['S3 storage (R2)', 'metered', 'monthly'],
      ['Domain', 'fixed', 'yearly'],
    ],
  },
  {
    provider: 'Contabo',
    website: 'https://contabo.com',
    items: [['Dedicated server', 'fixed', 'monthly']],
  },
  {
    provider: 'Intuit',
    website: 'https://quickbooks.intuit.com',
    items: [
      ['QuickBooks Online', 'fixed', 'monthly'],
      ['QuickBooks Online API', 'metered', 'monthly'],
    ],
  },
  {
    provider: 'Apple',
    website: 'https://developer.apple.com',
    items: [['Apple developer account', 'fixed', 'yearly']],
  },
  {
    provider: 'Google',
    website: 'https://play.google.com/console',
    items: [['Google developer account', 'fixed', 'once']],
  },
]

/**
 * Safe to run on every start. Makes sure every workspace has its settings and system template.
 * The starter catalog of common providers only goes into workspace 1, and only while that
 * workspace has no providers. New workspaces start empty (plan 22).
 */
export async function seed() {
  for (const { id: ws } of db.select({ id: workspaces.id }).from(workspaces).all()) {
    await provisionWorkspace(ws)
  }
  if (!db.select().from(workspaces).where(eq(workspaces.id, 1)).get()) return
  if (db.select().from(providers).where(eq(providers.workspaceId, 1)).get()) return
  for (const entry of CATALOG) {
    const provider = db
      .insert(providers)
      .values({ workspaceId: 1, name: entry.provider, website: entry.website })
      .returning()
      .get()
    db.insert(services)
      .values(
        entry.items.map(([name, pricing, cycle]) => ({
          workspaceId: 1,
          providerId: provider.id,
          name,
          pricing,
          cycle,
        })),
      )
      .run()
  }
}
