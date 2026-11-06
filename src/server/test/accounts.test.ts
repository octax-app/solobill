import fs from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import * as OTPAuth from 'otpauth'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as res from '../../shared/api-responses.ts'
import { createApiToken } from '../auth.ts'
import { config } from '../config.ts'
import { db, schema, sqlite } from '../db/index.ts'
import { assertMailConfigured, type Mail, sentMail } from '../services/mail.ts'
import { EMAIL, PASSWORD, setup, setupWorkspace } from './helpers.ts'

let ctx: Awaited<ReturnType<typeof setup>>
let ipCounter = 0
/** Each request gets its own address unless a test fixes one, so per-IP limits stay apart. */
const nextIp = () => `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`

async function call(
  method: string,
  route: string,
  data?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await ctx.app.request(`/api/v1${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Real-IP': nextIp(), ...headers },
    body: data === undefined ? undefined : JSON.stringify(data),
  })
  const type = response.headers.get('content-type') ?? ''
  const json = type.includes('json') ? await response.json() : null
  return { status: response.status, json, response }
}

const cookieOf = (response: Response) => (response.headers.get('set-cookie') ?? '').split(';')[0]

function mailTo(to: string, subject?: string): Mail | undefined {
  return sentMail.filter((m) => m.to === to && (!subject || m.subject === subject)).at(-1)
}

function tokenIn(mail: Mail | undefined, page: string) {
  const match = mail?.text.match(new RegExp(`/${page}\\?token=([A-Za-z0-9_%-]+)`))
  if (!match) throw new Error(`No ${page} link in ${JSON.stringify(mail)}`)
  return decodeURIComponent(match[1])
}

const userRow = (email: string) =>
  db.select().from(schema.users).where(eq(schema.users.email, email)).get()

const PW = 'a-new-long-password'

async function registerAndVerify(email: string, workspaceName = 'Shop') {
  expect(
    (await call('POST', '/auth/register', { email, password: PW, workspaceName })).status,
  ).toBe(202)
  const token = tokenIn(mailTo(email, 'Confirm your email'), 'verify-email')
  expect((await call('POST', '/auth/verify-email', { token })).status).toBe(200)
}

beforeAll(async () => {
  ctx = await setup()
})

beforeEach(() => {
  config.registrationOpen = true
})

afterEach(() => {
  vi.useRealTimers()
})

describe('registration and email verification', () => {
  it('registers, refuses sign-in until verified, then lands in an empty workspace', async () => {
    const email = 'new@example.com'
    const registered = await call('POST', '/auth/register', {
      email: 'New@Example.com',
      password: PW,
      name: 'Nadia',
      workspaceName: 'Nadia Trading',
    })
    expect(registered.status).toBe(202)
    expect(registered.json).toEqual({ ok: true })
    expect(userRow(email)?.emailVerifiedAt).toBeNull()

    for (const route of ['/auth/login', '/auth/token']) {
      const early = await call('POST', route, { email, password: PW, name: 'iPhone' })
      expect(early.status).toBe(403)
      expect(early.json.error).toBe('email_unverified')
    }
    // A wrong password still gets the same 401 as before.
    const wrong = await call('POST', '/auth/login', { email, password: 'wrong-password' })
    expect(wrong.status).toBe(401)
    expect(wrong.json.error).toBe('Email or password is incorrect')

    const mail = mailTo(email, 'Confirm your email')
    expect(mail?.html).toContain(`${config.appUrl}/verify-email?token=`)
    const token = tokenIn(mail, 'verify-email')
    expect((await call('POST', '/auth/verify-email', { token })).status).toBe(200)
    const again = await call('POST', '/auth/verify-email', { token })
    expect(again.status).toBe(422)
    expect(again.json.error).toBe('That link is not valid or has expired')

    const login = await call('POST', '/auth/login', { email, password: PW })
    expect(login.status).toBe(200)
    const cookie = cookieOf(login.response)
    const me = res.meResponse.parse(
      (await call('GET', '/auth/me', undefined, { Cookie: cookie })).json,
    )
    expect(me).toMatchObject({ email, name: 'Nadia', hasPassword: true, role: 'owner' })
    expect(me.workspace.name).toBe('Nadia Trading')
    expect((await call('GET', '/customers', undefined, { Cookie: cookie })).json).toEqual([])
    const owner = res.meResponse.parse((await ctx.api('GET', '/auth/me')).json)
    expect(me.workspace.id).not.toBe(owner.workspace.id)
  })

  it('expires verification links after 24 hours', async () => {
    const email = 'slow@example.com'
    await call('POST', '/auth/register', { email, password: PW, workspaceName: 'Slow' })
    const token = tokenIn(mailTo(email), 'verify-email')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 24 * 3_600_000 + 1000)
    expect((await call('POST', '/auth/verify-email', { token })).status).toBe(422)
  })

  it('answers the same for a taken email and sends the other email instead', async () => {
    const before = sentMail.length
    const users = sqlite.prepare('SELECT count(*) AS n FROM users').get() as { n: number }
    const taken = await call('POST', '/auth/register', {
      email: EMAIL,
      password: 'another-password',
      workspaceName: 'Takeover',
    })
    expect(taken.status).toBe(202)
    expect(taken.json).toEqual({ ok: true })
    const mails = sentMail.slice(before)
    expect(mails.map((m) => m.subject)).toEqual(['You already have an account'])
    expect(mails[0].text).toContain(`${config.appUrl}/login`)
    expect(mails[0].text).toContain(`${config.appUrl}/forgot-password`)
    expect(sqlite.prepare('SELECT count(*) AS n FROM users').get()).toEqual(users)
    expect((await call('POST', '/auth/login', { email: EMAIL, password: PASSWORD })).status).toBe(
      200,
    )
  })

  it('answers 403 registration_closed while sign-up is off, and existing users still sign in', async () => {
    config.registrationOpen = false
    const closed = await call('POST', '/auth/register', {
      email: 'closed@example.com',
      password: PW,
      workspaceName: 'Closed',
    })
    expect(closed.status).toBe(403)
    expect(closed.json.error).toBe('registration_closed')
    expect(userRow('closed@example.com')).toBeUndefined()
    expect((await call('GET', '/auth/providers')).json.registration).toBe(false)
    expect((await call('POST', '/auth/login', { email: EMAIL, password: PASSWORD })).status).toBe(
      200,
    )
  })

  it('validates the password length', async () => {
    const short = await call('POST', '/auth/register', {
      email: 'short@example.com',
      password: 'short',
      workspaceName: 'Short',
    })
    expect(short.status).toBe(422)
  })

  it('resends verification only to unverified accounts, and always answers 202', async () => {
    const email = 'resend@example.com'
    await call('POST', '/auth/register', { email, password: PW, workspaceName: 'Resend' })
    const first = tokenIn(mailTo(email), 'verify-email')
    for (const target of [email, EMAIL, 'nobody-here@example.com']) {
      const before = sentMail.length
      const answer = await call('POST', '/auth/resend-verification', { email: target })
      expect(answer.status).toBe(202)
      expect(answer.json).toEqual({ ok: true })
      expect(sentMail.length - before).toBe(target === email ? 1 : 0)
    }
    const second = tokenIn(mailTo(email), 'verify-email')
    expect(second).not.toBe(first)
    // Only the newest link works.
    expect((await call('POST', '/auth/verify-email', { token: first })).status).toBe(422)
    expect((await call('POST', '/auth/verify-email', { token: second })).status).toBe(200)
  })
})

describe('password reset', () => {
  it('works once, signs out every session and token, and verifies the email', async () => {
    const email = 'reset@example.com'
    await call('POST', '/auth/register', { email, password: PW, workspaceName: 'Reset' })
    // Verified by the reset, so set up the old credentials directly.
    sqlite
      .prepare('UPDATE users SET email_verified_at = ? WHERE email = ?')
      .run('2026-01-01', email)
    const login = await call('POST', '/auth/login', { email, password: PW })
    const cookie = cookieOf(login.response)
    const bearer = (await call('POST', '/auth/token', { email, password: PW, name: 'iPhone' })).json
      .token
    sqlite.prepare('UPDATE users SET email_verified_at = NULL WHERE email = ?').run(email)

    expect(
      (await call('POST', '/auth/forgot-password', { email: 'ghost@example.com' })).status,
    ).toBe(202)
    expect(mailTo('ghost@example.com')).toBeUndefined()
    const asked = await call('POST', '/auth/forgot-password', { email })
    expect(asked.status).toBe(202)
    expect(asked.json).toEqual({ ok: true })
    const token = tokenIn(mailTo(email, 'Reset your password'), 'reset-password')

    const newPassword = 'brand-new-password-1'
    const reset = await call('POST', '/auth/reset-password', { token, password: newPassword })
    expect(reset.status).toBe(200)
    expect(reset.json).toEqual({ ok: true })
    expect(mailTo(email, 'Your password was changed')).toBeDefined()
    const reused = await call('POST', '/auth/reset-password', {
      token,
      password: 'other-password-2',
    })
    expect(reused.status).toBe(422)
    expect(reused.json.error).toBe('That link is not valid or has expired')

    expect((await call('GET', '/auth/me', undefined, { Cookie: cookie })).status).toBe(401)
    expect(
      (await call('GET', '/auth/me', undefined, { Authorization: `Bearer ${bearer}` })).status,
    ).toBe(401)
    expect((await call('POST', '/auth/login', { email, password: PW })).status).toBe(401)
    expect((await call('POST', '/auth/login', { email, password: newPassword })).status).toBe(200)
    expect(userRow(email)?.emailVerifiedAt).not.toBeNull()
  })

  it('expires reset links after 1 hour', async () => {
    const email = 'reset-late@example.com'
    await registerAndVerify(email)
    await call('POST', '/auth/forgot-password', { email })
    const token = tokenIn(mailTo(email, 'Reset your password'), 'reset-password')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 3_600_000 + 1000)
    const late = await call('POST', '/auth/reset-password', {
      token,
      password: 'late-password-123',
    })
    expect(late.status).toBe(422)
    vi.useRealTimers()
    expect((await call('POST', '/auth/login', { email, password: PW })).status).toBe(200)
  })
})

describe('signed-in account settings', () => {
  it('changes the password with the current one and sends an email', async () => {
    const email = 'change@example.com'
    await registerAndVerify(email)
    const cookie = cookieOf((await call('POST', '/auth/login', { email, password: PW })).response)
    const as = { Cookie: cookie }
    const next = 'changed-password-99'
    const missing = await call('POST', '/auth/password', { newPassword: next }, as)
    expect(missing.status).toBe(422)
    const wrong = await call(
      'POST',
      '/auth/password',
      { currentPassword: 'not-the-password', newPassword: next },
      as,
    )
    expect(wrong.status).toBe(422)
    const ok = await call('POST', '/auth/password', { currentPassword: PW, newPassword: next }, as)
    expect(ok.status).toBe(200)
    expect(ok.json).toEqual({ ok: true })
    expect(mailTo(email, 'Your password was changed')).toBeDefined()
    expect((await call('POST', '/auth/login', { email, password: next })).status).toBe(200)
  })

  it('asks for TOTP on password sign-in and turns it off with the password', async () => {
    const email = 'totp@example.com'
    await registerAndVerify(email)
    const as = {
      Cookie: cookieOf((await call('POST', '/auth/login', { email, password: PW })).response),
    }
    const { secret } = (await call('POST', '/auth/totp/setup', undefined, as)).json
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) })
    expect((await call('POST', '/auth/totp/enable', { code: totp.generate() }, as)).status).toBe(
      200,
    )
    const without = await call('POST', '/auth/token', { email, password: PW, name: 'iPhone' })
    expect(without.json.error).toBe('totp_required')
    const withCode = await call('POST', '/auth/token', {
      email,
      password: PW,
      name: 'iPhone',
      code: totp.generate(),
    })
    expect(withCode.status).toBe(201)
    expect((await call('POST', '/auth/totp/disable', { password: 'wrong-one' }, as)).status).toBe(
      422,
    )
    // With a password, a code alone doesn't turn it off.
    expect((await call('POST', '/auth/totp/disable', { code: totp.generate() }, as)).status).toBe(
      422,
    )
    const off = await call('POST', '/auth/totp/disable', { password: PW }, as)
    expect(res.totpStateResponse.parse(off.json)).toEqual({ totpEnabled: false })
  })

  it('renames the workspace, for owners only', async () => {
    const renamed = await ctx.api('PUT', '/workspace', { name: '  Renamed Co  ' })
    expect(renamed.status).toBe(200)
    const body = res.workspaceResponse.parse(renamed.json)
    expect(body.name).toBe('Renamed Co')
    expect((await ctx.api('GET', '/auth/me')).json.workspace.name).toBe('Renamed Co')
    expect((await ctx.api('PUT', '/workspace', { name: '' })).status).toBe(422)

    // A member, which teams will add later, can't rename it.
    const member = await setupWorkspace('member@example.com', PASSWORD, 'Own')
    sqlite.prepare("UPDATE memberships SET role = 'member' WHERE user_id = ?").run(member.userId)
    const refused = await member.api('PUT', '/workspace', { name: 'Hijack' })
    expect(refused.status).toBe(403)
  })

  it('lists no identities for a password account', async () => {
    const list = await ctx.api('GET', '/auth/identities')
    expect(list.status).toBe(200)
    expect(list.json).toEqual([])
  })
})

describe('account deletion', () => {
  it('needs the password, then removes the workspace rows and files and leaves others alone', async () => {
    const other = await setupWorkspace('doomed@example.com', PASSWORD, 'Doomed')
    const customer = await other.api('POST', '/customers', { name: 'Gone Co', currency: 'USD' })
    expect(customer.status).toBe(201)
    const files = (
      sqlite
        .prepare('SELECT pdf_file AS f FROM templates WHERE workspace_id = ?')
        .all(other.workspaceId) as { f: string }[]
    ).map((r) => r.f)
    expect(files.length).toBeGreaterThan(0)
    for (const key of files) expect(fs.existsSync(path.join(config.filesDir, key))).toBe(true)
    const ownerCustomers = (await ctx.api('GET', '/customers')).json.length
    const bearer = createApiToken(other.userId, other.workspaceId, 'iPhone').token

    expect((await other.api('DELETE', '/auth/account')).status).toBe(422)
    expect((await other.api('DELETE', '/auth/account', { password: 'not-it' })).status).toBe(422)
    const deleted = await other.api('DELETE', '/auth/account', { password: PASSWORD })
    expect(deleted.status).toBe(200)
    expect(deleted.json).toEqual({ ok: true })
    expect(deleted.res.headers.get('set-cookie')).toMatch(/session=;/)

    expect(userRow('doomed@example.com')).toBeUndefined()
    for (const table of ['customers', 'templates', 'settings', 'memberships']) {
      const n = sqlite
        .prepare(`SELECT count(*) AS n FROM ${table} WHERE workspace_id = ?`)
        .get(other.workspaceId) as { n: number }
      expect(n.n, table).toBe(0)
    }
    expect(
      sqlite.prepare('SELECT count(*) AS n FROM workspaces WHERE id = ?').get(other.workspaceId),
    ).toEqual({ n: 0 })
    for (const key of files) expect(fs.existsSync(path.join(config.filesDir, key))).toBe(false)
    expect((await other.api('GET', '/auth/me')).status).toBe(401)
    expect(
      (await call('GET', '/auth/me', undefined, { Authorization: `Bearer ${bearer}` })).status,
    ).toBe(401)
    expect((await ctx.api('GET', '/customers')).json.length).toBe(ownerCustomers)
  })
})

describe('rate limits', () => {
  const cases: [string, (email: string) => unknown][] = [
    ['/auth/register', (email) => ({ email, password: PW, workspaceName: 'Spam' })],
    ['/auth/login', (email) => ({ email, password: 'wrong-password' })],
    ['/auth/token', (email) => ({ email, password: 'wrong-password', name: 'iPhone' })],
    ['/auth/forgot-password', (email) => ({ email })],
    ['/auth/resend-verification', (email) => ({ email })],
  ]

  for (const [route, make] of cases) {
    it(`answers 429 by email on ${route}`, async () => {
      const email = `limit-${route.split('/').at(-1)}@example.com`
      const statuses: number[] = []
      for (let i = 0; i < 6; i += 1) statuses.push((await call('POST', route, make(email))).status)
      expect(statuses.slice(0, 5)).not.toContain(429)
      expect(statuses[5]).toBe(429)
    })

    it(`answers 429 by client address on ${route}`, async () => {
      const ip = `192.0.2.${cases.findIndex(([r]) => r === route) + 1}`
      const statuses: number[] = []
      for (let i = 0; i < 31; i += 1) {
        const email = `ip-${i}-${route.split('/').at(-1)}@example.com`
        statuses.push((await call('POST', route, make(email), { 'X-Real-IP': ip })).status)
      }
      expect(statuses.slice(0, 30)).not.toContain(429)
      expect(statuses[30]).toBe(429)
      // Another address is not affected.
      const fresh = await call('POST', route, make('fresh-address@example.com'))
      expect(fresh.status).not.toBe(429)
    })
  }

  it('uses the last X-Forwarded-For entry when there is no X-Real-IP', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 31; i += 1) {
      const response = await ctx.app.request('/api/v1/auth/forgot-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // The first entry is whatever the client claims; only the last is ours.
          'X-Forwarded-For': `203.0.113.${i}, 198.51.100.7`,
        },
        body: JSON.stringify({ email: `xff-${i}@example.com` }),
      })
      statuses.push(response.status)
    }
    expect(statuses[30]).toBe(429)
  })
})

describe('mail and startup', () => {
  it('refuses to start in production with registration open and no SMTP', () => {
    const saved = {
      production: config.production,
      open: config.registrationOpen,
      mail: config.mail,
    }
    try {
      config.production = true
      config.registrationOpen = true
      config.mail = null
      expect(() => assertMailConfigured()).toThrow(/SMTP_URL/)
      config.registrationOpen = false
      expect(() => assertMailConfigured()).not.toThrow()
      config.registrationOpen = true
      config.mail = { smtpUrl: 'smtp://localhost:2525', from: 'a@b.c' }
      expect(() => assertMailConfigured()).not.toThrow()
    } finally {
      config.production = saved.production
      config.registrationOpen = saved.open
      config.mail = saved.mail
    }
  })

  it('puts no password in any email, and only link tokens', () => {
    expect(sentMail.length).toBeGreaterThan(5)
    for (const mail of sentMail) {
      const all = `${mail.subject}\n${mail.text}\n${mail.html}`
      for (const secret of [PW, PASSWORD, 'brand-new-password-1', 'changed-password-99']) {
        expect(all).not.toContain(secret)
      }
      expect(mail.html).toContain('<!doctype html>')
    }
  })
})

describe('well-known files for shared passwords', () => {
  it('serves apple-app-site-association without a session, and 404 when unset', async () => {
    const saved = config.appLinks.appleAppIds
    try {
      config.appLinks.appleAppIds = []
      expect((await ctx.app.request('/.well-known/apple-app-site-association')).status).toBe(404)
      config.appLinks.appleAppIds = ['TEAM123.dev.octax.mg']
      const response = await ctx.app.request('/.well-known/apple-app-site-association')
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toMatch(/^application\/json/)
      expect(await response.json()).toEqual({ webcredentials: { apps: ['TEAM123.dev.octax.mg'] } })
    } finally {
      config.appLinks.appleAppIds = saved
    }
  })

  it('serves assetlinks.json without a session, and 404 when unset', async () => {
    const saved = config.appLinks.android
    try {
      config.appLinks.android = null
      expect((await ctx.app.request('/.well-known/assetlinks.json')).status).toBe(404)
      config.appLinks.android = { packageName: 'dev.octax.mg', sha256: ['AB:CD', '01:02'] }
      const response = await ctx.app.request('/.well-known/assetlinks.json')
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toMatch(/^application\/json/)
      expect(await response.json()).toEqual([
        {
          relation: ['delegate_permission/common.get_login_creds'],
          target: {
            namespace: 'android_app',
            package_name: 'dev.octax.mg',
            sha256_cert_fingerprints: ['AB:CD', '01:02'],
          },
        },
      ])
    } finally {
      config.appLinks.android = saved
    }
  })
})
