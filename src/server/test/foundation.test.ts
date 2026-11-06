import * as OTPAuth from 'otpauth'
import { beforeAll, describe, expect, it } from 'vitest'
import { EMAIL, PASSWORD, setup } from './helpers.ts'

let ctx: Awaited<ReturnType<typeof setup>>
beforeAll(async () => {
  ctx = await setup()
})

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  ctx.app.request(`/api/v1${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

describe('auth', () => {
  it('rejects anonymous requests on protected routes', async () => {
    for (const path of [
      '/customers',
      '/overview',
      '/settings',
      '/files/logos/x.png',
      '/templates',
    ]) {
      expect((await ctx.app.request(`/api/v1${path}`)).status).toBe(401)
    }
  })

  it('rejects a wrong password and rate limits', async () => {
    const email = 'nobody@example.com'
    for (let i = 0; i < 5; i += 1) {
      expect((await post('/auth/login', { email, password: 'wrong-password' })).status).toBe(401)
    }
    expect((await post('/auth/login', { email, password: 'wrong-password' })).status).toBe(429)
  })

  it('issues, uses and revokes bearer tokens', async () => {
    const created = await post('/auth/token', { email: EMAIL, password: PASSWORD, name: 'iPhone' })
    expect(created.status).toBe(201)
    const { token, id } = await created.json()
    const headers = { Authorization: `Bearer ${token}` }
    expect((await ctx.app.request('/api/v1/customers', { headers })).status).toBe(200)
    expect((await ctx.api('DELETE', `/auth/tokens/${id}`)).status).toBe(200)
    expect((await ctx.app.request('/api/v1/customers', { headers })).status).toBe(401)
  })

  it('requires a code once two-step login is on', async () => {
    const { json } = await ctx.api('POST', '/auth/totp/setup')
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(json.secret) })
    expect((await ctx.api('POST', '/auth/totp/enable', { code: '000000' })).status).toBe(422)
    expect((await ctx.api('POST', '/auth/totp/enable', { code: totp.generate() })).status).toBe(200)

    const without = await post('/auth/login', { email: EMAIL, password: PASSWORD })
    expect(without.status).toBe(401)
    expect((await without.json()).error).toBe('totp_required')
    const withCode = await post('/auth/login', {
      email: EMAIL,
      password: PASSWORD,
      code: totp.generate(),
    })
    expect(withCode.status).toBe(200)
    await ctx.api('POST', '/auth/totp/disable', { password: PASSWORD })
  })

  it('allows the development UI on the Vite port', async () => {
    const res = await post('/auth/logout', {}, { Origin: 'http://localhost:5173' })
    expect(res.status).toBe(200)
  })

  it('blocks cross-site writes', async () => {
    const res = await ctx.app.request('/api/v1/templates', {
      method: 'POST',
      headers: {
        Cookie: ctx.cookie,
        Host: 'app.example.com',
        Origin: 'https://evil.example.com',
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(res.status).toBe(403)
  })
})

describe('files', () => {
  it('rejects uploads whose content is not what is claimed', async () => {
    const provider = (await ctx.api('GET', '/providers')).json[0]
    const form = new FormData()
    form.append('file', new File(['<svg onload="x()"/>'], 'logo.png', { type: 'image/png' }))
    const res = await ctx.app.request(`/api/v1/providers/${provider.id}/logo`, {
      method: 'POST',
      headers: { Cookie: ctx.cookie },
      body: form,
    })
    expect(res.status).toBe(415)
  })

  it('stops proxies storing files and errors', async () => {
    const provider = (await ctx.api('GET', '/providers')).json[0]
    const form = new FormData()
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
    form.append('file', new File([png], 'logo.png'))
    const upload = await ctx.app.request(`/api/v1/providers/${provider.id}/logo`, {
      method: 'POST',
      headers: { Cookie: ctx.cookie },
      body: form,
    })
    const { logoFile } = await upload.json()

    const allowed = await ctx.api('GET', `/files/${logoFile}`)
    expect(allowed.status).toBe(200)
    expect(allowed.res.headers.get('cache-control')).toBe('private, no-store')

    const anonymous = await ctx.app.request(`/api/v1/files/${logoFile}`)
    expect(anonymous.status).toBe(401)
    expect(anonymous.headers.get('cache-control')).toBe('private, no-store')

    const missing = await ctx.api('GET', '/files/logos/00000000-0000-0000-0000-000000000000.png')
    expect(missing.status).toBe(404)
    expect(missing.res.headers.get('cache-control')).toBe('private, no-store')
  })

  it('does not allow path traversal', async () => {
    const res = await ctx.api('GET', '/files/..%2F..%2F..%2Fetc%2Fpasswd')
    expect(res.status).toBe(404)
  })
})

describe('settings', () => {
  it('reports the health check without logging in', async () => {
    expect((await ctx.app.request('/health')).status).toBe(200)
  })
})
