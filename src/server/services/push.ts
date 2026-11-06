import { createPrivateKey, sign } from 'node:crypto'
import http2 from 'node:http2'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { config } from '../config.ts'
import { db, schema } from '../db/index.ts'
import { workspaceIds } from './renewals.ts'

const { apiTokens, deviceTokens, reminders } = schema

type Environment = 'sandbox' | 'production'
type Reminder = typeof reminders.$inferSelect

export interface ApnsSettings {
  /** The .p8 key from Apple, as PEM text. */
  key: string
  keyId: string
  teamId: string
  bundleId: string
}

const APNS_HOSTS: Record<Environment, string> = {
  sandbox: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
}

const TITLES: Record<Reminder['kind'], string> = {
  renewal_draft: 'Renewal to review',
  invoice_overdue: 'Invoice overdue',
  original_due: 'Provider invoice due',
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url')

/** Apple's provider token: a JWT signed with ES256. */
export function providerToken(apns: ApnsSettings, now = Date.now()) {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: apns.keyId }))
  const claims = base64url(JSON.stringify({ iss: apns.teamId, iat: Math.floor(now / 1000) }))
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
    key: createPrivateKey(apns.key),
    dsaEncoding: 'ieee-p1363',
  })
  return `${header}.${claims}.${base64url(signature)}`
}

function payload(reminder: Reminder) {
  return JSON.stringify({
    aps: { alert: { title: TITLES[reminder.kind], body: reminder.message }, sound: 'default' },
    reminderId: reminder.id,
    kind: reminder.kind,
    link: reminder.link,
  })
}

interface Delivery {
  status: number
  reason?: string
}

function post(
  client: http2.ClientHttp2Session,
  device: string,
  reminder: Reminder,
  apns: ApnsSettings,
  jwt: string,
) {
  return new Promise<Delivery>((resolve, reject) => {
    const stream = client.request({
      ':method': 'POST',
      ':path': `/3/device/${device}`,
      authorization: `bearer ${jwt}`,
      'apns-topic': apns.bundleId,
      'apns-push-type': 'alert',
      // A retry after a partial failure replaces the first notification instead of repeating it.
      'apns-collapse-id': `reminder-${reminder.id}`,
      'content-type': 'application/json',
    })
    let status = 0
    let body = ''
    stream.setEncoding('utf8')
    stream.on('response', (headers) => {
      status = Number(headers[':status'])
    })
    stream.on('data', (chunk) => {
      body += chunk
    })
    stream.on('end', () => {
      let reason: string | undefined
      try {
        reason = body ? JSON.parse(body).reason : undefined
      } catch {
        reason = undefined
      }
      resolve({ status, reason })
    })
    stream.on('error', reject)
    stream.end(payload(reminder))
  })
}

/** The device token will never work again, so stop sending to it. */
const tokenIsGone = ({ status, reason }: Delivery) =>
  status === 410 || (status === 400 && reason === 'BadDeviceToken')

function markSent(ws: number, ids: number[]) {
  if (ids.length === 0) return
  db.update(reminders)
    .set({ pushedAt: new Date().toISOString() })
    .where(and(eq(reminders.workspaceId, ws), inArray(reminders.id, ids)))
    .run()
}

/** Phones signed in to this workspace. Device tokens are scoped through their login token. */
function devicesFor(ws: number) {
  return db
    .select({
      id: deviceTokens.id,
      token: deviceTokens.token,
      environment: deviceTokens.environment,
    })
    .from(deviceTokens)
    .innerJoin(apiTokens, eq(apiTokens.id, deviceTokens.apiTokenId))
    .where(eq(apiTokens.workspaceId, ws))
    .all()
}

/**
 * Pushes each unread reminder that has not been sent yet, for `ws` or for every workspace. A
 * reminder only goes to phones signed in to its own workspace. A failure in one workspace is
 * logged and the others still run.
 */
export async function deliverReminders(
  ws?: number,
  apns: ApnsSettings | null = config.apns,
  hosts: Record<Environment, string> = APNS_HOSTS,
) {
  if (ws !== undefined) return deliverFor(ws, apns, hosts)
  const total = { sent: 0, failed: 0 }
  for (const id of workspaceIds()) {
    try {
      const result = await deliverFor(id, apns, hosts)
      total.sent += result.sent
      total.failed += result.failed
    } catch (error) {
      console.error(`Push failed for workspace ${id}`, error)
    }
  }
  return total
}

/**
 * With no key or no device there is nobody to tell, so reminders are marked as handled, and a
 * later setup starts fresh rather than delivering a backlog. A failed send stays pending and
 * is retried on the next run.
 */
async function deliverFor(
  ws: number,
  apns: ApnsSettings | null,
  hosts: Record<Environment, string>,
) {
  const pending = db
    .select()
    .from(reminders)
    .where(and(eq(reminders.workspaceId, ws), isNull(reminders.pushedAt), isNull(reminders.readAt)))
    .all()
  if (pending.length === 0) return { sent: 0, failed: 0 }
  const devices = devicesFor(ws)
  if (!apns || devices.length === 0) {
    markSent(
      ws,
      pending.map((row) => row.id),
    )
    return { sent: 0, failed: 0 }
  }

  const jwt = providerToken(apns)
  const clients = new Map<Environment, http2.ClientHttp2Session>()
  const clientFor = (environment: Environment) => {
    const existing = clients.get(environment)
    if (existing) return existing
    const client = http2.connect(hosts[environment])
    client.on('error', (error) => console.error('Push connection failed', error))
    clients.set(environment, client)
    return client
  }

  const delivered: number[] = []
  const gone = new Set<number>()
  let failed = 0
  try {
    for (const reminder of pending) {
      let allDelivered = true
      for (const device of devices) {
        if (gone.has(device.id)) continue
        try {
          const result = await post(
            clientFor(device.environment),
            device.token,
            reminder,
            apns,
            jwt,
          )
          if (tokenIsGone(result)) gone.add(device.id)
          else if (result.status !== 200) {
            allDelivered = false
            console.error(`Push refused: ${result.status} ${result.reason ?? ''}`)
          }
        } catch (error) {
          allDelivered = false
          console.error('Push failed', error)
        }
      }
      if (allDelivered) delivered.push(reminder.id)
      else failed += 1
    }
  } finally {
    for (const client of clients.values()) client.close()
  }

  markSent(ws, delivered)
  if (gone.size)
    db.delete(deviceTokens)
      .where(inArray(deviceTokens.id, [...gone]))
      .run()
  return { sent: delivered.length, failed }
}

/** One phone has one row. Signing in again moves it to the new login token. */
export function registerDevice(apiTokenId: number, token: string, environment: Environment) {
  const existing = db.select().from(deviceTokens).where(eq(deviceTokens.token, token)).get()
  if (existing) {
    db.update(deviceTokens)
      .set({ apiTokenId, environment })
      .where(eq(deviceTokens.id, existing.id))
      .run()
  } else {
    db.insert(deviceTokens).values({ apiTokenId, token, environment }).run()
  }
}
