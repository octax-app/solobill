import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Choice, Confirm, Field, Loading, PageHeader } from '@/components/common'
import { PdfViewer } from '@/components/pdf-viewer'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { api, fileUrl, run, useApi } from '@/lib/api'
import type { OriginalFull, Provider, Service, Settings } from '@/lib/types'
import { todayISO } from '../../shared/dates.ts'
import {
  amountInput,
  CURRENCY_CODES,
  FX_SCALE,
  formatMoney,
  fxRateInput,
  lineNet,
  parseAmount,
  parseFxRate,
} from '../../shared/money.ts'

interface LineForm {
  key: number
  description: string
  quantity: string
  unitPrice: string
}

let nextKey = 1
const newLine = (over: Partial<LineForm> = {}): LineForm => ({
  key: nextKey++,
  description: '',
  quantity: '1',
  unitPrice: '0',
  ...over,
})

export function OriginalFormPage() {
  const { id } = useParams()
  const editing = id ? Number(id) : null
  const navigate = useNavigate()
  const existing = useApi<OriginalFull>(editing ? `/originals/${editing}` : null)
  const settings = useApi<Settings>('/settings')
  const providers = useApi<Provider[]>('/providers')
  const services = useApi<Service[]>('/services')
  const fileRef = useRef<HTMLInputElement>(null)

  const [providerId, setProviderId] = useState('')
  const [serviceId, setServiceId] = useState('')
  const [number, setNumber] = useState('')
  const [issuedOn, setIssuedOn] = useState(todayISO())
  const [dueOn, setDueOn] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [fxRate, setFxRate] = useState('1')
  const [tax, setTax] = useState('0')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<LineForm[]>([newLine()])
  const [localPdf, setLocalPdf] = useState<string | null>(null)

  const base = settings.data?.baseCurrency ?? 'USD'

  useEffect(() => {
    const row = existing.data
    if (!row) return
    setProviderId(String(row.providerId))
    setServiceId(row.serviceId ? String(row.serviceId) : '')
    setNumber(row.number)
    setIssuedOn(row.issuedOn)
    setDueOn(row.dueOn ?? '')
    setCurrency(row.currency)
    setFxRate(fxRateInput(row.fxRate))
    setTax(amountInput(row.tax))
    setNotes(row.notes)
    setLines(
      row.lines.map((line) =>
        newLine({
          description: line.description,
          quantity: amountInput(line.quantity),
          unitPrice: amountInput(line.unitPrice),
        }),
      ),
    )
  }, [existing.data])

  useEffect(() => {
    if (!editing && settings.data) setCurrency(settings.data.baseCurrency)
  }, [editing, settings.data])

  async function chooseCurrency(code: string) {
    setCurrency(code)
    if (code === base) return setFxRate(fxRateInput(FX_SCALE))
    setFxRate('')
    const { rate } = await api.get<{ rate: number | null }>(`/fx-rate?currency=${code}`)
    // Keep anything typed while the last rate was loading.
    if (rate) setFxRate((typed) => typed || fxRateInput(rate))
  }

  const patch = (key: number, change: Partial<LineForm>) =>
    setLines((rows) => rows.map((row) => (row.key === key ? { ...row, ...change } : row)))

  const subtotal = lines.reduce(
    (sum, line) =>
      sum + lineNet(parseAmount(line.quantity) ?? 0, parseAmount(line.unitPrice) ?? 0, currency),
    0,
  )
  const total = subtotal + (parseAmount(tax) ?? 0)

  async function save() {
    const body = {
      providerId: Number(providerId),
      serviceId: Number(serviceId) || null,
      number,
      issuedOn,
      dueOn: dueOn || null,
      currency,
      fxRate: currency === base ? FX_SCALE : (parseFxRate(fxRate) ?? 0),
      tax: parseAmount(tax) ?? 0,
      notes,
      lines: lines.map((line) => ({
        description: line.description,
        quantity: parseAmount(line.quantity) ?? 0,
        unitPrice: parseAmount(line.unitPrice) ?? 0,
      })),
    }
    const saved = await run(async () => {
      const row = editing
        ? await api.put<OriginalFull>(`/originals/${editing}`, body)
        : await api.post<OriginalFull>('/originals', body)
      const file = fileRef.current?.files?.[0]
      if (file) await api.upload(`/originals/${row.id}/pdf`, file)
      return row
    }, 'Original invoice saved')
    if (saved) navigate('/originals')
  }

  if (editing && !existing.data) return <Loading />
  const storedPdf = existing.data?.pdfFile ? fileUrl(existing.data.pdfFile) : null
  const shownPdf = localPdf ?? storedPdf
  const providerServices = (services.data ?? []).filter(
    (row) => !providerId || row.providerId === Number(providerId),
  )

  return (
    <>
      <PageHeader
        title={editing ? 'Edit original invoice' : 'Add original invoice'}
        actions={
          <>
            {editing && existing.data && (
              <Button
                variant="outline"
                onClick={() =>
                  run(
                    () =>
                      api.post(
                        `/originals/${editing}/${existing.data?.paidOn ? 'unpaid' : 'paid'}`,
                        {},
                      ),
                    existing.data?.paidOn ? 'Marked as unpaid' : 'Marked as paid',
                  )
                }
              >
                {existing.data.paidOn ? 'Undo paid' : 'Mark as paid'}
              </Button>
            )}
            {editing && (
              <Confirm
                title="Delete this original invoice?"
                description="Its PDF is deleted too, and linked customer lines lose the link. This cannot be undone."
                action="Delete invoice"
                destructive
                onConfirm={async () => {
                  const done = await run(
                    () => api.del(`/originals/${editing}`),
                    'Original invoice deleted',
                  )
                  if (done) navigate('/originals')
                }}
              >
                <Button variant="outline">Delete</Button>
              </Confirm>
            )}
            <Button onClick={save} disabled={!providerId}>
              Save original invoice
            </Button>
          </>
        }
      />
      <div className="grid gap-6 xl:grid-cols-2">
        <div className="grid min-w-0 content-start gap-6">
          <Card>
            <CardContent className="grid gap-4 pt-6 sm:grid-cols-2">
              <Field label="PDF" className="sm:col-span-2">
                <Input
                  ref={fileRef}
                  type="file"
                  accept="application/pdf"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    setLocalPdf(file ? URL.createObjectURL(file) : null)
                  }}
                />
              </Field>
              <Field label="Provider">
                <Choice
                  value={providerId}
                  onChange={(value) => {
                    setProviderId(value)
                    setServiceId('')
                  }}
                  options={(providers.data ?? []).map((row) => ({
                    value: row.id,
                    label: row.name,
                  }))}
                />
              </Field>
              <Field label="Invoice type">
                <Choice
                  value={serviceId}
                  allowNone="No type"
                  onChange={setServiceId}
                  options={providerServices.map((row) => ({ value: row.id, label: row.name }))}
                />
              </Field>
              <Field label="Invoice number">
                <Input value={number} onChange={(event) => setNumber(event.target.value)} />
              </Field>
              <Field label="Currency">
                <Choice
                  value={currency}
                  onChange={chooseCurrency}
                  options={CURRENCY_CODES.map((code) => ({ value: code, label: code }))}
                />
              </Field>
              <Field label="Invoice date">
                <Input
                  type="date"
                  value={issuedOn}
                  onChange={(event) => setIssuedOn(event.target.value)}
                />
              </Field>
              <Field label="Due date">
                <Input
                  type="date"
                  value={dueOn}
                  onChange={(event) => setDueOn(event.target.value)}
                />
              </Field>
              {currency !== base && (
                <Field label={`Rate: 1 ${currency} in ${base}`}>
                  <Input
                    inputMode="decimal"
                    value={fxRate}
                    onChange={(event) => setFxRate(event.target.value)}
                  />
                </Field>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">Lines</CardTitle>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setLines((rows) => [...rows, newLine()])}
              >
                <Plus className="size-4" /> Add line
              </Button>
            </CardHeader>
            <CardContent className="grid gap-2">
              {lines.map((line) => (
                <div key={line.key} className="grid grid-cols-[1fr_72px_110px_36px] gap-2">
                  <Input
                    aria-label="Description"
                    placeholder="Description"
                    value={line.description}
                    onChange={(event) => patch(line.key, { description: event.target.value })}
                  />
                  <Input
                    aria-label="Quantity"
                    inputMode="decimal"
                    value={line.quantity}
                    onChange={(event) => patch(line.key, { quantity: event.target.value })}
                  />
                  <Input
                    aria-label="Unit price"
                    inputMode="decimal"
                    value={line.unitPrice}
                    onChange={(event) => patch(line.key, { unitPrice: event.target.value })}
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Remove line"
                    onClick={() => setLines((rows) => rows.filter((row) => row.key !== line.key))}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <Field label="Tax amount">
                  <Input
                    inputMode="decimal"
                    value={tax}
                    onChange={(event) => setTax(event.target.value)}
                  />
                </Field>
                <div className="grid content-end justify-end text-sm tabular-nums">
                  <div>Subtotal: {formatMoney(subtotal, currency)}</div>
                  <div className="font-medium">Total: {formatMoney(total, currency)}</div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Field label="Notes">
            <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
          </Field>
        </div>
        {shownPdf ? (
          <PdfViewer src={shownPdf} title="Original invoice PDF" className="max-h-[85svh]" />
        ) : (
          <div className="text-muted-foreground flex h-64 items-center justify-center rounded border text-sm">
            Choose a PDF to see it here while you type.
          </div>
        )}
      </div>
    </>
  )
}
