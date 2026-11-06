import path from 'node:path'

const dataDir = path.resolve(process.env.DATA_DIR ?? './data')

const { R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env
const { APNS_KEY_BASE64, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID } = process.env
const env = process.env
/** Same Apple team and app as push, so these fall back to the APNS_ values. */
const appleTeamId = env.APPLE_TEAM_ID || APNS_TEAM_ID
const appleBundleId = env.APPLE_BUNDLE_ID || APNS_BUNDLE_ID || 'dev.octax.mg'
/** One Apple key can serve push and Sign in with Apple, so the key falls back to the push key. */
const appleKeyId = env.APPLE_KEY_ID || APNS_KEY_ID
const appleKeyBase64 = env.APPLE_PRIVATE_KEY_BASE64 || APNS_KEY_BASE64
const list = (...values: (string | undefined)[]) => values.filter((v): v is string => Boolean(v))

export const config = {
  port: Number(process.env.PORT ?? 3000),
  production: process.env.NODE_ENV === 'production',
  dataDir,
  databasePath: process.env.DATABASE_PATH ?? path.join(dataDir, 'app.db'),
  filesDir: path.join(dataDir, 'files'),
  backupsDir: path.join(dataDir, 'backups'),
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  maxUploadBytes: 20 * 1024 * 1024,
  r2:
    R2_ACCOUNT_ID && R2_BUCKET && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY
      ? {
          endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
          bucket: R2_BUCKET,
          accessKeyId: R2_ACCESS_KEY_ID,
          secretAccessKey: R2_SECRET_ACCESS_KEY,
        }
      : null,
  /** The public web address, used in email links and OAuth redirect URLs. No trailing slash. */
  appUrl: (env.APP_URL || 'http://localhost:5173').replace(/\/$/, ''),
  /** False when APP_URL is missing, so production can refuse to start (see assertAppUrl). */
  appUrlSet: Boolean(env.APP_URL),
  /** Off unless set, so the owner opens sign-up on purpose (plan 23). */
  registrationOpen: env.REGISTRATION_OPEN === 'true',
  /** Without SMTP outside production, emails are written to the console. */
  mail: env.SMTP_URL
    ? { smtpUrl: env.SMTP_URL, from: env.MAIL_FROM ?? 'Octax Solobill <no-reply@localhost>' }
    : null,
  google:
    env.GOOGLE_WEB_CLIENT_ID || env.GOOGLE_IOS_CLIENT_ID || env.GOOGLE_ANDROID_CLIENT_ID
      ? {
          webClientId: env.GOOGLE_WEB_CLIENT_ID || null,
          webClientSecret: env.GOOGLE_WEB_CLIENT_SECRET || null,
          iosClientId: env.GOOGLE_IOS_CLIENT_ID || null,
          androidClientId: env.GOOGLE_ANDROID_CLIENT_ID || null,
          /** Every client id an ID token's `aud` may name. */
          audiences: list(
            env.GOOGLE_WEB_CLIENT_ID,
            env.GOOGLE_IOS_CLIENT_ID,
            env.GOOGLE_ANDROID_CLIENT_ID,
          ),
        }
      : null,
  apple:
    appleTeamId && appleKeyId && appleKeyBase64
      ? {
          teamId: appleTeamId,
          keyId: appleKeyId,
          privateKey: Buffer.from(appleKeyBase64, 'base64').toString('utf8'),
          /** The web Services ID. Null turns off Apple on the web only. */
          servicesId: env.APPLE_SERVICES_ID || null,
          bundleId: appleBundleId,
          /** Every client id an ID token's `aud` may name. */
          audiences: list(env.APPLE_SERVICES_ID, appleBundleId),
        }
      : null,
  /**
   * Password autofill between the website and the apps (plan 23). Read without the Sign in with
   * Apple key, which these files don't need.
   */
  appLinks: {
    /** `<team id>.<bundle id>` for `apple-app-site-association`. Empty without a team id. */
    appleAppIds: appleTeamId ? [`${appleTeamId}.${appleBundleId}`] : [],
    android:
      env.ANDROID_PACKAGE_NAME && env.ANDROID_CERT_SHA256
        ? {
            packageName: env.ANDROID_PACKAGE_NAME.trim(),
            /** Upper-case colon form, as Google's `assetlinks.json` expects. */
            sha256: env.ANDROID_CERT_SHA256.split(',')
              .map((value) => value.replace(/[^0-9a-f]/gi, '').toUpperCase())
              .filter(Boolean)
              .map((hex) => hex.match(/.{1,2}/g)?.join(':') ?? hex),
          }
        : null,
  } as {
    appleAppIds: string[]
    android: { packageName: string; sha256: string[] } | null
  },
  apns:
    APNS_KEY_BASE64 && APNS_KEY_ID && APNS_TEAM_ID
      ? {
          key: Buffer.from(APNS_KEY_BASE64, 'base64').toString('utf8'),
          keyId: APNS_KEY_ID,
          teamId: APNS_TEAM_ID,
          bundleId: APNS_BUNDLE_ID ?? 'dev.octax.mg',
        }
      : null,
}
