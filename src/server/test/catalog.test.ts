import { beforeAll, describe, expect, it } from 'vitest'
import { setup } from './helpers.ts'

let api: Awaited<ReturnType<typeof setup>>['api']
beforeAll(async () => {
  ;({ api } = await setup())
})

describe('catalog', () => {
  it('seeds providers and services', async () => {
    const providers = (await api('GET', '/providers')).json
    const services = (await api('GET', '/services')).json
    expect(providers.map((p: any) => p.name).sort()).toEqual([
      'Apple',
      'Cloudflare',
      'Contabo',
      'Google',
      'Intuit',
    ])
    expect(services).toHaveLength(7)
    expect(services.find((s: any) => s.name === 'Google developer account').cycle).toBe('once')
    expect(services.find((s: any) => s.name === 'S3 storage (R2)').pricing).toBe('metered')
  })

  it('creates, edits and archives each entity', async () => {
    const provider = await api('POST', '/providers', { name: 'Hetzner' })
    expect(provider.status).toBe(201)
    expect(
      (await api('PUT', `/providers/${provider.json.id}`, { name: 'Hetzner GmbH' })).json.name,
    ).toBe('Hetzner GmbH')
    await api('POST', `/providers/${provider.json.id}/archive`)
    const active = (await api('GET', '/providers')).json
    expect(active.some((p: any) => p.id === provider.json.id)).toBe(false)

    const customer = await api('POST', '/customers', { name: 'Acme', currency: 'OMR' })
    expect(customer.status).toBe(201)
    expect((await api('GET', '/customers?q=acm')).json).toHaveLength(1)
    expect((await api('GET', '/customers?status=lead')).json).toHaveLength(0)
  })

  it('validates input', async () => {
    expect((await api('POST', '/customers', { name: '', currency: 'OMR' })).status).toBe(422)
    expect((await api('POST', '/customers', { name: 'A', currency: 'XXX' })).status).toBe(422)
    expect((await api('POST', '/providers', {})).status).toBe(422)
    expect((await api('GET', '/customers/99999')).status).toBe(404)
  })

  it('keeps a subscription price after the service default changes', async () => {
    const provider = (await api('GET', '/providers')).json[0]
    const service = (
      await api('POST', '/services', {
        providerId: provider.id,
        name: 'Backup',
        pricing: 'fixed',
        cycle: 'monthly',
        defaultCost: 10_000,
        defaultPrice: 50_000,
        currency: 'USD',
      })
    ).json
    const customer = (await api('POST', '/customers', { name: 'Beta', currency: 'USD' })).json
    const sub = (
      await api('POST', '/subscriptions', {
        customerId: customer.id,
        serviceId: service.id,
        startedOn: '2099-01-31',
      })
    ).json
    expect(sub.priceAmount).toBe(50_000)
    expect(sub.nextRenewalOn).toBe('2099-02-28')

    await api('PUT', `/services/${service.id}`, { ...service, defaultPrice: 90_000 })
    expect((await api('GET', `/subscriptions/${sub.id}`)).json.priceAmount).toBe(50_000)
  })

  it('blocks deleting a record that others use', async () => {
    const provider = (await api('GET', '/providers')).json[0]
    expect((await api('DELETE', `/providers/${provider.id}`)).status).toBe(409)
  })
})
