/**
 * Fills a local development server with sample data for trying the apps.
 * Usage: pnpm demo [email] [password] [url]. It refuses anything but localhost.
 */
const [email = 'owner@example.com', password = 'demo-password', url = 'http://localhost:3000'] =
  process.argv.slice(2)

if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url)) {
  throw new Error('Demo data only goes to a server on localhost')
}

const USD = 100_000_000
let token = ''

async function call<T = { id: number }>(method: string, route: string, data?: unknown) {
  const response = await fetch(`${url}/api/v1${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  })
  const json = await response.json()
  if (!response.ok) throw new Error(`${method} ${route}: ${JSON.stringify(json)}`)
  return json as T
}

const signedIn = await call<{ token: string }>('POST', '/auth/token', {
  email,
  password,
  name: 'Demo data',
})
token = signedIn.token

const templates = await call<{ id: number }[]>('GET', '/templates')
await call('PUT', `/templates/${templates[0].id}`, {
  name: 'System template',
  companyName: 'Octax Trading',
  companyAddress: 'Muscat, Oman',
  taxNumber: 'OM1100',
  bankDetails: 'Bank: Example, IBAN OM00',
  defaultTaxRate: 50_000,
})

const providers = await call<{ id: number; name: string }[]>('GET', '/providers')
const services = await call<{ id: number; providerId: number; name: string }[]>('GET', '/services')
const provider = (name: string) => providers.find((row) => row.name === name)?.id
const service = (name: string) => services.find((row) => row.name === name)

const noura = await call('POST', '/customers', {
  name: 'Noura Al Balushi',
  company: 'Al Noor Clinics',
  email: 'noura@example.com',
  phone: '+968 9000 0001',
  address: 'Ruwi, Muscat',
  currency: 'OMR',
})
const omar = await call('POST', '/customers', {
  name: 'Omar Haddad',
  company: 'Haddad Logistics',
  email: 'omar@example.com',
  currency: 'USD',
})
await call('POST', '/customers', { name: 'Layla Nasser', status: 'lead', currency: 'USD' })

const server = service('Dedicated server')
const storage = service('S3 storage (R2)')
if (server && storage) {
  await call('POST', '/subscriptions', {
    customerId: omar.id,
    serviceId: server.id,
    startedOn: '2026-10-08',
    lines: [
      { description: 'Dedicated server', costAmount: 500_000, priceAmount: 800_000 },
      { description: 'Backup storage', costAmount: 100_000, priceAmount: 200_000 },
    ],
    costCurrency: 'USD',
    priceCurrency: 'USD',
  })
  await call('POST', '/subscriptions', {
    customerId: noura.id,
    serviceId: storage.id,
    label: 'Backups',
    startedOn: '2026-10-05',
    lines: [{ description: '', costAmount: 100_000, priceAmount: 40_000 }],
    costCurrency: 'USD',
    priceCurrency: 'OMR',
  })
}

const line = (description: string, unitPrice: number, costAmount: number) => ({
  description,
  quantity: 10_000,
  unitPrice,
  costAmount,
  costCurrency: 'USD',
  costFxRate: USD,
})

const issue = async (body: object) => {
  const draft = await call('POST', '/invoices', { taxRate: 50_000, ...body })
  return call('POST', `/invoices/${draft.id}/issue`)
}

await issue({
  type: 'invoice',
  customerId: omar.id,
  currency: 'USD',
  fxRate: USD,
  taxEnabled: true,
  dueOn: '2026-12-01',
  lines: [line('Dedicated server, October', 1_000_000, 600_000)],
})
const paid = await issue({
  type: 'invoice',
  customerId: noura.id,
  currency: 'OMR',
  fxRate: 260_000_000,
  taxEnabled: false,
  lines: [line('QuickBooks Online', 250_000, 300_000)],
})
await call('POST', `/invoices/${paid.id}/paid`, {})
await issue({
  type: 'proforma',
  customerId: omar.id,
  currency: 'USD',
  fxRate: USD,
  taxEnabled: false,
  validUntil: '2026-12-31',
  lines: [line('Domain renewal', 200_000, 150_000)],
})
await call('POST', '/originals', {
  providerId: provider('Contabo'),
  number: 'CTB-1042',
  issuedOn: '2026-10-05',
  dueOn: '2026-12-15',
  currency: 'USD',
  fxRate: USD,
  lines: [{ description: 'Dedicated server', quantity: 10_000, unitPrice: 600_000 }],
})

console.log(`Demo data added to ${url}`)

export {}
