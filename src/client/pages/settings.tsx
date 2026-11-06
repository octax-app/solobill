import { type FormEvent, useEffect, useState } from 'react'
import { NavLink, Outlet } from 'react-router'
import { Choice, Confirm, Field, Loading, PageHeader } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'
import { api, run, useApi } from '@/lib/api'
import type { ApiTokenRow, Me, Settings } from '@/lib/types'
import { workspaceInput } from '../../shared/auth.ts'
import { CURRENCIES } from '../../shared/money.ts'

function General({ settings }: { settings: Settings }) {
  const [form, setForm] = useState({
    baseCurrency: settings.baseCurrency,
    renewalLeadDays: String(settings.renewalLeadDays),
    invoicePrefix: settings.invoicePrefix,
    proformaPrefix: settings.proformaPrefix,
  })
  useEffect(() => {
    setForm((current) => ({ ...current, baseCurrency: settings.baseCurrency }))
  }, [settings.baseCurrency])
  return (
    <Card>
      <CardHeader>
        <CardTitle>General</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Base currency"
          hint={
            settings.baseCurrencyLocked
              ? 'Locked because invoices already exist'
              : 'Locks once you add the first invoice'
          }
        >
          <Choice
            value={form.baseCurrency}
            disabled={settings.baseCurrencyLocked}
            onChange={(value) => setForm({ ...form, baseCurrency: value })}
            options={Object.entries(CURRENCIES).map(([code, { name }]) => ({
              value: code,
              label: `${code}, ${name}`,
            }))}
          />
        </Field>
        <Field label="Renewal lead time (days)" hint="How early renewal drafts are created">
          <Input
            type="number"
            min={1}
            max={120}
            value={form.renewalLeadDays}
            onChange={(event) => setForm({ ...form, renewalLeadDays: event.target.value })}
          />
        </Field>
        <Field label="Invoice number prefix">
          <Input
            value={form.invoicePrefix}
            onChange={(event) => setForm({ ...form, invoicePrefix: event.target.value })}
          />
        </Field>
        <Field label="Proforma number prefix">
          <Input
            value={form.proformaPrefix}
            onChange={(event) => setForm({ ...form, proformaPrefix: event.target.value })}
          />
        </Field>
        <div className="sm:col-span-2">
          <Button
            onClick={() =>
              run(
                () =>
                  api.put('/settings', {
                    ...form,
                    renewalLeadDays: Number(form.renewalLeadDays),
                  }),
                'Settings saved',
              )
            }
          >
            Save settings
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function Workspace({ name }: { name: string }) {
  const [value, setValue] = useState(name)
  const [error, setError] = useState('')
  useEffect(() => setValue(name), [name])

  async function submit(event: FormEvent) {
    event.preventDefault()
    const parsed = workspaceInput.safeParse({ name: value })
    setError(parsed.success ? '' : 'Enter a name')
    if (parsed.success) await run(() => api.put('/workspace', parsed.data), 'Workspace renamed')
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Workspace</CardTitle>
        <CardDescription>Your business name, shown in the sidebar.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
          <Field label="Name" className="min-w-64 flex-1">
            <Input
              value={value}
              maxLength={120}
              onChange={(event) => setValue(event.target.value)}
            />
          </Field>
          <Button type="submit" disabled={value.trim() === name}>
            Save
          </Button>
        </form>
        {error && <p className="text-destructive mt-2 text-sm">{error}</p>}
      </CardContent>
    </Card>
  )
}

function Tokens() {
  const { data } = useApi<ApiTokenRow[]>('/auth/tokens')
  if (!data?.length) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle>Connected apps</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableBody>
            {data.map((row) => (
              <TableRow key={row.id}>
                <TableCell>{row.name}</TableCell>
                <TableCell>{row.lastUsedAt?.slice(0, 10) ?? 'Never used'}</TableCell>
                <TableCell className="text-right">
                  <Confirm
                    title={`Disconnect ${row.name}?`}
                    description="It will need to log in again."
                    action="Disconnect"
                    onConfirm={() =>
                      run(() => api.del(`/auth/tokens/${row.id}`), 'App disconnected')
                    }
                  >
                    <Button size="sm" variant="ghost">
                      Disconnect
                    </Button>
                  </Confirm>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

const TABS = [
  { to: '/settings', label: 'Workspace' },
  { to: '/settings/account', label: 'Account' },
]

export function SettingsLayout() {
  return (
    <>
      <PageHeader title="Settings" />
      <nav className="mb-6 flex gap-1 border-b">
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end
            className={({ isActive }) =>
              `-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
                isActive
                  ? 'border-primary text-foreground'
                  : 'text-muted-foreground hover:text-foreground border-transparent'
              }`
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </>
  )
}

export function SettingsPage() {
  const settings = useApi<Settings>('/settings')
  const me = useApi<Me>('/auth/me')
  if (!settings.data || !me.data) return <Loading />
  return (
    <div className="grid max-w-3xl gap-6">
      <Workspace name={me.data.workspace.name} />
      <General settings={settings.data} />
      <Tokens />
    </div>
  )
}
