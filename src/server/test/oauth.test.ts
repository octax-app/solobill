import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  type JWK,
  jwtVerify,
  SignJWT,
} from 'jose'
import * as OTPAuth from 'otpauth'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as res from '../../shared/api-responses.ts'
import { createApiToken } from '../auth.ts'
import { config } from '../config.ts'
import { db, schema, sqlite } from '../db/index.ts'
import { setOAuthTransport } from '../services/oauth.ts'
import { EMAIL, PASSWORD, setup } from './helpers.ts'

/*
 * Google and Apple sign-in against a local JWKS and a fake token endpoint. Nothing here calls
 * Google or Apple.
 */

const GOOGLE_WEB = 'google-web-client.apps.googleusercontent.com'
const GOOGLE_IOS = 'google-ios-client.apps.googleusercontent.com'
const APPLE_WEB = 'dev.octax.mg.web'
const APPLE_APP = 'dev.octax.mg'
const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex')

let ctx: Awaited<ReturnType<typeof setup>>
let providerKey: CryptoKey
let strangerKey: CryptoKey
let applePublicKey: CryptoKey

interface FetchCall {
  url: string
  form: Record<string, string>
}
const fetchCalls: FetchCall[] = []
/** What the fake token endpoints answer next. */
const next = {
  googleIdToken: '',
  appleStatus: 200,
  appleRefreshToken: 'apple-refresh-token-0001',
  revokeStatus: 200,
}

async function fakeFetch(input: string | URL | Request, init?: RequestInit) {
  const url = String(input)
  const form = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')))
  fetchCalls.push({ url, form })
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  if (url === 'https://oauth2.googleapis.com/token')
    return json(200, { id_token: next.googleIdToken })
  if (url === 'https://appleid.apple.com/auth/token') {
    return next.appleStatus === 200
      ? json(200, { refresh_token: next.appleRefreshToken, id_token: 'unused' })
      : json(next.appleStatus, { error: 'invalid_grant' })
  }
  if (url === 'https://appleid.apple.com/auth/revoke') return json(next.revokeStatus, {})
  return json(404, {})
}

interface TokenOptions {
  sub: string
  nonce: string
  email?: string | null
  emailVerified?: boolean
  name?: string
  aud?: string
  iss?: string
  exp?: number
  key?: CryptoKey
}

/** A signed ID token, as the provider would make it. Apple's `nonce` is the SHA-256 of the raw. */
function idToken(provider: 'google' | 'apple', o: TokenOptions) {
  const claims: Record<string, unknown> = {
    nonce: provider === 'apple' ? sha256Hex(o.nonce) : o.nonce,
  }
  if (o.email !== null) claims.email = o.email ?? `${o.sub}@example.com`
  if (provider === 'google') {
    claims.email_verified = o.emailVerified ?? true
    if (o.name) claims.name = o.name
  } else if (o.email !== null) claims.email_verified = 'true'
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject(o.sub)
    .setIssuer(
      o.iss ??
        (provider === 'google' ? 'https://accounts.google.com' : 'https://appleid.apple.com'),
    )
    .setAudience(o.aud ?? (provider === 'google' ? GOOGLE_IOS : APPLE_APP))
    .setIssuedAt()
    .setExpirationTime(o.exp ?? Math.floor(Date.now() / 1000) + 600)
    .sign(o.key ?? providerKey)
}

const NONCE = 'a-raw-nonce-from-the-app-0123'
let ipCounter = 0

async function call(
  method: string,
  route: string,
  data?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await ctx.app.request(`/api/v1${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Real-IP': `10.9.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`,
      ...headers,
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  })
  const type = response.headers.get('content-type') ?? ''
  const json = type.includes('json') ? await response.json() : null
  return { status: response.status, json, response }
}

/** Native sign-in, as the iOS app does it. */
async function nativeSignIn(
  provider: 'google' | 'apple',
  token: TokenOptions,
  extra: Record<string, unknown> = {},
) {
  return call('POST', `/auth/oauth/${provider}/token`, {
    idToken: await idToken(provider, token),
    nonce: token.nonce,
    deviceName: 'iPhone',
    ...extra,
  })
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })
const userByEmail = (email: string) =>
  db.select().from(schema.users).where(eq(schema.users.email, email)).get()
function mustUser(email: string) {
  const user = userByEmail(email)
  if (!user) throw new Error(`No user ${email}`)
  return user
}
const identitiesOf = (userId: number) =>
  db.select().from(schema.userIdentities).where(eq(schema.userIdentities.userId, userId)).all()
const userIdOfToken = (token: string) =>
  (
    sqlite
      .prepare('SELECT user_id AS id FROM api_tokens WHERE token_hash = ?')
      .get(createHash('sha256').update(token).digest('hex')) as { id: number }
  ).id

beforeAll(async () => {
  ctx = await setup()
  const provider = await generateKeyPair('RS256', { extractable: true })
  providerKey = provider.privateKey
  strangerKey = (await generateKeyPair('RS256')).privateKey
  const jwk: JWK = { ...(await exportJWK(provider.publicKey)), kid: 'test-key', alg: 'RS256' }
  const jwks = createLocalJWKSet({ keys: [jwk] })
  const apple = await generateKeyPair('ES256', { extractable: true })
  applePublicKey = apple.publicKey
  config.google = {
    webClientId: GOOGLE_WEB,
    webClientSecret: 'google-web-secret-value',
    iosClientId: GOOGLE_IOS,
    androidClientId: null,
    audiences: [GOOGLE_WEB, GOOGLE_IOS],
  }
  config.apple = {
    teamId: 'TEAM123456',
    keyId: 'KEY1234567',
    privateKey: await exportPKCS8(apple.privateKey),
    servicesId: APPLE_WEB,
    bundleId: APPLE_APP,
    audiences: [APPLE_WEB, APPLE_APP],
  }
  setOAuthTransport({ jwks: () => jwks, fetch: fakeFetch as typeof fetch })
})

afterAll(() => setOAuthTransport(null))

beforeEach(() => {
  config.registrationOpen = true
  next.appleStatus = 200
  next.revokeStatus = 200
})

afterEach(() => {
  vi.useRealTimers()
})

describe('providers', () => {
  it('says which sign-in methods are on', async () => {
    const { json } = await call('GET', '/auth/providers')
    expect(res.authProvidersResponse.parse(json)).toEqual({
      registration: true,
      google: true,
      apple: true,
      googleIosClientId: GOOGLE_IOS,
      googleAndroidClientId: null,
    })
  })
})

describe('native sign-in', () => {
  it('creates the user and workspace with Google, then signs in again by sub', async () => {
    const first = await nativeSignIn('google', {
      sub: 'g-100',
      nonce: NONCE,
      email: 'Gina@Example.com',
      name: 'Gina',
    })
    expect(first.status).toBe(201)
    const token = res.apiTokenResponse.parse(first.json).token
    const me = res.meResponse.parse((await call('GET', '/auth/me', undefined, bearer(token))).json)
    expect(me).toMatchObject({ email: 'gina@example.com', name: 'Gina', hasPassword: false })
    expect(me.workspace.name).toBe("Gina's workspace")
    expect(userByEmail('gina@example.com')?.emailVerifiedAt).not.toBeNull()

    // Same sub with a changed email: still the same account.
    const again = await nativeSignIn('google', {
      sub: 'g-100',
      nonce: NONCE,
      email: 'gina.new@example.com',
    })
    expect(again.status).toBe(201)
    const meAgain = (await call('GET', '/auth/me', undefined, bearer(again.json.token))).json
    expect(meAgain.workspace.id).toBe(me.workspace.id)
    expect(userByEmail('gina.new@example.com')).toBeUndefined()
  })

  it('creates the user with Apple, stores the refresh token, and signs in later without an email', async () => {
    fetchCalls.length = 0
    next.appleRefreshToken = 'apple-refresh-token-first'
    const first = await nativeSignIn(
      'apple',
      { sub: 'a-200', nonce: NONCE, email: 'x7k2@privaterelay.appleid.com' },
      { authorizationCode: 'apple-auth-code-1', name: 'Amal Saleh' },
    )
    expect(first.status).toBe(201)
    const user = mustUser('x7k2@privaterelay.appleid.com')
    expect(user?.name).toBe('Amal Saleh')
    expect(identitiesOf(user.id)[0].appleRefreshToken).toBe('apple-refresh-token-first')

    const exchange = fetchCalls.find((c) => c.url === 'https://appleid.apple.com/auth/token')
    expect(exchange?.form).toMatchObject({
      grant_type: 'authorization_code',
      code: 'apple-auth-code-1',
      client_id: APPLE_APP,
    })
    // The client secret is an ES256 JWT from the team's key.
    const secret = exchange?.form.client_secret ?? ''
    expect(decodeProtectedHeader(secret)).toMatchObject({ alg: 'ES256', kid: 'KEY1234567' })
    const { payload } = await jwtVerify(secret, applePublicKey, {
      issuer: 'TEAM123456',
      audience: 'https://appleid.apple.com',
      subject: APPLE_APP,
    })
    expect(payload.exp).toBeGreaterThan(Date.now() / 1000)

    const later = await nativeSignIn('apple', { sub: 'a-200', nonce: NONCE, email: null })
    expect(later.status).toBe(201)
    expect(userIdOfToken(later.json.token)).toBe(user.id)
  })

  it('still signs in when Apple refuses the code exchange', async () => {
    next.appleStatus = 400
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const signedIn = await nativeSignIn(
      'apple',
      { sub: 'a-201', nonce: NONCE, email: 'refused@privaterelay.appleid.com' },
      { authorizationCode: 'bad-code' },
    )
    expect(signedIn.status).toBe(201)
    expect(errors).toHaveBeenCalled()
    errors.mockRestore()
    const user = mustUser('refused@privaterelay.appleid.com')
    expect(identitiesOf(user.id)[0].appleRefreshToken).toBeNull()
  })

  it('refuses a new Apple account without an email', async () => {
    const refused = await nativeSignIn('apple', { sub: 'a-unknown', nonce: NONCE, email: null })
    expect(refused.status).toBe(422)
  })

  it('links a Google sign-in to a verified password account with the same email', async () => {
    const owner = mustUser(EMAIL)
    const signedIn = await nativeSignIn('google', { sub: 'g-owner', nonce: NONCE, email: EMAIL })
    expect(signedIn.status).toBe(201)
    expect(userIdOfToken(signedIn.json.token)).toBe(owner.id)
    expect(userByEmail(EMAIL)?.passwordHash).toBe(owner.passwordHash)
    expect((await call('POST', '/auth/login', { email: EMAIL, password: PASSWORD })).status).toBe(
      200,
    )
  })

  it('takes over an unverified account with the same email, clearing its password', async () => {
    const email = 'squatted@example.com'
    expect(
      (
        await call('POST', '/auth/register', {
          email,
          password: 'squatter-password',
          workspaceName: 'Squat',
        })
      ).status,
    ).toBe(202)
    const squatter = mustUser(email)
    const squatterToken = createApiToken(squatter.id, 1, 'Old phone').token
    sqlite
      .prepare(
        'INSERT INTO auth_sessions (workspace_id, token_hash, user_id, expires_at, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?)',
      )
      .run('a-session-hash', squatter.id, '2099-01-01', '2026-01-01', '2026-01-01')

    const owner = await nativeSignIn('google', { sub: 'g-real-owner', nonce: NONCE, email })
    expect(owner.status).toBe(201)
    expect(userIdOfToken(owner.json.token)).toBe(squatter.id)
    const after = mustUser(email)
    expect(after.passwordHash).toBeNull()
    expect(after.emailVerifiedAt).not.toBeNull()
    expect((await call('GET', '/auth/me', undefined, bearer(squatterToken))).status).toBe(401)
    expect(
      sqlite.prepare('SELECT count(*) AS n FROM auth_sessions WHERE user_id = ?').get(squatter.id),
    ).toEqual({ n: 0 })
    expect(
      (await call('POST', '/auth/login', { email, password: 'squatter-password' })).status,
    ).toBe(401)
  })

  it('never asks for a TOTP code on Google or Apple sign-in', async () => {
    const email = 'totp-google@example.com'
    const created = await nativeSignIn('google', { sub: 'g-totp', nonce: NONCE, email })
    const as = bearer(created.json.token)
    const { secret } = (await call('POST', '/auth/totp/setup', undefined, as)).json
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) })
    expect((await call('POST', '/auth/totp/enable', { code: totp.generate() }, as)).status).toBe(
      200,
    )
    expect((await nativeSignIn('google', { sub: 'g-totp', nonce: NONCE, email })).status).toBe(201)
    // Without a password, a current code turns it off.
    expect((await call('POST', '/auth/totp/disable', { code: '000000' }, as)).status).toBe(422)
    const off = await call('POST', '/auth/totp/disable', { code: totp.generate() }, as)
    expect(off.json).toEqual({ totpEnabled: false })
  })

  it('answers registration_closed for a new person, and still signs in existing ones', async () => {
    config.registrationOpen = false
    const closed = await nativeSignIn('google', {
      sub: 'g-closed',
      nonce: NONCE,
      email: 'closed-google@example.com',
    })
    expect(closed.status).toBe(403)
    expect(closed.json.error).toBe('registration_closed')
    expect(userByEmail('closed-google@example.com')).toBeUndefined()
    expect((await nativeSignIn('google', { sub: 'g-100', nonce: NONCE })).status).toBe(201)
  })

  it('refuses tokens with a wrong aud, iss, nonce or signature, or that have expired', async () => {
    const bad: [string, 'google' | 'apple', TokenOptions, string?][] = [
      ['aud', 'google', { sub: 'g-bad', nonce: NONCE, aud: 'someone-else' }],
      ['iss', 'google', { sub: 'g-bad', nonce: NONCE, iss: 'https://evil.example.com' }],
      ['nonce', 'google', { sub: 'g-bad', nonce: 'another-nonce-value-123' }, NONCE],
      ['signature', 'google', { sub: 'g-bad', nonce: NONCE, key: strangerKey }],
      [
        'expired',
        'google',
        { sub: 'g-bad', nonce: NONCE, exp: Math.floor(Date.now() / 1000) - 60 },
      ],
      ['apple aud', 'apple', { sub: 'a-bad', nonce: NONCE, aud: GOOGLE_IOS }],
      ['apple iss', 'apple', { sub: 'a-bad', nonce: NONCE, iss: 'https://accounts.google.com' }],
      ['apple nonce', 'apple', { sub: 'a-bad', nonce: 'another-nonce-value-123' }, NONCE],
    ]
    for (const [what, provider, token, sentNonce] of bad) {
      const answer = await call('POST', `/auth/oauth/${provider}/token`, {
        idToken: await idToken(provider, token),
        nonce: sentNonce ?? token.nonce,
        deviceName: 'iPhone',
      })
      expect(answer.status, what).toBe(401)
    }
    // Apple's token carries the SHA-256 of the nonce, never the raw value.
    const raw = await new SignJWT({ nonce: NONCE, email: 'raw@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setSubject('a-raw')
      .setIssuer('https://appleid.apple.com')
      .setAudience(APPLE_APP)
      .setExpirationTime('5m')
      .sign(providerKey)
    const rawAnswer = await call('POST', '/auth/oauth/apple/token', {
      idToken: raw,
      nonce: NONCE,
      deviceName: 'iPhone',
    })
    expect(rawAnswer.status).toBe(401)
    expect(userByEmail('g-bad@example.com')).toBeUndefined()
  })

  it('refuses a Google account whose email Google has not verified', async () => {
    const answer = await nativeSignIn('google', {
      sub: 'g-unverified',
      nonce: NONCE,
      email: EMAIL,
      emailVerified: false,
    })
    expect(answer.status).toBe(403)
    expect(identitiesOf(mustUser(EMAIL).id).map((i) => i.subject)).not.toContain('g-unverified')
  })

  it('answers 404 for an unknown or unconfigured provider', async () => {
    const answer = await call('POST', '/auth/oauth/github/token', {
      idToken: 'x'.repeat(40),
      nonce: NONCE,
      deviceName: 'iPhone',
    })
    expect(answer.status).toBe(404)
  })

  it('rate limits the token endpoint by client address', async () => {
    const headers = { 'X-Real-IP': '198.51.100.99' }
    const statuses: number[] = []
    for (let i = 0; i < 31; i += 1) {
      const answer = await call(
        'POST',
        '/auth/oauth/google/token',
        {
          idToken: await idToken('google', { sub: 'g-limit', nonce: NONCE, aud: 'wrong' }),
          nonce: NONCE,
          deviceName: 'iPhone',
        },
        headers,
      )
      statuses.push(answer.status)
    }
    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true)
    expect(statuses[30]).toBe(429)
  })
})

describe('linking and unlinking', () => {
  it('links from the app, lists identities, and refuses one linked to someone else', async () => {
    const linker = await nativeSignIn('google', {
      sub: 'g-linker',
      nonce: NONCE,
      email: 'linker@example.com',
    })
    const as = bearer(linker.json.token)
    const linked = await call(
      'POST',
      '/auth/oauth/apple/link',
      {
        idToken: await idToken('apple', { sub: 'a-linker', nonce: NONCE, email: null }),
        nonce: NONCE,
      },
      as,
    )
    expect(linked.status).toBe(201)
    expect(res.identityResponse.parse(linked.json)).toMatchObject({
      provider: 'apple',
      email: null,
    })

    const list = await call('GET', '/auth/identities', undefined, as)
    expect(list.json.map((i: { provider: string }) => i.provider)).toEqual(['google', 'apple'])
    for (const row of list.json) res.identityResponse.parse(row)

    // Gina's Google account belongs to Gina.
    const taken = await call(
      'POST',
      '/auth/oauth/google/link',
      { idToken: await idToken('google', { sub: 'g-100', nonce: NONCE }), nonce: NONCE },
      as,
    )
    expect(taken.status).toBe(409)
    expect(taken.json.error).toBe('That account is linked to another user')
  })

  it('refuses to unlink the last way to sign in', async () => {
    const solo = await nativeSignIn('google', {
      sub: 'g-solo',
      nonce: NONCE,
      email: 'solo@example.com',
    })
    const as = bearer(solo.json.token)
    const refused = await call('DELETE', '/auth/identities/google', undefined, as)
    expect(refused.status).toBe(409)
    expect((await call('DELETE', '/auth/identities/apple', undefined, as)).status).toBe(404)

    // A Google user can add a password without a current one, and then unlink.
    const set = await call('POST', '/auth/password', { newPassword: 'solo-password-123' }, as)
    expect(set.status).toBe(200)
    expect((await call('GET', '/auth/me', undefined, as)).json.hasPassword).toBe(true)
    expect((await call('DELETE', '/auth/identities/google', undefined, as)).status).toBe(200)
    expect((await call('GET', '/auth/identities', undefined, as)).json).toEqual([])
    expect(
      (
        await call('POST', '/auth/login', {
          email: 'solo@example.com',
          password: 'solo-password-123',
        })
      ).status,
    ).toBe(200)
  })

  it('lets a user with two providers unlink one but not both', async () => {
    const two = await nativeSignIn('google', {
      sub: 'g-two',
      nonce: NONCE,
      email: 'two@example.com',
    })
    const as = bearer(two.json.token)
    await call(
      'POST',
      '/auth/oauth/apple/link',
      { idToken: await idToken('apple', { sub: 'a-two', nonce: NONCE }), nonce: NONCE },
      as,
    )
    expect((await call('DELETE', '/auth/identities/google', undefined, as)).status).toBe(200)
    expect((await call('DELETE', '/auth/identities/apple', undefined, as)).status).toBe(409)
  })
})

/* The web redirect flow */

function cookieValue(response: Response, name: string) {
  const header = response.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))
  return header?.split(';')[0]
}

async function start(
  provider: 'google' | 'apple',
  query = '',
  headers: Record<string, string> = {},
) {
  const response = await ctx.app.request(`/api/v1/auth/oauth/${provider}/start${query}`, {
    headers,
  })
  expect(response.status).toBe(302)
  const location = new URL(response.headers.get('location') ?? '', 'http://app.local')
  return { response, location, cookie: cookieValue(response, 'oauth_state') ?? '' }
}

async function appleCallback(form: Record<string, string>, cookie: string) {
  return ctx.app.request('/api/v1/auth/oauth/apple/callback', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: 'https://appleid.apple.com',
      Cookie: cookie,
    },
    body: new URLSearchParams(form).toString(),
  })
}

describe('web sign-in', () => {
  it('signs in with Google through the redirect flow, with PKCE and the state cookie', async () => {
    const { location, cookie, response } = await start('google')
    expect(location.origin + location.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    const params = location.searchParams
    expect(params.get('client_id')).toBe(GOOGLE_WEB)
    expect(params.get('redirect_uri')).toBe(`${config.appUrl}/api/v1/auth/oauth/google/callback`)
    expect(params.get('scope')).toBe('openid email profile')
    expect(params.get('code_challenge_method')).toBe('S256')
    const setCookie = response.headers.getSetCookie().find((c) => c.startsWith('oauth_state='))
    expect(setCookie).toMatch(/HttpOnly/)
    expect(setCookie).toMatch(/Max-Age=600/)

    next.googleIdToken = await idToken('google', {
      sub: 'g-web',
      nonce: params.get('nonce') ?? '',
      email: 'web@example.com',
      aud: GOOGLE_WEB,
    })
    fetchCalls.length = 0
    const callback = await ctx.app.request(
      `/api/v1/auth/oauth/google/callback?code=google-code&state=${params.get('state')}`,
      { headers: { Cookie: cookie } },
    )
    expect(callback.status).toBe(302)
    expect(callback.headers.get('location')).toBe('/')
    const exchange = fetchCalls[0]
    expect(exchange.form).toMatchObject({
      code: 'google-code',
      client_id: GOOGLE_WEB,
      client_secret: 'google-web-secret-value',
    })
    expect(createHash('sha256').update(exchange.form.code_verifier).digest('base64url')).toBe(
      params.get('code_challenge'),
    )
    const session = cookieValue(callback, 'session')
    expect(session).toBeTruthy()
    const me = await call('GET', '/auth/me', undefined, { Cookie: session ?? '' })
    expect(me.json.email).toBe('web@example.com')

    // The state cookie works once.
    const replay = await ctx.app.request(
      `/api/v1/auth/oauth/google/callback?code=google-code&state=${params.get('state')}`,
      { headers: { Cookie: cookie } },
    )
    expect(replay.headers.get('location')).toBe('/login?error=oauth_failed')
  })

  it('refuses a callback with a bad, missing, forged or expired state', async () => {
    const { location, cookie } = await start('google')
    const state = location.searchParams.get('state')
    next.googleIdToken = await idToken('google', {
      sub: 'g-web-bad',
      nonce: location.searchParams.get('nonce') ?? '',
      aud: GOOGLE_WEB,
    })
    const tries = [
      `?code=c&state=not-the-state`,
      `?code=c&state=${state}&cookie=none`,
      `?code=c&state=${state}&cookie=forged`,
      `?error=access_denied&state=${state}`,
    ]
    for (const query of tries) {
      const sent = query.includes('cookie=none')
        ? ''
        : query.includes('cookie=forged')
          ? `${cookie.slice(0, -4)}AAAA`
          : cookie
      const response = await ctx.app.request(`/api/v1/auth/oauth/google/callback${query}`, {
        headers: { Cookie: sent },
      })
      expect(response.headers.get('location'), query).toBe('/login?error=oauth_failed')
      expect(cookieValue(response, 'session')).toBeUndefined()
    }

    const late = await start('google')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 11 * 60 * 1000)
    const expired = await ctx.app.request(
      `/api/v1/auth/oauth/google/callback?code=c&state=${late.location.searchParams.get('state')}`,
      { headers: { Cookie: late.cookie } },
    )
    expect(expired.headers.get('location')).toBe('/login?error=oauth_failed')
    expect(userByEmail('g-web-bad@example.com')).toBeUndefined()
  })

  it('signs in with Apple through form_post, despite the cross-site Origin', async () => {
    const { location, cookie } = await start('apple')
    const params = location.searchParams
    expect(location.origin + location.pathname).toBe('https://appleid.apple.com/auth/authorize')
    expect(params.get('client_id')).toBe(APPLE_WEB)
    expect(params.get('response_mode')).toBe('form_post')
    expect(params.get('response_type')).toBe('code id_token')
    expect(params.get('scope')).toBe('name email')
    // The URL carries the SHA-256, like the app's request; the token then carries the same.
    const hashedNonce = params.get('nonce') ?? ''
    expect(hashedNonce).toMatch(/^[0-9a-f]{64}$/)
    const token = await new SignJWT({
      nonce: hashedNonce,
      email: 'apple-web@privaterelay.appleid.com',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setSubject('a-web')
      .setIssuer('https://appleid.apple.com')
      .setAudience(APPLE_WEB)
      .setExpirationTime('5m')
      .sign(providerKey)

    fetchCalls.length = 0
    next.appleRefreshToken = 'apple-refresh-token-web'
    const callback = await appleCallback(
      {
        code: 'apple-web-code',
        id_token: token,
        state: params.get('state') ?? '',
        user: JSON.stringify({ name: { firstName: 'Web', lastName: 'Apple' } }),
      },
      cookie,
    )
    expect(callback.status).toBe(302)
    expect(callback.headers.get('location')).toBe('/')
    expect(fetchCalls[0].form).toMatchObject({
      code: 'apple-web-code',
      client_id: APPLE_WEB,
      redirect_uri: `${config.appUrl}/api/v1/auth/oauth/apple/callback`,
    })
    const user = mustUser('apple-web@privaterelay.appleid.com')
    expect(user.name).toBe('Web Apple')
    expect(identitiesOf(user.id)[0].appleRefreshToken).toBe('apple-refresh-token-web')
  })

  it('refuses the Apple callback without a valid state cookie, and other cross-site writes', async () => {
    const { location } = await start('apple')
    const noCookie = await appleCallback(
      { code: 'c', id_token: 'x', state: location.searchParams.get('state') ?? '' },
      '',
    )
    expect(noCookie.status).toBe(302)
    expect(noCookie.headers.get('location')).toBe('/login?error=oauth_failed')
    for (const route of ['/auth/logout', '/auth/login', '/auth/oauth/apple/token']) {
      const crossSite = await ctx.app.request(`/api/v1${route}`, {
        method: 'POST',
        headers: { Origin: 'https://appleid.apple.com', 'Content-Type': 'application/json' },
        body: '{}',
      })
      expect(crossSite.status, route).toBe(403)
    }
  })

  it('redirects with the error code the login page shows', async () => {
    config.registrationOpen = false
    const closed = await start('google')
    next.googleIdToken = await idToken('google', {
      sub: 'g-web-closed',
      nonce: closed.location.searchParams.get('nonce') ?? '',
      aud: GOOGLE_WEB,
    })
    const response = await ctx.app.request(
      `/api/v1/auth/oauth/google/callback?code=c&state=${closed.location.searchParams.get('state')}`,
      { headers: { Cookie: closed.cookie } },
    )
    expect(response.headers.get('location')).toBe('/login?error=registration_closed')

    const unverified = await start('google')
    next.googleIdToken = await idToken('google', {
      sub: 'g-web-unverified',
      nonce: unverified.location.searchParams.get('nonce') ?? '',
      aud: GOOGLE_WEB,
      emailVerified: false,
    })
    const refused = await ctx.app.request(
      `/api/v1/auth/oauth/google/callback?code=c&state=${unverified.location.searchParams.get('state')}`,
      { headers: { Cookie: unverified.cookie } },
    )
    expect(refused.headers.get('location')).toBe('/login?error=email_not_verified')
  })

  it('links from Settings on the web, and reports already_linked', async () => {
    expect((await start('google', '?intent=link')).location.pathname).toBe('/login')

    const linking = await start('apple', '?intent=link', { Cookie: ctx.cookie })
    const token = await new SignJWT({ nonce: linking.location.searchParams.get('nonce') ?? '' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setSubject('a-owner-web')
      .setIssuer('https://appleid.apple.com')
      .setAudience(APPLE_WEB)
      .setExpirationTime('5m')
      .sign(providerKey)
    const linked = await appleCallback(
      { code: 'c', id_token: token, state: linking.location.searchParams.get('state') ?? '' },
      linking.cookie,
    )
    expect(linked.headers.get('location')).toBe('/settings/account?linked=apple')
    const owner = mustUser(EMAIL)
    expect(identitiesOf(owner.id).map((i) => i.subject)).toContain('a-owner-web')

    const again = await start('google', '?intent=link', { Cookie: ctx.cookie })
    next.googleIdToken = await idToken('google', {
      sub: 'g-100',
      nonce: again.location.searchParams.get('nonce') ?? '',
      aud: GOOGLE_WEB,
    })
    const taken = await ctx.app.request(
      `/api/v1/auth/oauth/google/callback?code=c&state=${again.location.searchParams.get('state')}`,
      { headers: { Cookie: again.cookie } },
    )
    expect(taken.headers.get('location')).toBe('/settings/account?error=already_linked')
  })
})

describe('return path after web sign-in', () => {
  async function googleRoundTrip(query: string, sub: string, headers: Record<string, string> = {}) {
    const started = await start('google', query, headers)
    next.googleIdToken = await idToken('google', {
      sub,
      nonce: started.location.searchParams.get('nonce') ?? '',
      aud: GOOGLE_WEB,
    })
    const callback = await ctx.app.request(
      `/api/v1/auth/oauth/google/callback?code=c&state=${started.location.searchParams.get('state')}`,
      { headers: { Cookie: started.cookie } },
    )
    return callback.headers.get('location')
  }

  it('returns to a same-origin path after signing in', async () => {
    const back = await googleRoundTrip(
      `?intent=signin&return=${encodeURIComponent('/settings/account?tab=danger')}`,
      'g-return',
    )
    expect(back).toBe('/settings/account?tab=danger')
  })

  it('ignores paths that could leave the site', async () => {
    const attempts = [
      '//evil.com',
      'https://evil.com',
      '/\\evil.com',
      '/\\/evil.com',
      'evil.com',
      'javascript:alert(1)',
      '/ok\nLocation: https://evil.com',
      `/${'a'.repeat(200)}`,
    ]
    for (const attempt of attempts) {
      const back = await googleRoundTrip(`?return=${encodeURIComponent(attempt)}`, 'g-return')
      expect(back, attempt).toBe('/')
    }
  })

  it('keeps linked=<provider> on the return path when linking', async () => {
    const back = await googleRoundTrip(
      `?intent=link&return=${encodeURIComponent('/settings/account?from=delete#methods')}`,
      'g-return-link',
      { Cookie: ctx.cookie },
    )
    expect(back).toBe('/settings/account?from=delete&linked=google#methods')
    const plain = await googleRoundTrip('?intent=link&return=//evil.com', 'g-return-link', {
      Cookie: ctx.cookie,
    })
    expect(plain).toBe('/settings/account?linked=google')
  })

  it('still sends errors to the login page', async () => {
    const started = await start('google', `?return=${encodeURIComponent('/settings/account')}`)
    const failed = await ctx.app.request(
      `/api/v1/auth/oauth/google/callback?code=c&state=wrong-state`,
      { headers: { Cookie: started.cookie } },
    )
    expect(failed.headers.get('location')).toBe('/login?error=oauth_failed')
  })
})

describe('account deletion with Apple', () => {
  it('asks for a recent sign-in, then revokes the Apple token and deletes everything', async () => {
    next.appleRefreshToken = 'apple-refresh-token-delete'
    const signedIn = await nativeSignIn(
      'apple',
      { sub: 'a-delete', nonce: NONCE, email: 'leaving@privaterelay.appleid.com' },
      { authorizationCode: 'code-delete' },
    )
    const user = mustUser('leaving@privaterelay.appleid.com')
    const ws = (
      sqlite
        .prepare('SELECT workspace_id AS w FROM memberships WHERE user_id = ?')
        .get(user.id) as {
        w: number
      }
    ).w
    const files = (
      sqlite.prepare('SELECT pdf_file AS f FROM templates WHERE workspace_id = ?').all(ws) as {
        f: string
      }[]
    ).map((r) => r.f)
    const as = bearer(signedIn.json.token)
    await call('POST', '/customers', { name: 'Leaving Co', currency: 'USD' }, as)
    const ownerCustomers = (await ctx.api('GET', '/customers')).json.length

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 11 * 60 * 1000)
    const stale = await call('DELETE', '/auth/account', undefined, as)
    expect(stale.status).toBe(403)
    expect(stale.json.error).toBe('recent_sign_in_required')
    expect(userByEmail('leaving@privaterelay.appleid.com')).toBeDefined()

    // A fresh sign-in is recent enough. Apple failing to revoke doesn't block deletion.
    const fresh = await nativeSignIn('apple', { sub: 'a-delete', nonce: NONCE, email: null })
    fetchCalls.length = 0
    next.revokeStatus = 500
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const deleted = await call('DELETE', '/auth/account', undefined, bearer(fresh.json.token))
    errors.mockRestore()
    expect(deleted.status).toBe(200)
    const revokes = fetchCalls.filter((c) => c.url === 'https://appleid.apple.com/auth/revoke')
    expect(revokes.length).toBeGreaterThan(0)
    expect(revokes[0].form).toMatchObject({
      token: 'apple-refresh-token-delete',
      token_type_hint: 'refresh_token',
    })

    expect(userByEmail('leaving@privaterelay.appleid.com')).toBeUndefined()
    expect(
      sqlite.prepare('SELECT count(*) AS n FROM user_identities WHERE user_id = ?').get(user.id),
    ).toEqual({ n: 0 })
    expect(
      sqlite.prepare('SELECT count(*) AS n FROM customers WHERE workspace_id = ?').get(ws),
    ).toEqual({ n: 0 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM workspaces WHERE id = ?').get(ws)).toEqual({
      n: 0,
    })
    for (const key of files) expect(fs.existsSync(path.join(config.filesDir, key))).toBe(false)
    expect((await ctx.api('GET', '/customers')).json.length).toBe(ownerCustomers)
  })

  it('revokes with the client id Apple accepts', async () => {
    next.appleRefreshToken = 'apple-refresh-token-ok'
    const signedIn = await nativeSignIn(
      'apple',
      { sub: 'a-delete-2', nonce: NONCE, email: 'leaving2@privaterelay.appleid.com' },
      { authorizationCode: 'code-2' },
    )
    fetchCalls.length = 0
    const deleted = await call('DELETE', '/auth/account', {}, bearer(signedIn.json.token))
    expect(deleted.status).toBe(200)
    const revokes = fetchCalls.filter((c) => c.url === 'https://appleid.apple.com/auth/revoke')
    expect(revokes).toHaveLength(1)
    expect(revokes[0].form.client_id).toBe(APPLE_WEB)
  })
})

describe('secrets', () => {
  it('keeps refresh tokens, ID tokens and client secrets out of responses and logs', async () => {
    const logs: string[] = []
    const capture = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    }
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(capture),
      vi.spyOn(console, 'error').mockImplementation(capture),
      vi.spyOn(console, 'warn').mockImplementation(capture),
    ]
    next.appleRefreshToken = 'apple-refresh-token-secret'
    next.appleStatus = 200
    const id = await idToken('apple', { sub: 'a-secret', nonce: NONCE, email: 's@example.com' })
    const signedIn = await call('POST', '/auth/oauth/apple/token', {
      idToken: id,
      nonce: NONCE,
      authorizationCode: 'code-secret',
      deviceName: 'iPhone',
    })
    const as = bearer(signedIn.json.token)
    const bodies = [
      JSON.stringify(signedIn.json),
      JSON.stringify((await call('GET', '/auth/identities', undefined, as)).json),
      JSON.stringify((await call('GET', '/auth/me', undefined, as)).json),
      JSON.stringify((await call('GET', '/auth/tokens', undefined, as)).json),
    ]
    next.appleStatus = 400
    await call('POST', '/auth/oauth/apple/token', {
      idToken: id,
      nonce: NONCE,
      authorizationCode: 'code-secret',
      deviceName: 'iPhone',
    })
    for (const s of spies) s.mockRestore()
    const everything = [...bodies, ...logs].join('\n')
    for (const secret of [
      'apple-refresh-token-secret',
      id,
      'code-secret',
      'google-web-secret-value',
      config.apple?.privateKey ?? 'none',
    ]) {
      expect(everything).not.toContain(secret)
    }
    expect(bodies[1]).not.toContain('appleRefreshToken')
  })
})
