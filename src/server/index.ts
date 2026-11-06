import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { config } from './config.ts'
import { runMigrations } from './db/index.ts'
import { seed } from './db/seed.ts'
import { startJobs } from './jobs.ts'
import { assertAppUrl, assertMailConfigured } from './services/mail.ts'

try {
  assertAppUrl()
  assertMailConfigured()
} catch (error) {
  console.error((error as Error).message)
  process.exit(1)
}

runMigrations()
await seed()
startJobs()

serve({ fetch: createApp().fetch, port: config.port }, ({ port }) => {
  console.log(`Server running on http://localhost:${port}`)
})
