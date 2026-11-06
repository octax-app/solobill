import { Plus, Trash2 } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Choice, Field } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api, run, useApi } from '@/lib/api'
import type { Customer, Service, Settings, Subscription } from '@/lib/types'
import {
  addDays,
  billingPeriods,
  CYCLE_LABELS,
  type Cycle,
  renewalAfter,
  todayISO,
} from '../../shared/dates.ts'
import { amountInput, CURRENCY_CODES, formatMoney, parseAmount } from '../../shared/money.ts'

const currencies = CURRENCY_CODES.map((code) => ({ value: code, label: code }))
const cycles = Object.entries(CYCLE_LABELS).map(([value, label]) => ({ value, label }))

interface LineState {
  key: number
  id?: number
  description: string
  costAmount: string
  priceAmount: string
}

interface State {
  customerId: string
  serviceId: string
  label: string
  cycle: Cycle
  startedOn: string
  nextRenewalOn: string
  costCurrency: string
  priceCurrency: string
  status: 'active' | 'paused' | 'cancelled'
  lines: LineState[]
  createFirstInvoice: boolean
}

let nextKey = 1
const newLine = (over: Partial<LineState> = {}): LineState => ({
  key: nextKey++,
  description: '',
  costAmount: '0',
  priceAmount: '0',
  ...over,
})

function initial(existing?: Subscription, customerId?: number): State {
  return {
    customerId: String(existing?.customerId ?? customerId ?? ''),
    serviceId: String(existing?.serviceId ?? ''),
    label: existing?.label ?? '',
    cycle: existing?.cycle ?? 'monthly',
    startedOn: existing?.startedOn ?? todayISO(),
    nextRenewalOn: existing?.nextRenewalOn ?? '',
    costCurrency: existing?.costCurrency ?? 'USD',
    priceCurrency: existing?.priceCurrency ?? 'USD',
    status: existing?.status ?? 'active',
    lines: existing?.lines.map((line) =>
      newLine({
        id: line.id,
        description: line.description,
        costAmount: amountInput(line.costAmount),
        priceAmount: amountInput(line.priceAmount),
      }),
    ) ?? [newLine()],
    createFirstInvoice: true,
  }
}

const sum = (lines: LineState[], field: 'costAmount' | 'priceAmount') =>
  lines.reduce((total, line) => total + (parseAmount(line[field]) ?? 0), 0)

/** What saving will do, shown before the owner commits to it. */
function preview(form: State, leadDays: number) {
  const today = todayISO()
  if (form.nextRenewalOn) return `The next renewal is ${form.nextRenewalOn}.`
  if (form.cycle === 'once' && !form.createFirstInvoice) return 'One time, so it never renews.'
  if (!form.createFirstInvoice) {
    const next = renewalAfter(form.startedOn, form.cycle, today)
    return `No first invoice. The next renewal is ${next}.`
  }
  if (form.status !== 'active') return 'The first invoice is created while the status is Active.'
  const price = sum(form.lines, 'priceAmount')
  if (form.cycle === 'once') {
    return `A draft is created for ${formatMoney(price, form.priceCurrency)}. It never renews.`
  }
  const horizon = addDays(today, leadDays)
  const { periods, next } = billingPeriods(form.startedOn, form.cycle, horizon)
  if (periods.length === 0) {
    return `The first draft is created ${leadDays} days before ${form.startedOn}.`
  }
  const count = periods.length === 1 ? '1 period' : `${periods.length} periods`
  const total = formatMoney(price * periods.length, form.priceCurrency)
  return `A draft is created now for ${count} from ${periods[0]}, ${total} in total. After it, the next renewal is ${next}.`
}

export function SubscriptionDialog({
  existing,
  customerId,
  children,
}: {
  existing?: Subscription
  customerId?: number
  children: ReactNode
}) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(() => initial(existing, customerId))
  const [dateTyped, setDateTyped] = useState(false)
  const customers = useApi<Customer[]>(open ? '/customers' : null)
  const services = useApi<Service[]>(open ? '/services' : null)
  const settings = useApi<Settings>(open ? '/settings' : null)
  const set = (patch: Partial<State>) => setForm((current) => ({ ...current, ...patch }))
  const setLine = (key: number, patch: Partial<LineState>) =>
    setForm((current) => ({
      ...current,
      lines: current.lines.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    }))

  useEffect(() => {
    if (open) {
      setForm(initial(existing, customerId))
      setDateTyped(false)
    }
  }, [open, existing, customerId])

  /** A date the owner did not type follows the cycle, so the server works it out again. */
  const setSchedule = (patch: Partial<State>) =>
    set(dateTyped ? patch : { ...patch, nextRenewalOn: '' })

  const service = services.data?.find((row) => row.id === Number(form.serviceId))
  const fallback = service
    ? [service.name, form.label].filter(Boolean).join(', ')
    : 'Printed on invoices'

  function chooseService(value: string) {
    const service = services.data?.find((row) => row.id === Number(value))
    if (!service) return
    const [first, ...others] = form.lines
    set({
      serviceId: value,
      cycle: service.cycle,
      lines: [
        {
          ...first,
          costAmount: amountInput(service.defaultCost),
          priceAmount: amountInput(service.defaultPrice),
        },
        ...others,
      ],
      costCurrency: service.currency,
      priceCurrency: service.currency,
      nextRenewalOn: dateTyped ? form.nextRenewalOn : '',
    })
  }

  async function save() {
    const body = {
      customerId: Number(form.customerId),
      serviceId: Number(form.serviceId),
      label: form.label,
      cycle: form.cycle,
      startedOn: form.startedOn,
      nextRenewalOn: form.nextRenewalOn || null,
      costCurrency: form.costCurrency,
      priceCurrency: form.priceCurrency,
      status: form.status,
      lines: form.lines.map((line) => ({
        id: line.id,
        description: line.description,
        costAmount: parseAmount(line.costAmount) ?? 0,
        priceAmount: parseAmount(line.priceAmount) ?? 0,
      })),
      ...(existing ? {} : { createFirstInvoice: form.createFirstInvoice }),
    }
    const saved = await run(
      () =>
        existing
          ? api.put<Subscription>(`/subscriptions/${existing.id}`, body)
          : api.post<Subscription & { firstDraftId: number | null }>('/subscriptions', body),
      existing ? 'Subscription saved' : 'Subscription added',
    )
    if (!saved) return
    setOpen(false)
    const draftId = 'firstDraftId' in saved ? saved.firstDraftId : null
    if (draftId) {
      toast.success('First invoice draft created', {
        action: { label: 'Open', onClick: () => navigate(`/invoices/${draftId}`) },
      })
    }
  }

  const typedDate = Boolean(form.nextRenewalOn)
  const cancelling = existing && existing.status !== 'cancelled' && form.status === 'cancelled'

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{existing ? 'Edit subscription' : 'Add subscription'}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Customer">
            <Choice
              value={form.customerId}
              onChange={(value) => set({ customerId: value })}
              disabled={Boolean(customerId || existing)}
              options={(customers.data ?? []).map((row) => ({ value: row.id, label: row.name }))}
            />
          </Field>
          <Field label="Service">
            <Choice
              value={form.serviceId}
              onChange={chooseService}
              disabled={Boolean(existing)}
              options={(services.data ?? []).map((row) => ({
                value: row.id,
                label: `${row.providerName}: ${row.name}`,
              }))}
            />
          </Field>
          <Field
            label="Label"
            hint="For example the domain or server name"
            className="sm:col-span-2"
          >
            <Input value={form.label} onChange={(event) => set({ label: event.target.value })} />
          </Field>
          <Field label="Billing cycle">
            <Choice
              value={form.cycle}
              onChange={(value) => setSchedule({ cycle: value as Cycle })}
              options={cycles}
            />
          </Field>
          <Field
            label="Status"
            hint={cancelling ? 'Any open renewal draft stays until you issue or discard it.' : ''}
          >
            <Choice
              value={form.status}
              onChange={(value) => set({ status: value as State['status'] })}
              options={[
                { value: 'active', label: 'Active' },
                { value: 'paused', label: 'Paused' },
                { value: 'cancelled', label: 'Cancelled' },
              ]}
            />
          </Field>
          <Field label="Start date" className="content-start">
            <Input
              type="date"
              value={form.startedOn}
              onChange={(event) => setSchedule({ startedOn: event.target.value })}
            />
          </Field>
          <Field label="Next renewal" hint="Worked out from the cycle. Type a date to override it.">
            <Input
              type="date"
              disabled={form.cycle === 'once'}
              value={form.nextRenewalOn}
              onChange={(event) => {
                set({ nextRenewalOn: event.target.value })
                setDateTyped(Boolean(event.target.value))
              }}
            />
          </Field>
          <div className="grid gap-2 sm:col-span-2">
            <div className="flex items-center justify-between gap-2">
              <Label>Lines</Label>
              <Button
                size="sm"
                variant="outline"
                onClick={() => set({ lines: [...form.lines, newLine()] })}
              >
                <Plus className="size-4" /> Add line
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              Descriptions print on customer invoices. Your cost stays internal.
            </p>
            <div className="text-muted-foreground hidden gap-2 text-xs sm:grid sm:grid-cols-[1fr_7rem_7rem_2.25rem]">
              <span>Description</span>
              <span>Your cost</span>
              <span>Your price</span>
            </div>
            {form.lines.map((line) => (
              <div
                key={line.key}
                className="grid grid-cols-[1fr_1fr_2.25rem] items-end gap-2 sm:grid-cols-[1fr_7rem_7rem_2.25rem]"
              >
                <Input
                  aria-label="Description"
                  className="col-span-3 sm:col-span-1"
                  placeholder={fallback}
                  value={line.description}
                  onChange={(event) => setLine(line.key, { description: event.target.value })}
                />
                <Label className="text-muted-foreground grid gap-1 text-xs font-normal sm:contents">
                  <span className="sm:hidden">Your cost</span>
                  <Input
                    aria-label="Your cost"
                    inputMode="decimal"
                    value={line.costAmount}
                    onChange={(event) => setLine(line.key, { costAmount: event.target.value })}
                  />
                </Label>
                <Label className="text-muted-foreground grid gap-1 text-xs font-normal sm:contents">
                  <span className="sm:hidden">Your price</span>
                  <Input
                    aria-label="Your price"
                    inputMode="decimal"
                    value={line.priceAmount}
                    onChange={(event) => setLine(line.key, { priceAmount: event.target.value })}
                  />
                </Label>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Remove line"
                  disabled={form.lines.length === 1}
                  onClick={() => set({ lines: form.lines.filter((row) => row.key !== line.key) })}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
            <p className="text-muted-foreground text-right text-xs tabular-nums">
              Total: cost {formatMoney(sum(form.lines, 'costAmount'), form.costCurrency)}, price{' '}
              {formatMoney(sum(form.lines, 'priceAmount'), form.priceCurrency)}
            </p>
          </div>
          <Field label="Cost currency">
            <Choice
              value={form.costCurrency}
              onChange={(value) => set({ costCurrency: value })}
              options={currencies}
            />
          </Field>
          <Field label="Price currency">
            <Choice
              value={form.priceCurrency}
              onChange={(value) => set({ priceCurrency: value })}
              options={currencies}
            />
          </Field>
          {!existing && (
            <div className="grid gap-2 sm:col-span-2">
              <Label className="flex items-center gap-2">
                <Checkbox
                  checked={form.createFirstInvoice && !typedDate}
                  disabled={typedDate}
                  onCheckedChange={(checked) => set({ createFirstInvoice: checked === true })}
                />
                Create first invoice
              </Label>
              <p className="text-muted-foreground text-xs">
                {typedDate
                  ? 'Off, because a typed date means earlier periods are handled elsewhere.'
                  : 'Untick this if you have already billed these periods, for example in QuickBooks.'}
              </p>
            </div>
          )}
          <p className="text-sm sm:col-span-2">
            {existing
              ? form.nextRenewalOn
                ? `The next renewal is ${form.nextRenewalOn}.`
                : 'The next renewal is worked out when you save.'
              : preview(form, settings.data?.renewalLeadDays ?? 14)}
          </p>
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={!form.customerId || !form.serviceId}>
            Save subscription
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
