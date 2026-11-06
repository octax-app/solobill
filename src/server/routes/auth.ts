import { and, desc, eq } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { CookieOptions } from 'hono/utils/cookie'
import { z } from 'zod'
import {
  changePasswordInput,
  deleteAccountInput,
  emailInput,
  oauthLinkInput,
  oauthTokenInput,
  type ProviderName,
  providerName,
  registerInput,
  resetPasswordInput,
  totpDisableInput,
  verifyEmailInput,
} from '../../shared/auth.ts'
import {
  type AuthEnv,
  assertNotLimited,
  authenticate,
  checkTotp,
  clientIp,
  countAttempt,
  createApiToken,
  credentialCreatedAt,
  endSession,
  limitKeys,
  newToken,
  newTotpSecret,
  recordFailure,
  requireAuth,
  SESSION_COOKIE,
  sessionUserId,
  startSession,
  totpFor,
  verifyPassword,
} from '../auth.ts'
import { config } from '../config.ts'
import { db, schema } from '../db/index.ts'
import { ApiError } from '../errors.ts'
import {
  changePassword,
  deleteAccount,
  forgotPassword,
  getUser,
  identityRow,
  listIdentities,
  register,
  resendVerification,
  resetPassword,
  signInWithIdentity,
  unlinkProvider,
  verifyEmail,
} from '../services/accounts.ts'
import {
  authorizationUrl,
  callbackUrl,
  consumeState,
  exchangeAppleCode,
  exchangeGoogleCode,
  OAuthError,
  type OAuthState,
  providerConfigured,
  STATE_TTL_MS,
  safeReturnPath,
  sameSecret,
  sealState,
  signInFailed,
  type VerifiedIdentity,
  verifyIdToken,
  webConfigured,
} from '../services/oauth.ts'
import { defaultWorkspaceFor, getWorkspace, membership } from '../services/workspaces.ts'
import { body, idParam } from './util.ts'

const { apiTokens, users } = schema
const credentials = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
  code: z.string().optional(),
})
const RECENT_SIGN_IN_MS = 10 * 60 * 1000

function workspaceToSignIn(userId: number) {
  const ws = defaultWorkspaceFor(userId)
  if (ws === null) throw new ApiError(403, 'This account has no workspace')
  return ws
}

/** A body that may be left out, as on DELETE /auth/account for a Google or Apple user. */
async function optionalBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.output<T>> {
  const text = await c.req.text()
  if (!text.trim()) return schema.parse({})
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new ApiError(400, 'The request body is not valid JSON')
  }
  return schema.parse(json)
}

/** A provider that is configured on this server, or 404. */
function providerParam(c: Context): ProviderName {
  const parsed = providerName.safeParse(c.req.param('provider'))
  if (!parsed.success || !providerConfigured(parsed.data)) {
    throw new ApiError(404, 'That sign-in method is not available')
  }
  return parsed.data
}

/** Runs `check`, counting a failure against every key when it throws. */
async function counting<T>(keys: string[], check: () => Promise<T>): Promise<T> {
  for (const key of keys) assertNotLimited(key)
  try {
    return await check()
  } catch (error) {
    for (const key of keys) recordFailure(key)
    throw error
  }
}

export const authRoutes = new Hono<AuthEnv>()

/* Public */

authRoutes.get('/providers', (c) =>
  c.json({
    registration: config.registrationOpen,
    google: config.google !== null,
    apple: config.apple !== null,
    googleIosClientId: config.google?.iosClientId ?? null,
    googleAndroidClientId: config.google?.androidClientId ?? null,
  }),
)

authRoutes.post('/login', async (c) => {
  const { email, password, code } = await body(c, credentials)
  const user = await authenticate(email, password, code, clientIp(c))
  startSession(c, user.id, workspaceToSignIn(user.id))
  return c.json({ email: user.email, totpEnabled: user.totpEnabled })
})

/** For the iOS app: exchanges credentials for a bearer token. */
authRoutes.post('/token', async (c) => {
  const input = await body(c, credentials.extend({ name: z.string().min(1).max(80) }))
  const user = await authenticate(input.email, input.password, input.code, clientIp(c))
  return c.json(createApiToken(user.id, workspaceToSignIn(user.id), input.name), 201)
})

authRoutes.post('/logout', (c) => {
  endSession(c)
  return c.json({ ok: true })
})

authRoutes.post('/register', async (c) => {
  if (!config.registrationOpen) throw new ApiError(403, 'registration_closed')
  const input = await body(c, registerInput)
  countAttempt(limitKeys('register', clientIp(c), input.email))
  await register(input)
  return c.json({ ok: true }, 202)
})

authRoutes.post('/verify-email', async (c) => {
  const { token } = await body(c, verifyEmailInput)
  await counting(limitKeys('link', clientIp(c)), async () => verifyEmail(token))
  return c.json({ ok: true })
})

authRoutes.post('/resend-verification', async (c) => {
  const { email } = await body(c, emailInput)
  countAttempt(limitKeys('resend', clientIp(c), email))
  resendVerification(email)
  return c.json({ ok: true }, 202)
})

authRoutes.post('/forgot-password', async (c) => {
  const { email } = await body(c, emailInput)
  countAttempt(limitKeys('forgot', clientIp(c), email))
  forgotPassword(email)
  return c.json({ ok: true }, 202)
})

authRoutes.post('/reset-password', async (c) => {
  const { token, password } = await body(c, resetPasswordInput)
  await counting(limitKeys('link', clientIp(c)), () => resetPassword(token, password))
  return c.json({ ok: true })
})

/* Google and Apple on the web: a server-side redirect flow */

const STATE_COOKIE = 'oauth_state'
/** Apple's callback is a cross-site form POST, which only sends a `SameSite=None` cookie. */
const stateCookie = (): CookieOptions => ({
  httpOnly: true,
  path: '/api/v1/auth/oauth',
  ...(config.cookieSecure
    ? { secure: true, sameSite: 'None' as const }
    : { secure: false, sameSite: 'Lax' as const }),
})

/** Adds a query parameter to a same-origin path, keeping its query and fragment. */
function withQuery(pathname: string, key: string, value: string) {
  const url = new URL(pathname, 'http://return.invalid')
  url.searchParams.set(key, value)
  return `${url.pathname}${url.search}${url.hash}`
}

const errorPage = (intent: OAuthState['intent'], code: OAuthError['code']) =>
  `${intent === 'link' ? '/settings/account' : '/login'}?error=${code}`

authRoutes.get('/oauth/:provider/start', (c) => {
  const intent = c.req.query('intent') === 'link' ? 'link' : 'signin'
  const parsed = providerName.safeParse(c.req.param('provider'))
  if (!parsed.success || !webConfigured(parsed.data)) {
    return c.redirect(errorPage(intent, 'oauth_failed'))
  }
  const userId = intent === 'link' ? sessionUserId(c) : null
  if (intent === 'link' && userId === null) return c.redirect('/login')
  const state: OAuthState = {
    provider: parsed.data,
    state: newToken(),
    nonce: newToken(),
    verifier: newToken(),
    intent,
    userId,
    returnTo: safeReturnPath(c.req.query('return')),
    expiresAt: Date.now() + STATE_TTL_MS,
  }
  setCookie(c, STATE_COOKIE, sealState(state), { ...stateCookie(), maxAge: STATE_TTL_MS / 1000 })
  return c.redirect(authorizationUrl(parsed.data, state))
})

/** Apple's first sign-in posts the name as JSON. The email in it is not checked, so it is unused. */
function appleName(user: unknown) {
  if (typeof user !== 'string') return null
  try {
    const parsed = JSON.parse(user) as { name?: { firstName?: string; lastName?: string } }
    const name = [parsed.name?.firstName, parsed.name?.lastName].filter(Boolean).join(' ').trim()
    return name ? name.slice(0, 120) : null
  } catch {
    return null
  }
}

/**
 * Checks the state cookie (single use: it is cleared here), gets and checks the ID token, then
 * signs in and goes to `/`, or links and goes back to Settings. Errors go to `?error=<code>`.
 */
async function finishWebSignIn(
  c: Context,
  provider: ProviderName,
  params: Record<string, unknown>,
) {
  const state = consumeState(getCookie(c, STATE_COOKIE))
  deleteCookie(c, STATE_COOKIE, stateCookie())
  const intent = state?.intent ?? 'signin'
  try {
    const { code, error } = params
    if (
      !state ||
      state.provider !== provider ||
      typeof params.state !== 'string' ||
      !sameSecret(params.state, state.state) ||
      error ||
      typeof code !== 'string' ||
      !code
    ) {
      throw signInFailed()
    }
    let identity: VerifiedIdentity
    let refreshToken: string | null = null
    if (provider === 'google') {
      identity = await verifyIdToken(
        'google',
        await exchangeGoogleCode(code, state.verifier),
        state.nonce,
      )
    } else {
      // The posted ID token carries our nonce. The code gives the refresh token to revoke later.
      if (typeof params.id_token !== 'string') throw signInFailed()
      identity = await verifyIdToken('apple', params.id_token, state.nonce)
      const servicesId = config.apple?.servicesId
      if (servicesId) refreshToken = await exchangeAppleCode(code, servicesId, callbackUrl('apple'))
    }
    if (state.intent === 'link') {
      if (state.userId === null) throw signInFailed()
      await signInWithIdentity(identity, { linkUserId: state.userId, refreshToken })
      return c.redirect(withQuery(state.returnTo ?? '/settings/account', 'linked', provider))
    }
    const userId = await signInWithIdentity(identity, {
      name: appleName(params.user),
      refreshToken,
    })
    startSession(c, userId, workspaceToSignIn(userId))
    return c.redirect(state.returnTo ?? '/')
  } catch (error) {
    if (!(error instanceof OAuthError)) {
      // Only the first line: a database error goes on to list the query's values.
      const message = error instanceof Error ? error.message.split('\n')[0].split('params:')[0] : ''
      console.error(`${provider} sign-in failed:`, message)
    }
    return c.redirect(errorPage(intent, error instanceof OAuthError ? error.code : 'oauth_failed'))
  }
}

authRoutes.get('/oauth/google/callback', (c) => finishWebSignIn(c, 'google', c.req.query()))

authRoutes.post('/oauth/apple/callback', async (c) =>
  finishWebSignIn(c, 'apple', await c.req.parseBody()),
)

/* Google and Apple from the apps: the app sends the ID token it got */

authRoutes.post('/oauth/:provider/token', async (c) => {
  const provider = providerParam(c)
  const keys = limitKeys('oauth', clientIp(c))
  const input = await body(c, oauthTokenInput)
  const identity = await counting(keys, () => verifyIdToken(provider, input.idToken, input.nonce))
  const refreshToken =
    provider === 'apple' && input.authorizationCode && config.apple
      ? await exchangeAppleCode(input.authorizationCode, config.apple.bundleId)
      : null
  const userId = await signInWithIdentity(identity, { name: input.name, refreshToken })
  return c.json(createApiToken(userId, workspaceToSignIn(userId), input.deviceName), 201)
})

/* Signed in */

authRoutes.use('/*', requireAuth)

authRoutes.get('/me', (c) => {
  const user = getUser(c.get('userId'))
  const ws = c.get('workspaceId')
  const workspace = getWorkspace(ws)
  const member = membership(ws, user.id)
  if (!workspace || !member) throw new ApiError(401, 'Log in to continue')
  return c.json({
    email: user.email,
    name: user.name,
    totpEnabled: user.totpEnabled,
    hasPassword: user.passwordHash !== null,
    workspace: { id: workspace.id, name: workspace.name },
    role: member.role,
  })
})

authRoutes.get('/identities', (c) => c.json(listIdentities(c.get('userId'))))

authRoutes.post('/oauth/:provider/link', async (c) => {
  const provider = providerParam(c)
  const userId = c.get('userId')
  const input = await body(c, oauthLinkInput)
  const identity = await counting(limitKeys('link-provider', clientIp(c), `user-${userId}`), () =>
    verifyIdToken(provider, input.idToken, input.nonce),
  )
  const refreshToken =
    provider === 'apple' && input.authorizationCode && config.apple
      ? await exchangeAppleCode(input.authorizationCode, config.apple.bundleId)
      : null
  await signInWithIdentity(identity, { linkUserId: userId, refreshToken })
  return c.json(identityRow(userId, provider, identity.subject), 201)
})

authRoutes.delete('/identities/:provider', async (c) => {
  const parsed = providerName.safeParse(c.req.param('provider'))
  if (!parsed.success) throw new ApiError(404, 'That sign-in method is not linked')
  await unlinkProvider(c.get('userId'), parsed.data)
  return c.json({ ok: true })
})

authRoutes.post('/password', async (c) => {
  const input = await body(c, changePasswordInput)
  const userId = c.get('userId')
  await counting([`password:user:${userId}`], () =>
    changePassword(userId, input.currentPassword, input.newPassword),
  )
  return c.json({ ok: true })
})

/**
 * Needs the password, or a TOTP code, or, for a user with neither, a session or token made in the
 * last 10 minutes: the clients start a fresh Google or Apple sign-in for that.
 */
authRoutes.delete('/account', async (c) => {
  const input = await optionalBody(c, deleteAccountInput)
  const userId = c.get('userId')
  const user = getUser(userId)
  await counting([`account:user:${userId}`], async () => {
    if (input.password) {
      if (!user.passwordHash || !(await verifyPassword(input.password, user.passwordHash))) {
        throw new ApiError(422, 'That password is not correct')
      }
    } else if (input.code) {
      if (
        !user.totpEnabled ||
        !user.totpSecret ||
        !checkTotp(user.totpSecret, user.email, input.code)
      ) {
        throw new ApiError(422, 'That code is not correct')
      }
    } else if (user.passwordHash) {
      throw new ApiError(422, 'Enter your password')
    } else if (user.totpEnabled) {
      throw new ApiError(422, 'Enter a code from your authenticator app')
    }
  })
  if (!input.password && !input.code) {
    const createdAt = credentialCreatedAt(c, c.get('apiTokenId'))
    if (!createdAt || Date.now() - Date.parse(createdAt) > RECENT_SIGN_IN_MS) {
      throw new ApiError(403, 'recent_sign_in_required')
    }
  }
  await deleteAccount(userId)
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
  return c.json({ ok: true })
})

authRoutes.get('/tokens', (c) =>
  c.json(
    db
      .select({
        id: apiTokens.id,
        name: apiTokens.name,
        lastUsedAt: apiTokens.lastUsedAt,
        createdAt: apiTokens.createdAt,
      })
      .from(apiTokens)
      .where(eq(apiTokens.userId, c.get('userId')))
      .orderBy(desc(apiTokens.id))
      .all(),
  ),
)

authRoutes.delete('/tokens/:id', (c) => {
  db.delete(apiTokens)
    .where(and(eq(apiTokens.id, idParam(c)), eq(apiTokens.userId, c.get('userId'))))
    .run()
  return c.json({ ok: true })
})

authRoutes.post('/totp/setup', (c) => {
  const user = getUser(c.get('userId'))
  if (user.totpEnabled) throw new ApiError(409, 'Two-step login is already on')
  const secret = newTotpSecret()
  db.update(users).set({ totpSecret: secret }).where(eq(users.id, user.id)).run()
  return c.json({ secret, uri: totpFor(secret, user.email).toString() })
})

authRoutes.post('/totp/enable', async (c) => {
  const { code } = await body(c, z.object({ code: z.string().min(6) }))
  const user = getUser(c.get('userId'))
  if (!user.totpSecret || !checkTotp(user.totpSecret, user.email, code)) {
    throw new ApiError(422, 'That code is not correct')
  }
  db.update(users).set({ totpEnabled: true }).where(eq(users.id, user.id)).run()
  return c.json({ totpEnabled: true })
})

/** With the password, or, for a user without one, a current code. */
authRoutes.post('/totp/disable', async (c) => {
  const input = await body(c, totpDisableInput)
  const user = getUser(c.get('userId'))
  await counting([`totp:user:${user.id}`], async () => {
    if (user.passwordHash) {
      if (!input.password || !(await verifyPassword(input.password, user.passwordHash))) {
        throw new ApiError(422, 'That password is not correct')
      }
    } else if (
      !input.code ||
      !user.totpSecret ||
      !checkTotp(user.totpSecret, user.email, input.code)
    ) {
      throw new ApiError(422, 'That code is not correct')
    }
  })
  db.update(users).set({ totpEnabled: false, totpSecret: null }).where(eq(users.id, user.id)).run()
  return c.json({ totpEnabled: false })
})
