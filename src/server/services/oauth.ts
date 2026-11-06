import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  createRemoteJWKSet,
  importPKCS8,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
  SignJWT,
} from 'jose'
import type { ProviderName } from '../../shared/auth.ts'
import { config } from '../config.ts'
import { ApiError } from '../errors.ts'

/**
 * Google and Apple sign-in (plan 23): ID token checks, code exchange, Apple's client secret and
 * token revocation. Nothing here reads or writes the database.
 */

const ISSUERS: Record<ProviderName, string[]> = {
  google: ['https://accounts.google.com', 'accounts.google.com'],
  apple: ['https://appleid.apple.com'],
}
const JWKS_URLS: Record<ProviderName, string> = {
  google: 'https://www.googleapis.com/oauth2/v3/certs',
  apple: 'https://appleid.apple.com/auth/keys',
}
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'
const APPLE_AUTH = 'https://appleid.apple.com/auth/authorize'
const APPLE_TOKEN = 'https://appleid.apple.com/auth/token'
const APPLE_REVOKE = 'https://appleid.apple.com/auth/revoke'

export interface OAuthTransport {
  jwks: (provider: ProviderName) => JWTVerifyGetKey
  fetch: typeof fetch
}

const remoteJwks = new Map<ProviderName, JWTVerifyGetKey>()
const defaultTransport: OAuthTransport = {
  jwks: (provider) => {
    let set = remoteJwks.get(provider)
    if (!set) {
      // jose caches the keys and refetches when a token names a key it hasn't seen.
      set = createRemoteJWKSet(new URL(JWKS_URLS[provider]))
      remoteJwks.set(provider, set)
    }
    return set
  },
  fetch: (...args) => fetch(...args),
}
let transport = defaultTransport

/** For tests only: a local JWKS and a fake token endpoint, so tests never call Google or Apple. */
export function setOAuthTransport(next: Partial<OAuthTransport> | null) {
  transport = next ? { ...defaultTransport, ...next } : defaultTransport
}

export const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex')

/** An error the web callback turns into `?error=<code>`. Its message is safe to show. */
export class OAuthError extends ApiError {
  code: 'oauth_failed' | 'registration_closed' | 'already_linked' | 'email_not_verified'

  constructor(status: ApiError['status'], code: OAuthError['code'], message: string) {
    super(status, message)
    this.code = code
  }
}

export const signInFailed = () =>
  new OAuthError(401, 'oauth_failed', 'That sign-in could not be checked. Try again.')

export function providerConfigured(provider: ProviderName) {
  return provider === 'google' ? config.google !== null : config.apple !== null
}

/** Whether the web redirect flow can run, which needs a web client id and its secret. */
export function webConfigured(provider: ProviderName) {
  if (provider === 'google') {
    return Boolean(config.google?.webClientId && config.google.webClientSecret)
  }
  return Boolean(config.apple?.servicesId)
}

export interface VerifiedIdentity {
  provider: ProviderName
  subject: string
  /** Lower case. Null when Apple leaves it out, which it may after the first sign-in. */
  email: string | null
  /** Google's `email_verified`. Apple's addresses, private relay included, always count. */
  emailVerified: boolean
  name: string | null
}

/**
 * Checks the signature against the provider's keys, `iss`, `aud`, `exp` and the nonce. Google puts
 * the raw nonce in the token; Apple puts its SHA-256 in hex. Throws `oauth_failed` otherwise.
 */
export async function verifyIdToken(
  provider: ProviderName,
  idToken: string,
  rawNonce: string,
): Promise<VerifiedIdentity> {
  const audiences = provider === 'google' ? config.google?.audiences : config.apple?.audiences
  if (!audiences?.length) throw signInFailed()
  let payload: JWTPayload
  try {
    ;({ payload } = await jwtVerify(idToken, transport.jwks(provider), {
      issuer: ISSUERS[provider],
      audience: audiences,
      algorithms: ['RS256'],
      requiredClaims: ['sub', 'exp', 'nonce'],
    }))
  } catch {
    throw signInFailed()
  }
  const expectedNonce = provider === 'google' ? rawNonce : sha256Hex(rawNonce)
  if (typeof payload.sub !== 'string' || !payload.sub || payload.nonce !== expectedNonce) {
    throw signInFailed()
  }
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : null
  const emailVerified =
    provider === 'apple' ? email !== null : payload.email_verified === true && email !== null
  if (provider === 'google' && !emailVerified) {
    throw new OAuthError(
      403,
      'email_not_verified',
      'Google has not verified the email address of that account',
    )
  }
  const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : null
  return { provider, subject: payload.sub, email, emailVerified, name }
}

/* Web redirect flow */

/** What the web flow keeps in its short-lived cookie between the start and the callback. */
export interface OAuthState {
  provider: ProviderName
  state: string
  /** The raw nonce. Google's token carries it as is, Apple's carries its SHA-256. */
  nonce: string
  /** The PKCE code verifier (Google). */
  verifier: string
  intent: 'signin' | 'link'
  /** The signed-in user, for `link`. Apple's callback is a cross-site POST without our session. */
  userId: number | null
  /** Where to go after success: a same-origin path from `safeReturnPath`, or null for the default. */
  returnTo: string | null
  expiresAt: number
}

/**
 * A same-origin relative path to return to after sign-in, or null. Refuses anything that could
 * leave the site: `//host`, `/\host`, a scheme, backslashes and control characters.
 */
export function safeReturnPath(value: string | undefined): string | null {
  if (!value || value.length > 200) return null
  if (!value.startsWith('/') || value[1] === '/' || value.includes('\\')) return null
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
  if (/[\u0000-\u001f\u007f]/.test(value)) return null
  const base = 'http://return.invalid'
  const url = new URL(value, base)
  return url.origin === base ? `${url.pathname}${url.search}${url.hash}` : null
}

export const STATE_TTL_MS = 10 * 60 * 1000
let stateKey: Buffer | null = null

/**
 * The state cookie's HMAC key: random, made on first use and kept in the data directory, so it
 * needs no setting and survives restarts.
 */
function stateSigningKey() {
  if (stateKey) return stateKey
  const file = path.join(config.dataDir, 'oauth-state.key')
  if (!fs.existsSync(file)) {
    fs.mkdirSync(config.dataDir, { recursive: true })
    try {
      fs.writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex')
  if (key.length < 32) throw new Error(`${file} is not a valid key. Delete it to make a new one.`)
  stateKey = key
  return key
}

const mac = (body: string) =>
  createHmac('sha256', stateSigningKey()).update(body).digest('base64url')

export function sealState(state: OAuthState) {
  const body = Buffer.from(JSON.stringify(state)).toString('base64url')
  return `${body}.${mac(body)}`
}

/** States already used, kept until they expire. One process holds them (docs/ARCHITECTURE.md, rule 10). */
const usedStates = new Map<string, number>()

/**
 * The state, or null when the cookie is missing, forged, expired or already used. Each state
 * opens once, so a copied cookie can't be replayed.
 */
export function consumeState(value: string | undefined): OAuthState | null {
  const state = openState(value)
  const now = Date.now()
  for (const [key, expiresAt] of usedStates) if (expiresAt <= now) usedStates.delete(key)
  if (!state || usedStates.has(state.state)) return null
  usedStates.set(state.state, state.expiresAt)
  return state
}

function openState(value: string | undefined): OAuthState | null {
  const [body, signature, extra] = (value ?? '').split('.')
  if (!body || !signature || extra !== undefined) return null
  const expected = Buffer.from(mac(body))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
  try {
    const state = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OAuthState
    return state.expiresAt > Date.now() ? state : null
  } catch {
    return null
  }
}

export const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export const callbackUrl = (provider: ProviderName) =>
  `${config.appUrl}/api/v1/auth/oauth/${provider}/callback`

const pkceChallenge = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url')

export function authorizationUrl(
  provider: ProviderName,
  state: { state: string; nonce: string; verifier: string },
) {
  if (provider === 'google') {
    const url = new URL(GOOGLE_AUTH)
    url.search = new URLSearchParams({
      client_id: config.google?.webClientId ?? '',
      redirect_uri: callbackUrl('google'),
      response_type: 'code',
      scope: 'openid email profile',
      state: state.state,
      nonce: state.nonce,
      code_challenge: pkceChallenge(state.verifier),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString()
    return url.toString()
  }
  const url = new URL(APPLE_AUTH)
  url.search = new URLSearchParams({
    client_id: config.apple?.servicesId ?? '',
    redirect_uri: callbackUrl('apple'),
    response_type: 'code id_token',
    response_mode: 'form_post',
    scope: 'name email',
    state: state.state,
    // The same as the iOS app: Apple's token carries what we send, so send the SHA-256.
    nonce: sha256Hex(state.nonce),
  }).toString()
  return url.toString()
}

async function postForm(url: string, form: Record<string, string>) {
  const response = await transport.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
  })
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null
  return { ok: response.ok, status: response.status, json }
}

/** Exchanges the web flow's code for Google's ID token. */
export async function exchangeGoogleCode(code: string, verifier: string) {
  const google = config.google
  if (!google?.webClientId || !google.webClientSecret) throw signInFailed()
  const result = await postForm(GOOGLE_TOKEN, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: google.webClientId,
    client_secret: google.webClientSecret,
    redirect_uri: callbackUrl('google'),
  })
  const idToken = result.json?.id_token
  if (!result.ok || typeof idToken !== 'string') {
    console.error(`Google code exchange failed with status ${result.status}`)
    throw signInFailed()
  }
  return idToken
}

/** Apple's client secret: a short-lived ES256 JWT signed with the team's Sign in with Apple key. */
export async function appleClientSecret(clientId: string) {
  const apple = config.apple
  if (!apple) throw signInFailed()
  const key = await importPKCS8(apple.privateKey, 'ES256')
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: apple.keyId })
    .setIssuer(apple.teamId)
    .setSubject(clientId)
    .setAudience('https://appleid.apple.com')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key)
}

/**
 * Exchanges an Apple authorization code for the refresh token, which is revoked when the account
 * is deleted. `clientId` is the Services ID on the web and the bundle id from the app. Returns
 * null, and logs, when Apple refuses: sign-in still goes ahead on the verified ID token.
 */
export async function exchangeAppleCode(code: string, clientId: string, redirectUri?: string) {
  try {
    const result = await postForm(APPLE_TOKEN, {
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: await appleClientSecret(clientId),
      ...(redirectUri ? { redirect_uri: redirectUri } : {}),
    })
    const refreshToken = result.json?.refresh_token
    if (result.ok && typeof refreshToken === 'string') return refreshToken
    console.error(`Apple code exchange failed with status ${result.status}`)
  } catch (error) {
    console.error('Apple code exchange failed', error instanceof Error ? error.message : error)
  }
  return null
}

/**
 * Revokes an Apple refresh token, as Apple requires when an account is deleted. The token was
 * issued to either the web Services ID or the app's bundle id, so each is tried until Apple
 * accepts one. Failures are logged and never thrown.
 */
export async function revokeAppleToken(refreshToken: string) {
  const apple = config.apple
  if (!apple) {
    console.error('Could not revoke an Apple token: Sign in with Apple is not configured')
    return false
  }
  for (const clientId of apple.audiences) {
    try {
      const result = await postForm(APPLE_REVOKE, {
        token: refreshToken,
        token_type_hint: 'refresh_token',
        client_id: clientId,
        client_secret: await appleClientSecret(clientId),
      })
      if (result.ok) return true
    } catch (error) {
      console.error('Apple token revoke failed', error instanceof Error ? error.message : error)
    }
  }
  console.error('Apple did not accept the token revoke for any configured client id')
  return false
}
