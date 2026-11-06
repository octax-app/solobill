import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { eq } from 'drizzle-orm'
import type { Context, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import * as OTPAuth from 'otpauth'
import { config } from './config.ts'
import { db, schema } from './db/index.ts'
import { ApiError } from './errors.ts'
import { membership } from './services/workspaces.ts'

const { apiTokens, authSessions, users } = schema
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  length: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }
const SESSION_DAYS = 30
export const SESSION_COOKIE = 'session'

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await scryptAsync(password, salt, 64, SCRYPT)
  return `${salt.toString('hex')}:${hash.toString('hex')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(':')
  const actual = await scryptAsync(password, Buffer.from(salt, 'hex'), 64, SCRYPT)
  return timingSafeEqual(actual, Buffer.from(hash, 'hex'))
}

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
export const newToken = () => randomBytes(32).toString('base64url')

export function totpFor(secret: string, email: string) {
  return new OTPAuth.TOTP({
    issuer: 'Octax Solobill',
    label: email,
    secret: OTPAuth.Secret.fromBase32(secret),
  })
}

export const newTotpSecret = () => new OTPAuth.Secret({ size: 20 }).base32

export const checkTotp = (secret: string, email: string, code: string) =>
  totpFor(secret, email).validate({ token: code.replace(/\s/g, ''), window: 1 }) !== null

/*
 * In-memory limits, fine because the server is one process (docs/ARCHITECTURE.md, rule 10). Keys name the
 * action and what they count, such as `login:email:a@b.c` or `register:ip:1.2.3.4`.
 */
const failures = new Map<string, { count: number; firstAt: number }>()
const WINDOW_MS = 15 * 60 * 1000
const MAX_FAILURES = 5
/** Higher, because one address can be shared by an office or a proxy. */
const MAX_PER_IP = 30

const limitFor = (key: string) => (key.includes(':ip:') ? MAX_PER_IP : MAX_FAILURES)

export function assertNotLimited(key: string) {
  const entry = failures.get(key)
  if (!entry) return
  if (Date.now() - entry.firstAt > WINDOW_MS) failures.delete(key)
  else if (entry.count >= limitFor(key)) {
    throw new ApiError(429, 'Too many failed attempts. Try again in 15 minutes.')
  }
}

export function recordFailure(key: string) {
  const entry = failures.get(key)
  if (entry && Date.now() - entry.firstAt <= WINDOW_MS) entry.count += 1
  else failures.set(key, { count: 1, firstAt: Date.now() })
}

export const clearFailures = (key: string) => failures.delete(key)

/** The limiter keys of an action, by email (when there is one) and by client address. */
export function limitKeys(action: string, ip: string, email?: string) {
  return [`${action}:ip:${ip}`, ...(email ? [`${action}:email:${email.toLowerCase()}`] : [])]
}

/** For actions that always succeed, such as sending an email: every attempt counts. */
export function countAttempt(keys: string[]) {
  for (const key of keys) assertNotLimited(key)
  for (const key of keys) recordFailure(key)
}

/**
 * The client's address. Nginx passes on the `X-Real-IP` and `X-Forwarded-For` that Traefik sets
 * in front of it; the app is only reachable through them. Requests without either, such as
 * tests and local development, share the key `local`.
 */
export function clientIp(c: Context) {
  const real = c.req.header('x-real-ip')?.trim()
  if (real) return real
  const forwarded = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim()
  return forwarded || 'local'
}

/** Compared against when there is no user, so a wrong email takes as long as a wrong password. */
let dummyHash: Promise<string> | null = null

/**
 * Checks password and, if enabled, the 6-digit code. Returns the user or throws. A correct
 * password on an unverified account answers 403 `email_unverified` (plan 23).
 */
export async function authenticate(
  email: string,
  password: string,
  code: string | undefined,
  ip = 'local',
) {
  const key = email.trim().toLowerCase()
  const keys = limitKeys('login', ip, key)
  for (const k of keys) assertNotLimited(k)
  const user = db.select().from(users).where(eq(users.email, key)).get()
  dummyHash ??= hashPassword('not-a-real-password')
  let passwordOk = false
  if (user?.passwordHash) passwordOk = await verifyPassword(password, user.passwordHash)
  else await verifyPassword(password, await dummyHash)
  if (!user || !passwordOk) {
    for (const k of keys) recordFailure(k)
    throw new ApiError(401, 'Email or password is incorrect')
  }
  if (!user.emailVerifiedAt) throw new ApiError(403, 'email_unverified')
  if (user.totpEnabled && user.totpSecret) {
    if (!code) throw new ApiError(401, 'totp_required')
    if (!checkTotp(user.totpSecret, user.email, code)) {
      for (const k of keys) recordFailure(k)
      throw new ApiError(401, 'That code is not correct')
    }
  }
  clearFailures(`login:email:${key}`)
  return user
}

export function startSession(c: Context, userId: number, workspaceId: number) {
  const token = newToken()
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000)
  db.insert(authSessions)
    .values({ tokenHash: sha256(token), userId, workspaceId, expiresAt: expires.toISOString() })
    .run()
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'Lax',
    path: '/',
    expires,
  })
}

export function endSession(c: Context) {
  const token = getCookie(c, SESSION_COOKIE)
  if (token)
    db.delete(authSessions)
      .where(eq(authSessions.tokenHash, sha256(token)))
      .run()
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
}

export function createApiToken(userId: number, workspaceId: number, name: string) {
  const token = newToken()
  const row = db
    .insert(apiTokens)
    .values({ tokenHash: sha256(token), userId, workspaceId, name })
    .returning()
    .get()
  return { id: row.id, name: row.name, token }
}

interface Identity {
  userId: number
  workspaceId: number
  apiTokenId: number | null
}

function identify(c: Context): Identity | null {
  const bearer = c.req.header('authorization')?.match(/^Bearer (.+)$/)?.[1]
  if (bearer) {
    const row = db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.tokenHash, sha256(bearer)))
      .get()
    if (!row) return null
    db.update(apiTokens)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(apiTokens.id, row.id))
      .run()
    return { userId: row.userId, workspaceId: row.workspaceId, apiTokenId: row.id }
  }
  const token = getCookie(c, SESSION_COOKIE)
  if (!token) return null
  const session = db
    .select()
    .from(authSessions)
    .where(eq(authSessions.tokenHash, sha256(token)))
    .get()
  if (!session || session.expiresAt < new Date().toISOString()) return null
  return { userId: session.userId, workspaceId: session.workspaceId, apiTokenId: null }
}

/**
 * When the session or API token of this request was created, for actions that need a recent
 * sign-in, such as deleting an account without a password (plan 23).
 */
export function credentialCreatedAt(c: Context, apiTokenId: number | null): string | null {
  if (apiTokenId !== null) {
    return (
      db
        .select({ createdAt: apiTokens.createdAt })
        .from(apiTokens)
        .where(eq(apiTokens.id, apiTokenId))
        .get()?.createdAt ?? null
    )
  }
  const token = getCookie(c, SESSION_COOKIE)
  if (!token) return null
  return (
    db
      .select({ createdAt: authSessions.createdAt })
      .from(authSessions)
      .where(eq(authSessions.tokenHash, sha256(token)))
      .get()?.createdAt ?? null
  )
}

/** The user a session cookie belongs to, without needing the session to be the request's. */
export function sessionUserId(c: Context): number | null {
  return identify(c)?.userId ?? null
}

export type AuthEnv = {
  Variables: { userId: number; workspaceId: number; apiTokenId: number | null }
}

/**
 * Sets `userId` and `workspaceId`. The membership is checked on every request, so removing a
 * user from a workspace locks them out at once. Services take `c.get('workspaceId')` as `ws`.
 */
export const requireAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const identity = identify(c)
  if (!identity || !membership(identity.workspaceId, identity.userId)) {
    throw new ApiError(401, 'Log in to continue')
  }
  c.set('userId', identity.userId)
  c.set('workspaceId', identity.workspaceId)
  c.set('apiTokenId', identity.apiTokenId)
  await next()
}
