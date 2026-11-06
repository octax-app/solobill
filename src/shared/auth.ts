import { z } from 'zod'

/**
 * Request bodies for registration and sign-in (plan 23). Shared by the server, the web client
 * and the OpenAPI document, so the iOS and Android apps read the same contract.
 *
 * Errors use the usual `{ error }` body. These `error` strings are codes the clients act on:
 * - `totp_required` (401): ask for the 6-digit code and send the request again with `code`.
 * - `email_unverified` (403): show "Check your email" with a Resend button.
 * - `registration_closed` (403): hide sign-up.
 * - `recent_sign_in_required` (403): sign in with Google or Apple again, then retry.
 * Anything else is a message to show as it is.
 */

export const PASSWORD_MIN = 10
export const PASSWORD_MAX = 200

const email = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email').max(254))
const password = z
  .string()
  .min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters`)
  .max(PASSWORD_MAX)
const token = z.string().min(20).max(200)
const deviceName = z.string().min(1).max(80)

export const providerName = z.enum(['google', 'apple'])
export type ProviderName = z.infer<typeof providerName>

export const registerInput = z.object({
  email,
  password,
  name: z.string().trim().max(120).optional(),
  workspaceName: z.string().trim().min(1, 'Enter your business name').max(120),
})

export const emailInput = z.object({ email })

export const verifyEmailInput = z.object({ token })

export const resetPasswordInput = z.object({ token, password })

export const changePasswordInput = z.object({
  /** Required when the user already has a password. */
  currentPassword: z.string().min(1).optional(),
  newPassword: password,
})

/**
 * From a native Google or Apple sign-in (iOS now, Android later). `nonce` is the raw nonce the
 * app generated; the ID token carries its SHA-256 (Apple) or the raw value (Google).
 */
export const oauthTokenInput = z.object({
  idToken: z.string().min(20).max(8000),
  nonce: z.string().min(16).max(200),
  /** Apple only: exchanged for the refresh token that is revoked when the account is deleted. */
  authorizationCode: z.string().max(2000).optional(),
  /** Apple sends the name only on the first sign-in, to the app, not in the token. */
  name: z.string().trim().max(120).optional(),
  deviceName,
})

/** Linking from a signed-in app. Same fields as sign-in, without the device name. */
export const oauthLinkInput = oauthTokenInput.omit({ deviceName: true })

export const deleteAccountInput = z.object({
  password: z.string().min(1).optional(),
  code: z.string().min(6).max(10).optional(),
})

export const totpDisableInput = z.object({
  /** The password, or, for a user without one, a current code. */
  password: z.string().min(1).optional(),
  code: z.string().min(6).max(10).optional(),
})

export const workspaceInput = z.object({ name: z.string().trim().min(1).max(120) })
