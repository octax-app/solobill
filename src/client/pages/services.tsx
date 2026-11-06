import { Plus } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { Choice, Confirm, Empty, Field, Loading, PageHeader } from '@/components/common'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { api, run, useApi } from '@/lib/api'
import type { Provider, Service, Template } from '@/lib/types'
import { CYCLE_LABELS, type Cycle } from '../../shared/dates.ts'
import { amountInput, CURRENCY_CODES, formatMoney, parseAmount } from '../../shared/money.ts'

function ServiceDialog({ existing, children }: { existing?: Service; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const start = () => ({
    providerId: existing ? String(existing.providerId) : '',
    name: existing?.name ?? '',
    pricing: existing?.pricing ?? 'fixed',
    cycle: existing?.cycle ?? 'monthly',
    defaultCost: existing ? amountInput(existing.defaultCost) : '0',
    defaultPrice: existing ? amountInput(existing.defaultPrice) : '0',
    currency: existing?.currency ?? 'USD',
    defaultTemplateId: existing?.defaultTemplateId ? String(existing.defaultTemplateId) : '',
  })
  const [form, setForm] = useState(start)
  const providers = useApi<Provider[]>(open ? '/providers' : null)
  const templates = useApi<Template[]>(open ? '/templates' : null)
  const set = (patch: Partial<ReturnType<typeof start>>) =>
    setForm((current) => ({ ...current, ...patch }))

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the dialog opens
  useEffect(() => {
    if (open) setForm(start())
  }, [open])

  async function save() {
    const body = {
      ...form,
      providerId: Number(form.providerId),
      defaultCost: parseAmount(form.defaultCost) ?? 0,
      defaultPrice: parseAmount(form.defaultPrice) ?? 0,
      defaultTemplateId: Number(form.defaultTemplateId) || null,
    }
    const saved = await run(
      () => (existing ? api.put(`/services/${existing.id}`, body) : api.post('/services', body)),
      'Service saved',
    )
    if (saved) setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{existing ? 'Edit service' : 'Add service'}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <Input value={form.name} onChange={(event) => set({ name: event.target.value })} />
          </Field>
          <Field label="Provider">
            <Choice
              value={form.providerId}
              onChange={(value) => set({ providerId: value })}
              options={(providers.data ?? []).map((row) => ({ value: row.id, label: row.name }))}
            />
          </Field>
          <Field label="Pricing" hint="Metered prices change with usage">
            <Choice
              value={form.pricing}
              onChange={(value) => set({ pricing: value as 'fixed' | 'metered' })}
              options={[
                { value: 'fixed', label: 'Fixed' },
                { value: 'metered', label: 'Metered' },
              ]}
            />
          </Field>
          <Field label="Billing cycle">
            <Choice
              value={form.cycle}
              onChange={(value) => set({ cycle: value as Cycle })}
              options={Object.entries(CYCLE_LABELS).map(([value, label]) => ({ value, label }))}
            />
          </Field>
          <Field label="Default cost">
            <Input
              inputMode="decimal"
              value={form.defaultCost}
              onChange={(event) => set({ defaultCost: event.target.value })}
            />
          </Field>
          <Field label="Default price">
            <Input
              inputMode="decimal"
              value={form.defaultPrice}
              onChange={(event) => set({ defaultPrice: event.target.value })}
            />
          </Field>
          <Field label="Currency">
            <Choice
              value={form.currency}
              onChange={(value) => set({ currency: value })}
              options={CURRENCY_CODES.map((code) => ({ value: code, label: code }))}
            />
          </Field>
          <Field label="Template for this type" hint="Used before the provider's template">
            <Choice
              value={form.defaultTemplateId}
              onChange={(value) => set({ defaultTemplateId: value })}
              allowNone="Use the provider's template"
              options={(templates.data ?? []).map((row) => ({ value: row.id, label: row.name }))}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={!form.providerId}>
            Save service
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ServicesPage() {
  const { data } = useApi<Service[]>('/services')
  return (
    <>
      <PageHeader
        title="Services"
        description="What you resell. Each service is also an invoice type and can have its own template."
        actions={
          <ServiceDialog>
            <Button>
              <Plus className="size-4" /> Add service
            </Button>
          </ServiceDialog>
        }
      />
      {!data ? (
        <Loading />
      ) : data.length === 0 ? (
        <Empty>No services yet.</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Service</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead>Pricing</TableHead>
              <TableHead>Cycle</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-medium">{row.name}</TableCell>
                <TableCell>{row.providerName}</TableCell>
                <TableCell className="capitalize">{row.pricing}</TableCell>
                <TableCell>{CYCLE_LABELS[row.cycle]}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatMoney(row.defaultCost, row.currency)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatMoney(row.defaultPrice, row.currency)}
                </TableCell>
                <TableCell className="text-right">
                  <ServiceDialog existing={row}>
                    <Button size="sm" variant="ghost">
                      Edit
                    </Button>
                  </ServiceDialog>
                  <Confirm
                    title={`Archive ${row.name}?`}
                    description="It will be hidden from lists. Existing subscriptions keep working."
                    action="Archive service"
                    onConfirm={() =>
                      run(() => api.post(`/services/${row.id}/archive`), 'Service archived')
                    }
                  >
                    <Button size="sm" variant="ghost">
                      Archive
                    </Button>
                  </Confirm>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  )
}
