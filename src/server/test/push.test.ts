import { generateKeyPairSync, verify } from 'node:crypto'
import http2 from 'node:http2'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { db, schema } from '../db/index.ts'
import { type ApnsSettings, deliverReminders, providerToken } from '../services/push.ts'
import { EMAIL, PASSWORD, setup } from './helpers.ts'

const { deviceTokens, reminders } = schema
const DEVICE = 'ab'.repeat(32)

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const apns: ApnsSettings = {
  key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  keyId: 'KEY1234567',
  teamId: 'ABCDE12345',
  bundleId: 'dev.octax.mg',
}

interface Received {
  headers: http2.IncomingHttpHeaders
  body: { aps: { alert: { title: string; body: string } }; reminderId: number; link: string }
}

let ctx: Awaited<ReturnType<typeof setup>>
let bearer: string
let tokenId: number
let ws: number
let server: http2.Http2Server
let hosts: { sandbox: string; production: string }
let received: Received[] = []
let respond: () => { status: number; reason?: string } = () => ({ status: 200 })

/** Stands in for Apple's server, over real HTTP/2. */
beforeAll(async () => {
  ctx = await setup()
  ws = (await ctx.api('GET', '/auth/me')).json.workspace.id
  server = http2.createServer()
  server.on('stream', (stream: http2.ServerHttp2Stream, headers) => {
    let text = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      text += chunk
    })
    stream.on('end', () => {
      received.push({ headers, body: JSON.parse(text) })
      const { status, reason } = respond()
      stream.respond({ ':status': status })
      stream.end(reason ? JSON.stringify({ reason }) : undefined)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const url = `http://localhost:${(server.address() as AddressInfo).port}`
  hosts = { sandbox: url, production: url }

  const created = await ctx.app.request('/api/v1/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: 'Phone' }),
  })
  const json = await created.json()
  bearer = json.token
  tokenId = json.id
})

afterAll(() => {
  server.close()
})

beforeEach(() => {
  received = []
  respond = () => ({ status: 200 })
  db.delete(reminders).run()
  db.delete(deviceTokens).run()
})

function register(token = DEVICE, environment = 'sandbox', auth = `Bearer ${bearer}`) {
  return ctx.app.request('/api/v1/devices', {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, environment }),
  })
}

let refId = 1
function addReminder(message = 'Review the renewal draft for Omar') {
  refId += 1
  return db
    .insert(reminders)
    .values({ workspaceId: ws, kind: 'renewal_draft', refId, message, link: `/invoices/${refId}` })
    .returning()
    .get()
}

const pushedAt = (id: number) =>
  db
    .select()
    .from(reminders)
    .all()
    .find((row) => row.id === id)?.pushedAt

describe('push notifications', () => {
  it('registers a device once, whatever the number of launches', async () => {
    expect((await register()).status).toBe(200)
    expect((await register()).status).toBe(200)
    expect(db.select().from(deviceTokens).all()).toHaveLength(1)
  })

  it('rejects malformed tokens and web sessions', async () => {
    expect((await register('not-hex')).status).toBe(422)
    const web = await ctx.api('POST', '/devices', { token: DEVICE, environment: 'sandbox' })
    expect(web.status).toBe(403)
  })

  it('sends a signed notification that opens the right screen', async () => {
    await register()
    const reminder = addReminder()
    expect(await deliverReminders(undefined, apns, hosts)).toEqual({ sent: 1, failed: 0 })

    const [{ headers, body }] = received
    expect(headers[':path']).toBe(`/3/device/${DEVICE}`)
    expect(headers['apns-topic']).toBe('dev.octax.mg')
    expect(headers['apns-push-type']).toBe('alert')
    expect(body.aps.alert).toEqual({
      title: 'Renewal to review',
      body: 'Review the renewal draft for Omar',
    })
    expect(body.reminderId).toBe(reminder.id)
    expect(body.link).toBe(reminder.link)
    expect(pushedAt(reminder.id)).toBeTruthy()
  })

  it('signs a token Apple can verify', () => {
    const [header, claims, signature] = providerToken(apns, 1_800_000_000_000).split('.')
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: 'KEY1234567',
    })
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({
      iss: 'ABCDE12345',
      iat: 1_800_000_000,
    })
    const valid = verify(
      'sha256',
      Buffer.from(`${header}.${claims}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    )
    expect(valid).toBe(true)
  })

  it('never sends the same reminder twice', async () => {
    await register()
    addReminder()
    await deliverReminders(undefined, apns, hosts)
    await deliverReminders(undefined, apns, hosts)
    expect(received).toHaveLength(1)
  })

  it('skips reminders the owner has already read', async () => {
    await register()
    const reminder = addReminder()
    db.update(reminders).set({ readAt: new Date().toISOString() }).run()
    await deliverReminders(undefined, apns, hosts)
    expect(received).toHaveLength(0)
    expect(pushedAt(reminder.id)).toBeNull()
  })

  it('retries after a failure, without a duplicate on the phone', async () => {
    await register()
    const reminder = addReminder()
    respond = () => ({ status: 503, reason: 'ServiceUnavailable' })
    expect(await deliverReminders(undefined, apns, hosts)).toEqual({ sent: 0, failed: 1 })
    expect(pushedAt(reminder.id)).toBeNull()

    respond = () => ({ status: 200 })
    expect(await deliverReminders(undefined, apns, hosts)).toEqual({ sent: 1, failed: 0 })
    const ids = received.map(({ headers }) => headers['apns-collapse-id'])
    expect(ids).toEqual([`reminder-${reminder.id}`, `reminder-${reminder.id}`])
  })

  it('forgets a device Apple says is gone', async () => {
    await register()
    addReminder()
    respond = () => ({ status: 410, reason: 'Unregistered' })
    await deliverReminders(undefined, apns, hosts)
    expect(db.select().from(deviceTokens).all()).toHaveLength(0)
  })

  it('does not build a backlog when push is not set up', async () => {
    await register()
    const reminder = addReminder()
    await deliverReminders(undefined, null, hosts)
    expect(pushedAt(reminder.id)).toBeTruthy()
    await deliverReminders(undefined, apns, hosts)
    expect(received).toHaveLength(0)
  })

  it('does not deliver a backlog to a phone that registers later', async () => {
    const reminder = addReminder()
    await deliverReminders(undefined, apns, hosts)
    await register()
    await deliverReminders(undefined, apns, hosts)
    expect(pushedAt(reminder.id)).toBeTruthy()
    expect(received).toHaveLength(0)
  })

  it('stops notifying a phone when its login is revoked', async () => {
    await register()
    expect(db.select().from(deviceTokens).all()).toHaveLength(1)
    expect((await ctx.api('DELETE', `/auth/tokens/${tokenId}`)).status).toBe(200)
    expect(db.select().from(deviceTokens).all()).toHaveLength(0)

    const created = await ctx.app.request('/api/v1/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: 'Phone' }),
    })
    const json = await created.json()
    bearer = json.token
    tokenId = json.id
  })
})
