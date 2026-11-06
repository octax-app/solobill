/**
 * Creates a user with their own workspace, or resets the password of the user with that email.
 *   pnpm admin owner@example.com 'a-long-password'
 *   pnpm admin owner@example.com 'a-long-password' --reset-totp
 */
import { eq } from 'drizzle-orm'
import { hashPassword } from '../auth.ts'
import { db, runMigrations, schema } from '../db/index.ts'
import { createWorkspace } from '../services/workspaces.ts'

const [email, password, flag] = process.argv.slice(2)
if (!email || !password || password.length < 10) {
  console.error('Usage: pnpm admin <email> <password of 10 or more characters> [--reset-totp]')
  process.exit(1)
}

runMigrations()
const key = email.toLowerCase()
const passwordHash = await hashPassword(password)
const existing = db.select().from(schema.users).where(eq(schema.users.email, key)).get()

if (existing) {
  db.update(schema.users)
    .set({
      passwordHash,
      // The owner vouches for the address, so the account can sign in at once (plan 23).
      emailVerifiedAt: existing.emailVerifiedAt ?? new Date().toISOString(),
      ...(flag === '--reset-totp' ? { totpEnabled: false, totpSecret: null } : {}),
    })
    .where(eq(schema.users.id, existing.id))
    .run()
  console.log(`Updated ${key}`)
} else {
  const user = db
    .insert(schema.users)
    .values({ email: key, passwordHash, emailVerifiedAt: new Date().toISOString() })
    .returning()
    .get()
  const workspace = await createWorkspace('My workspace', user.id)
  console.log(`Created ${key} with workspace ${workspace.id}`)
}
