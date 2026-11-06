import { and, asc, count, eq, gt, isNull, ne } from 'drizzle-orm'
import type { ProviderName } from '../../shared/auth.ts'
import { hashPassword, newToken, sha256, verifyPassword } from '../auth.ts'
import { config } from '../config.ts'
import { db, schema } from '../db/index.ts'
import { ApiError } from '../errors.ts'
import {
  alreadyRegisteredMail,
  passwordChangedMail,
  queueMail,
  resetMail,
  verificationMail,
} from './mail.ts'
import { OAuthError, revokeAppleToken, type VerifiedIdentity } from './oauth.ts'
import { createWorkspace, deleteWorkspace } from './workspaces.ts'

/**
 * Accounts (plan 23): registration, email links, passwords, Google and Apple identities, and
 * account deletion. Users belong to no workspace, so these queries are scoped by user id.
 */

const { apiTokens, authSessions, emailTokens, memberships, userIdentities, users } = schema

type Purpose = 'verify' | 'reset'
const TOKEN_TTL_MS: Record<Purpose, number> = { verify: 24 * 3_600_000, reset: 3_600_000 }
const INVALID_LINK = 'That link is not valid or has expired'

export const findUserByEmail = (email: string) =>
  db.select().from(users).where(eq(users.email, email.trim().toLowerCase())).get() ?? null

export function getUser(id: number) {
  const user = db.select().from(users).where(eq(users.id, id)).get()
  if (!user) throw new ApiError(401, 'Log in to continue')
  return user
}

/** A new single-use link token. Earlier unused ones for the same purpose stop working. */
function issueEmailToken(userId: number, purpose: Purpose) {
  const token = newToken()
  db.transaction((tx) => {
    tx.delete(emailTokens)
      .where(
        and(
          eq(emailTokens.userId, userId),
          eq(emailTokens.purpose, purpose),
          isNull(emailTokens.usedAt),
        ),
      )
      .run()
    tx.insert(emailTokens)
      .values({
        userId,
        purpose,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + TOKEN_TTL_MS[purpose]).toISOString(),
      })
      .run()
  })
  return token
}

/** Marks the token used and returns its user id. One update, so a token can't be used twice. */
function consumeEmailToken(token: string, purpose: Purpose) {
  const row = db
    .update(emailTokens)
    .set({ usedAt: new Date().toISOString() })
    .where(
      and(
        eq(emailTokens.tokenHash, sha256(token)),
        eq(emailTokens.purpose, purpose),
        isNull(emailTokens.usedAt),
        gt(emailTokens.expiresAt, new Date().toISOString()),
      ),
    )
    .returning({ userId: emailTokens.userId })
    .get()
  if (!row) throw new ApiError(422, INVALID_LINK)
  return row.userId
}

const linkFor = (page: string, token: string) =>
  `${config.appUrl}/${page}?token=${encodeURIComponent(token)}`

function sendVerification(userId: number, email: string) {
  queueMail(verificationMail(email, linkFor('verify-email', issueEmailToken(userId, 'verify'))))
}

/** Signs the user out of every browser and app, after a reset or an account takeover. */
export function signOutEverywhere(userId: number) {
  db.delete(authSessions).where(eq(authSessions.userId, userId)).run()
  // Device tokens go with their API token by cascade.
  db.delete(apiTokens).where(eq(apiTokens.userId, userId)).run()
}

/* Email and password */

/**
 * Always ends the same way for the caller, so registration can't tell who has an account. A taken
 * address gets an email saying so instead, and nothing else changes.
 */
export async function register(input: {
  email: string
  password: string
  name?: string
  workspaceName: string
}) {
  if (!config.registrationOpen) throw new ApiError(403, 'registration_closed')
  // Hashed either way, so both answers take about as long.
  const passwordHash = await hashPassword(input.password)
  const existing = findUserByEmail(input.email)
  if (existing) {
    queueMail(alreadyRegisteredMail(existing.email))
    return
  }
  const user = db
    .insert(users)
    .values({ email: input.email, passwordHash, name: input.name || null })
    .onConflictDoNothing()
    .returning()
    .get()
  if (!user) {
    // Someone registered the same address a moment ago.
    queueMail(alreadyRegisteredMail(input.email))
    return
  }
  await createWorkspace(input.workspaceName, user.id)
  sendVerification(user.id, user.email)
}

export function verifyEmail(token: string) {
  const userId = consumeEmailToken(token, 'verify')
  db.update(users)
    .set({ emailVerifiedAt: new Date().toISOString() })
    .where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)))
    .run()
}

export function resendVerification(email: string) {
  const user = findUserByEmail(email)
  if (user && !user.emailVerifiedAt) sendVerification(user.id, user.email)
}

export function forgotPassword(email: string) {
  const user = findUserByEmail(email)
  if (!user) return
  queueMail(resetMail(user.email, linkFor('reset-password', issueEmailToken(user.id, 'reset'))))
}

/**
 * Sets the password, verifies the email (the link proves the inbox), and signs out every session
 * and API token, because a reset usually means the account may be compromised.
 */
export async function resetPassword(token: string, password: string) {
  const passwordHash = await hashPassword(password)
  const userId = consumeEmailToken(token, 'reset')
  const user = getUser(userId)
  db.update(users)
    .set({ passwordHash, emailVerifiedAt: user.emailVerifiedAt ?? new Date().toISOString() })
    .where(eq(users.id, userId))
    .run()
  db.delete(emailTokens)
    .where(and(eq(emailTokens.userId, userId), eq(emailTokens.purpose, 'reset')))
    .run()
  signOutEverywhere(userId)
  queueMail(passwordChangedMail(user.email))
  return user
}

export async function checkPassword(userId: number, password: string) {
  const user = getUser(userId)
  return user.passwordHash !== null && (await verifyPassword(password, user.passwordHash))
}

/** Sets a first password, or changes it, which needs the current one. */
export async function changePassword(
  userId: number,
  currentPassword: string | undefined,
  newPassword: string,
) {
  const user = getUser(userId)
  if (user.passwordHash) {
    if (!currentPassword) throw new ApiError(422, 'Enter your current password')
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new ApiError(422, 'That password is not correct')
    }
  }
  db.update(users)
    .set({ passwordHash: await hashPassword(newPassword) })
    .where(eq(users.id, userId))
    .run()
  queueMail(passwordChangedMail(user.email))
}

/* Google and Apple */

export function listIdentities(userId: number) {
  return db
    .select({
      provider: userIdentities.provider,
      email: userIdentities.email,
      createdAt: userIdentities.createdAt,
    })
    .from(userIdentities)
    .where(eq(userIdentities.userId, userId))
    .orderBy(asc(userIdentities.id))
    .all()
}

export const identityRow = (userId: number, provider: ProviderName, subject: string) =>
  db
    .select({
      provider: userIdentities.provider,
      email: userIdentities.email,
      createdAt: userIdentities.createdAt,
    })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.userId, userId),
        eq(userIdentities.provider, provider),
        eq(userIdentities.subject, subject),
      ),
    )
    .get()

const alreadyLinked = () =>
  new OAuthError(409, 'already_linked', 'That account is linked to another user')

function addIdentity(userId: number, identity: VerifiedIdentity, refreshToken: string | null) {
  db.insert(userIdentities)
    .values({
      userId,
      provider: identity.provider,
      subject: identity.subject,
      email: identity.email,
      appleRefreshToken: refreshToken,
    })
    .run()
}

function workspaceNameFor(name: string | null, email: string) {
  const who = name || email.split('@')[0]
  return `${who}'s workspace`.slice(0, 120)
}

/**
 * Finds or creates the account for a checked Google or Apple identity (plan 23), in this order:
 * 1. an identity with this provider and `sub` signs in as its user;
 * 2. when `linkUserId` is set, the identity is added to that signed-in user;
 * 3. a verified provider email that matches a user links to it, and takes over an unverified
 *    account by clearing its password and signing it out everywhere: the inbox owner wins;
 * 4. otherwise a new verified user and workspace, while registration is open.
 * Returns the user id. Never matches by email alone when the provider has a `sub` on file.
 */
export async function signInWithIdentity(
  identity: VerifiedIdentity,
  options: { linkUserId?: number; name?: string | null; refreshToken?: string | null } = {},
) {
  const refreshToken = options.refreshToken ?? null
  const known = db
    .select()
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.provider, identity.provider),
        eq(userIdentities.subject, identity.subject),
      ),
    )
    .get()
  if (known) {
    if (options.linkUserId !== undefined && known.userId !== options.linkUserId) {
      throw alreadyLinked()
    }
    const changes = {
      ...(identity.email ? { email: identity.email } : {}),
      ...(refreshToken ? { appleRefreshToken: refreshToken } : {}),
    }
    if (Object.keys(changes).length) {
      db.update(userIdentities).set(changes).where(eq(userIdentities.id, known.id)).run()
    }
    return known.userId
  }

  if (options.linkUserId !== undefined) {
    getUser(options.linkUserId)
    addIdentity(options.linkUserId, identity, refreshToken)
    return options.linkUserId
  }

  const email = identity.emailVerified ? identity.email : null
  const match = email ? findUserByEmail(email) : null
  if (match) {
    const now = new Date().toISOString()
    if (!match.emailVerifiedAt) {
      // Someone may have registered this address without owning it. They lose the account.
      db.update(users)
        .set({ passwordHash: null, totpEnabled: false, totpSecret: null, emailVerifiedAt: now })
        .where(eq(users.id, match.id))
        .run()
      db.delete(emailTokens).where(eq(emailTokens.userId, match.id)).run()
      signOutEverywhere(match.id)
    }
    addIdentity(match.id, identity, refreshToken)
    return match.id
  }

  if (!config.registrationOpen) {
    throw new OAuthError(403, 'registration_closed', 'registration_closed')
  }
  if (!email) {
    throw new OAuthError(
      422,
      'oauth_failed',
      'Your account did not share an email address, so a new account could not be made',
    )
  }
  const name = identity.name ?? (options.name?.trim() || null)
  const user = db.transaction((tx) => {
    const row = tx
      .insert(users)
      .values({ email, name, passwordHash: null, emailVerifiedAt: new Date().toISOString() })
      .returning()
      .get()
    tx.insert(userIdentities)
      .values({
        userId: row.id,
        provider: identity.provider,
        subject: identity.subject,
        email: identity.email,
        appleRefreshToken: refreshToken,
      })
      .run()
    return row
  })
  await createWorkspace(workspaceNameFor(name, email), user.id)
  return user.id
}

/** Refused while it is the last way to sign in: no password and no other provider linked. */
export async function unlinkProvider(userId: number, provider: ProviderName) {
  const user = getUser(userId)
  const linked = db
    .select()
    .from(userIdentities)
    .where(and(eq(userIdentities.userId, userId), eq(userIdentities.provider, provider)))
    .all()
  if (!linked.length) throw new ApiError(404, 'That sign-in method is not linked')
  const others =
    db
      .select({ n: count() })
      .from(userIdentities)
      .where(and(eq(userIdentities.userId, userId), ne(userIdentities.provider, provider)))
      .get()?.n ?? 0
  if (!user.passwordHash && others === 0) {
    throw new ApiError(
      409,
      'Set a password or link another sign-in method before you unlink this one',
    )
  }
  db.delete(userIdentities)
    .where(and(eq(userIdentities.userId, userId), eq(userIdentities.provider, provider)))
    .run()
  for (const row of linked) {
    if (row.appleRefreshToken) await revokeAppleToken(row.appleRefreshToken)
  }
}

/**
 * Deletes the account: revokes Apple tokens (a failure is logged and doesn't block), deletes every
 * workspace the user is the only member of, with its files, then the user. Sessions, tokens,
 * identities and email tokens go by cascade.
 */
export async function deleteAccount(userId: number) {
  const refreshTokens = db
    .select({ token: userIdentities.appleRefreshToken })
    .from(userIdentities)
    .where(eq(userIdentities.userId, userId))
    .all()
    .map((r) => r.token)
    .filter((t): t is string => Boolean(t))
  for (const token of refreshTokens) await revokeAppleToken(token)

  const owned = db
    .select({ workspaceId: memberships.workspaceId })
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .all()
  for (const { workspaceId } of owned) {
    const members =
      db
        .select({ n: count() })
        .from(memberships)
        .where(eq(memberships.workspaceId, workspaceId))
        .get()?.n ?? 0
    // With teams, a workspace with other members needs ownership handed over first.
    if (members <= 1) await deleteWorkspace(workspaceId)
  }
  db.delete(users).where(eq(users.id, userId)).run()
}
