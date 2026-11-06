import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadConfig(env: Record<string, string>) {
  vi.resetModules()
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  return (await import('../config.ts')).config
}

afterEach(() => vi.unstubAllEnvs())

describe('Apple settings', () => {
  it('fall back to the push team and app, which are the same', async () => {
    const config = await loadConfig({
      APNS_TEAM_ID: 'TEAM123456',
      APNS_BUNDLE_ID: 'dev.example.app',
      APPLE_TEAM_ID: '',
      APPLE_BUNDLE_ID: '',
      APPLE_KEY_ID: 'KEY1234567',
      APPLE_PRIVATE_KEY_BASE64: Buffer.from('key').toString('base64'),
    })
    expect(config.apple).toMatchObject({ teamId: 'TEAM123456', bundleId: 'dev.example.app' })
    expect(config.apple?.audiences).toContain('dev.example.app')
    expect(config.appLinks.appleAppIds).toEqual(['TEAM123456.dev.example.app'])
  })

  it('use the push key when no separate sign-in key is set', async () => {
    const config = await loadConfig({
      APNS_TEAM_ID: 'TEAM123456',
      APNS_KEY_ID: 'PUSHKEY123',
      APNS_KEY_BASE64: Buffer.from('shared key').toString('base64'),
      APPLE_KEY_ID: '',
      APPLE_PRIVATE_KEY_BASE64: '',
    })
    expect(config.apple).toMatchObject({ keyId: 'PUSHKEY123', privateKey: 'shared key' })
    expect(config.apns).toMatchObject({ keyId: 'PUSHKEY123', key: 'shared key' })
  })

  it('prefer their own values when set', async () => {
    const config = await loadConfig({
      APNS_TEAM_ID: 'TEAM123456',
      APNS_KEY_ID: '',
      APNS_KEY_BASE64: '',
      APPLE_TEAM_ID: 'OTHER12345',
      APPLE_BUNDLE_ID: 'dev.other.app',
    })
    expect(config.apple).toBeNull()
    expect(config.appLinks.appleAppIds).toEqual(['OTHER12345.dev.other.app'])
  })
})

describe('APP_URL', () => {
  it('is required in production, and must be https', async () => {
    const check = async (env: Record<string, string>) => {
      await loadConfig(env)
      const { assertAppUrl } = await import('../services/mail.ts')
      return () => assertAppUrl()
    }
    expect(await check({ NODE_ENV: 'production', APP_URL: '' })).toThrow(/APP_URL/)
    expect(await check({ NODE_ENV: 'production', APP_URL: 'http://solobill.example.com' })).toThrow(
      /https/,
    )
    expect(
      await check({ NODE_ENV: 'production', APP_URL: 'http:https://solobill.example.com' }),
    ).toThrow(/APP_URL/)
    expect(
      await check({ NODE_ENV: 'production', APP_URL: 'https://solobill.example.com/app' }),
    ).toThrow()
    expect(
      await check({ NODE_ENV: 'production', APP_URL: 'https://solobill.example.com/' }),
    ).not.toThrow()
    expect(await check({ NODE_ENV: 'test', APP_URL: '' })).not.toThrow()
  })

  it('treats empty client ids as not set', async () => {
    const config = await loadConfig({
      GOOGLE_WEB_CLIENT_ID: 'web.apps.googleusercontent.com',
      GOOGLE_ANDROID_CLIENT_ID: '',
    })
    expect(config.google?.androidClientId).toBeNull()
    expect(config.google?.audiences).toEqual(['web.apps.googleusercontent.com'])
  })
})
