import { Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { Choice, Field, Loading, PageHeader } from '@/components/common'
import { PdfViewer } from '@/components/pdf-viewer'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { api, run, useApi } from '@/lib/api'
import type {
  Customer,
  InvoiceFull,
  Provider,
  Service,
  Settings,
  Subscription,
  Template,
} from '@/lib/types'
import { calculateInvoice } from '../../shared/calc.ts'
import {
  amountInput,
  CURRENCY_CODES,
  FX_SCALE,
  formatMoney,
  fxRateInput,
  parseAmount,
  parseFxRate,
  parsePercent,
  percentText,
} from '../../shared/money.ts'
import { type CustomField, type CustomValues, customValueProblem } from '../../shared/render.ts'
import { CustomerDialog } from './customers.tsx'

interface LineForm {
  key: number
  subscriptionId: number | null
  subscriptionLineId: number | null
  periodStart: string | null
  description: string
  quantity: string
  unitPrice: string
  /** Set while a subscription's price is in another currency and needs typing in. */
  priceNote: string
  costAmount: string
  costCurrency: string
  costFxRate: string
  originalInvoiceLineId: number | null
  amountConfirmed: boolean
}

let nextKey = 1
const newLine = (currency: string, over: Partial<LineForm> = {}): LineForm => ({
  key: nextKey++,
  subscriptionId: null,
  subscriptionLineId: null,
  periodStart: null,
  description: '',
  quantity: '1',
  unitPrice: '0',
  priceNote: '',
  costAmount: '0',
  costCurrency: currency,
  costFxRate: '',
  originalInvoiceLineId: null,
  amountConfirmed: true,
  ...over,
})

function CustomValueInput({
  field,
  value,
  onChange,
}: {
  field: CustomField
  value: string
  onChange: (value: string) => void
}) {
  return (
    <Field label={field.required ? `${field.label} (required)` : field.label}>
      <Input
        type={field.type === 'date' ? 'date' : 'text'}
        inputMode={field.type === 'number' ? 'decimal' : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  )
}

export function InvoiceEditorPage({ type }: { type: 'invoice' | 'proforma' }) {
  const { id } = useParams()
  const editing = id ? Number(id) : null
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const existing = useApi<InvoiceFull>(editing ? `/invoices/${editing}` : null)
  const settings = useApi<Settings>('/settings')
  const customers = useApi<Customer[]>('/customers')
  const providers = useApi<Provider[]>('/providers')
  const services = useApi<Service[]>('/services')
  const templates = useApi<Template[]>('/templates')

  const [number, setNumber] = useState('')
  const [customerId, setCustomerId] = useState(params.get('customerId') ?? '')
  const [providerId, setProviderId] = useState('')
  const [serviceId, setServiceId] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [issueDate, setIssueDate] = useState('')
  const [dueOn, setDueOn] = useState('')
  const [validUntil, setValidUntil] = useState('')
  const [currency, setCurrency] = useState('')
  const [fxRate, setFxRate] = useState('')
  const [taxEnabled, setTaxEnabled] = useState(false)
  const [taxRate, setTaxRate] = useState('5')
  const [notes, setNotes] = useState('')
  const [customValues, setCustomValues] = useState<CustomValues>({})
  const [lines, setLines] = useState<LineForm[]>([])
  const [loadedId, setLoadedId] = useState<number | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [pickerKey, setPickerKey] = useState(0)

  const docType = existing.data?.type ?? type
  const base = settings.data?.baseCurrency ?? 'USD'
  const subscriptions = useApi<Subscription[]>(
    customerId ? `/subscriptions?customerId=${customerId}` : null,
  )

  useEffect(() => {
    const row = existing.data
    if (!row || loadedId === row.id) return
    setLoadedId(row.id)
    setNumber(row.number ?? '')
    setCustomerId(String(row.customerId))
    setProviderId(row.providerId ? String(row.providerId) : '')
    setServiceId(row.serviceId ? String(row.serviceId) : '')
    setTemplateId(String(row.templateId))
    setIssueDate(row.issueDate ?? '')
    setDueOn(row.dueOn ?? '')
    setValidUntil(row.validUntil ?? '')
    setCurrency(row.currency)
    setFxRate(row.fxRate ? fxRateInput(row.fxRate) : '')
    setTaxEnabled(row.taxEnabled)
    setTaxRate(percentText(row.taxRate))
    setNotes(row.notes)
    setCustomValues(row.customValues)
    setLines(
      row.lines.map((line) =>
        newLine(line.costCurrency, {
          subscriptionId: line.subscriptionId,
          subscriptionLineId: line.subscriptionLineId,
          periodStart: line.periodStart,
          description: line.description,
          quantity: amountInput(line.quantity),
          unitPrice: amountInput(line.unitPrice),
          costAmount: amountInput(line.costAmount),
          costFxRate: line.costFxRate ? fxRateInput(line.costFxRate) : '',
          originalInvoiceLineId: line.originalInvoiceLineId,
          amountConfirmed: line.amountConfirmed,
        }),
      ),
    )
  }, [existing.data, loadedId])

  const rateFor = useCallback(
    async (code: string) => {
      if (code === base) return fxRateInput(FX_SCALE)
      const { rate } = await api.get<{ rate: number | null }>(`/fx-rate?currency=${code}`)
      return rate ? fxRateInput(rate) : ''
    },
    [base],
  )

  useEffect(() => {
    if (editing || !settings.data) return
    if (!currency) setCurrency(base)
    setLines((rows) =>
      rows.length ? rows : [newLine(base, { costFxRate: fxRateInput(FX_SCALE) })],
    )
  }, [editing, settings.data, base, currency])

  useEffect(() => {
    if (editing || templateId || !templates.data) return
    const first = templates.data.find((row) => row.isDefault)
    if (first) {
      setTemplateId(String(first.id))
      setTaxRate(percentText(first.defaultTaxRate))
    }
  }, [editing, templateId, templates.data])

  async function chooseCustomer(value: string) {
    setCustomerId(value)
    const customer = customers.data?.find((row) => row.id === Number(value))
    if (customer) await chooseCurrency(customer.currency)
  }

  async function chooseCurrency(code: string) {
    setCurrency(code)
    setFxRate('')
    setLines((rows) => rows.map((row) => repriced(row, code)))
    const rate = await rateFor(code)
    // Keep anything typed while the last rate was loading.
    setFxRate((typed) => typed || rate)
  }

  async function chooseTemplateFor(nextService: string, nextProvider: string) {
    const query = new URLSearchParams()
    if (nextService) query.set('serviceId', nextService)
    if (nextProvider) query.set('providerId', nextProvider)
    const { templateId: resolved } = await api.get<{ templateId: number }>(
      `/resolve-template?${query}`,
    )
    setTemplateId(String(resolved))
    const template = templates.data?.find((row) => row.id === resolved)
    if (template) setTaxRate(percentText(template.defaultTaxRate))
  }

  const patchLine = (key: number, patch: Partial<LineForm>) =>
    setLines((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)))

  /** Amounts are never carried across currencies: the owner types the price instead. */
  function priceFields(amount: number, subscription: Subscription, code: string) {
    return subscription.priceCurrency === code
      ? { unitPrice: amountInput(amount), priceNote: '' }
      : {
          unitPrice: '',
          priceNote: `Subscription price: ${formatMoney(amount, subscription.priceCurrency)}`,
        }
  }

  function repriced(row: LineForm, code: string) {
    const subscription = subscriptions.data?.find((item) => item.id === row.subscriptionId)
    const line = subscription?.lines.find((item) => item.id === row.subscriptionLineId)
    if (!subscription || !line) return row
    const crossing = subscription.priceCurrency !== code
    if (crossing === Boolean(row.priceNote)) return row
    return { ...row, ...priceFields(line.priceAmount, subscription, code) }
  }

  async function addSubscription(value: string) {
    const subscription = subscriptions.data?.find((row) => row.id === Number(value))
    if (!subscription) return
    setPickerKey((key) => key + 1)
    setLines((rows) => [
      ...rows.filter((row) => row.description || parseAmount(row.unitPrice)),
      ...subscription.lines.map((line) =>
        newLine(subscription.costCurrency, {
          subscriptionId: subscription.id,
          subscriptionLineId: line.id,
          description: line.description,
          costAmount: amountInput(line.costAmount),
          ...priceFields(line.priceAmount, subscription, currency),
        }),
      ),
    ])
    const rate = await rateFor(subscription.costCurrency)
    setLines((rows) =>
      rows.map((row) =>
        row.subscriptionId === subscription.id && !row.costFxRate
          ? { ...row, costFxRate: rate }
          : row,
      ),
    )
  }

  const offered = (subscriptions.data ?? []).filter(
    (row) => row.status === 'active' && !lines.some((line) => line.subscriptionId === row.id),
  )
  const pickerHint = !customerId
    ? 'Choose a customer first'
    : !subscriptions.data
      ? 'Loading subscriptions'
      : offered.length
        ? 'Add from subscription'
        : subscriptions.data.some((row) => row.status === 'active')
          ? 'All subscriptions added'
          : 'No active subscriptions'

  const parsedLines = lines.map((line) => ({
    subscriptionId: line.subscriptionId,
    subscriptionLineId: line.subscriptionLineId,
    periodStart: line.periodStart,
    description: line.description,
    quantity: parseAmount(line.quantity) ?? 0,
    unitPrice: parseAmount(line.unitPrice) ?? 0,
    costAmount: parseAmount(line.costAmount) ?? 0,
    costCurrency: line.costCurrency,
    costFxRate: parseFxRate(line.costFxRate) ?? 0,
    originalInvoiceLineId: line.originalInvoiceLineId,
    amountConfirmed: line.amountConfirmed,
  }))

  const totals = currency
    ? calculateInvoice({
        currency,
        baseCurrency: base,
        fxRate: parseFxRate(fxRate) ?? 0,
        taxEnabled,
        taxRate: parsePercent(taxRate) ?? 0,
        lines: parsedLines,
      })
    : null

  const customFields = [
    ...(templates.data?.find((row) => row.id === Number(templateId))?.customFields ?? []),
  ].sort((a, b) => a.order - b.order)

  async function save() {
    if (lines.some((line) => line.priceNote && !parseAmount(line.unitPrice))) {
      toast.error(`Enter the ${currency} price on the subscription lines`)
      return undefined
    }
    const body = {
      type: docType,
      number,
      customerId: Number(customerId),
      providerId: Number(providerId) || null,
      serviceId: Number(serviceId) || null,
      templateId: Number(templateId) || null,
      issueDate: issueDate || null,
      dueOn: dueOn || null,
      validUntil: validUntil || null,
      currency,
      fxRate: parseFxRate(fxRate) ?? 0,
      taxEnabled,
      taxRate: parsePercent(taxRate) ?? 0,
      notes,
      customValues,
      lines: parsedLines,
    }
    return run(() =>
      editing
        ? api.put<InvoiceFull>(`/invoices/${editing}`, body)
        : api.post<InvoiceFull>('/invoices', body),
    )
  }

  async function saveDraft() {
    const saved = await save()
    if (saved) {
      navigate(`/invoices/${saved.id}/edit`, { replace: true })
      return saved
    }
    return undefined
  }

  async function showPreview() {
    const saved = await saveDraft()
    if (!saved) return
    const blob = await run(() => api.blob(`/invoices/${saved.id}/pdf`))
    if (blob) setPreview(URL.createObjectURL(blob))
  }

  async function issue() {
    const problem = customFields
      .map((field) => customValueProblem(field, customValues[field.id]))
      .find(Boolean)
    if (problem) {
      toast.error(problem)
      return
    }
    const saved = await save()
    if (!saved) return
    const issued = await run(
      () => api.post(`/invoices/${saved.id}/issue`),
      docType === 'proforma' ? 'Proforma issued' : 'Invoice issued',
    )
    navigate(issued ? `/invoices/${saved.id}` : `/invoices/${saved.id}/edit`, { replace: true })
  }

  if (editing && !existing.data) return <Loading />
  if (existing.data && existing.data.status !== 'draft') {
    return (
      <Alert>
        <AlertDescription>Only drafts can be edited.</AlertDescription>
      </Alert>
    )
  }

  const providerServices = (services.data ?? []).filter(
    (row) => !providerId || row.providerId === Number(providerId),
  )
  const proforma = docType === 'proforma'
  const unconfirmed = lines.some((line) => !line.amountConfirmed)

  return (
    <>
      <PageHeader
        title={`${editing ? 'Edit' : 'New'} ${proforma ? 'proforma' : 'invoice'}`}
        actions={
          <>
            <Button variant="outline" onClick={saveDraft} disabled={!customerId}>
              Save draft
            </Button>
            <Button variant="outline" onClick={showPreview} disabled={!customerId}>
              Preview PDF
            </Button>
            <Button onClick={issue} disabled={!customerId}>
              {proforma ? 'Issue proforma' : 'Issue invoice'}
            </Button>
          </>
        }
      />
      {unconfirmed && (
        <Alert className="mb-4">
          <AlertDescription>
            This draft has a metered amount based on the last bill. Update it and tick Confirmed
            before issuing.
          </AlertDescription>
        </Alert>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="grid min-w-0 content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Customer and template</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field label="Customer">
                <div className="flex gap-2">
                  <Choice
                    value={customerId}
                    onChange={chooseCustomer}
                    options={(customers.data ?? []).map((row) => ({
                      value: row.id,
                      label: row.company || row.name,
                    }))}
                  />
                  <CustomerDialog
                    defaultStatus={proforma ? 'lead' : 'active'}
                    onSaved={(customer) => {
                      setCustomerId(String(customer.id))
                      chooseCurrency(customer.currency)
                    }}
                  >
                    <Button variant="outline" size="icon" aria-label="Add customer">
                      <Plus className="size-4" />
                    </Button>
                  </CustomerDialog>
                </div>
              </Field>
              <Field label="Template">
                <Choice
                  value={templateId}
                  onChange={setTemplateId}
                  options={(templates.data ?? []).map((row) => ({
                    value: row.id,
                    label: row.name,
                  }))}
                />
              </Field>
              <Field
                label="Issue date"
                hint="Enter your QuickBooks date, or leave empty for the day you issue it"
              >
                <Input
                  type="date"
                  value={issueDate}
                  onChange={(event) => setIssueDate(event.target.value)}
                />
              </Field>
              {customFields.length > 0 && (
                <div className="grid gap-4 sm:col-span-2 sm:grid-cols-2">
                  {customFields.map((field) => (
                    <CustomValueInput
                      key={field.id}
                      field={field}
                      value={customValues[field.id] ?? ''}
                      onChange={(value) =>
                        setCustomValues((values) => ({ ...values, [field.id]: value }))
                      }
                    />
                  ))}
                </div>
              )}
              <Field label="Provider" hint="Internal only. Picks the template and services.">
                <Choice
                  value={providerId}
                  allowNone="No provider"
                  onChange={(value) => {
                    setProviderId(value)
                    setServiceId('')
                    chooseTemplateFor('', value)
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
                  onChange={(value) => {
                    setServiceId(value)
                    chooseTemplateFor(value, providerId)
                  }}
                  options={providerServices.map((row) => ({ value: row.id, label: row.name }))}
                />
              </Field>
              <Field
                label={proforma ? 'Proforma number' : 'Invoice number'}
                hint="Enter your QuickBooks number, or leave empty to number it automatically"
              >
                <Input value={number} onChange={(event) => setNumber(event.target.value)} />
              </Field>
              {proforma ? (
                <Field label="Valid until">
                  <Input
                    type="date"
                    value={validUntil}
                    onChange={(event) => setValidUntil(event.target.value)}
                  />
                </Field>
              ) : (
                <Field label="Due date">
                  <Input
                    type="date"
                    value={dueOn}
                    onChange={(event) => setDueOn(event.target.value)}
                  />
                </Field>
              )}
              <Field label="Currency">
                <Choice
                  value={currency}
                  onChange={chooseCurrency}
                  options={CURRENCY_CODES.map((code) => ({ value: code, label: code }))}
                />
              </Field>
              {currency && currency !== base && (
                <Field label={`Rate: 1 ${currency} in ${base}`} hint="Locked on this invoice">
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
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-base">Lines</CardTitle>
              <div className="flex flex-wrap gap-2">
                <Choice
                  key={pickerKey}
                  className="w-56"
                  value=""
                  placeholder={pickerHint}
                  disabled={offered.length === 0}
                  onChange={addSubscription}
                  options={offered.map((row) => ({
                    value: row.id,
                    label: `${row.serviceName}${row.label ? `, ${row.label}` : ''}`,
                  }))}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setLines((rows) => [
                      ...rows,
                      newLine(base, { costFxRate: fxRateInput(FX_SCALE) }),
                    ])
                  }
                >
                  <Plus className="size-4" /> Add line
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-52">Description</TableHead>
                    <TableHead className="w-20">Qty</TableHead>
                    <TableHead className="w-28">Unit price</TableHead>
                    <TableHead className="w-56">Your cost (internal)</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((line) => (
                    <TableRow key={line.key} className="align-top">
                      <TableCell>
                        <Textarea
                          aria-label="Description"
                          className="min-h-9"
                          rows={1}
                          value={line.description}
                          onChange={(event) =>
                            patchLine(line.key, { description: event.target.value })
                          }
                        />
                        {!line.amountConfirmed && (
                          <Label className="mt-2 flex items-center gap-2 text-xs">
                            <Checkbox
                              checked={false}
                              onCheckedChange={() => patchLine(line.key, { amountConfirmed: true })}
                            />
                            Confirmed
                          </Label>
                        )}
                      </TableCell>
                      <TableCell>
                        <Input
                          aria-label="Quantity"
                          inputMode="decimal"
                          value={line.quantity}
                          onChange={(event) =>
                            patchLine(line.key, { quantity: event.target.value })
                          }
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          aria-label="Unit price"
                          inputMode="decimal"
                          value={line.unitPrice}
                          onChange={(event) =>
                            patchLine(line.key, { unitPrice: event.target.value })
                          }
                        />
                        {line.priceNote && (
                          <p className="text-destructive mt-1 text-xs">
                            {line.priceNote}. Enter the {currency} price.
                          </p>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="grid gap-1">
                          <div className="flex gap-1">
                            <Input
                              aria-label="Cost"
                              inputMode="decimal"
                              value={line.costAmount}
                              onChange={(event) =>
                                patchLine(line.key, { costAmount: event.target.value })
                              }
                            />
                            <Choice
                              className="w-24"
                              value={line.costCurrency}
                              onChange={async (value) => {
                                patchLine(line.key, {
                                  costCurrency: value,
                                  costFxRate: await rateFor(value),
                                })
                              }}
                              options={CURRENCY_CODES.map((code) => ({
                                value: code,
                                label: code,
                              }))}
                            />
                          </div>
                          {line.costCurrency !== base && (
                            <Input
                              aria-label="Cost exchange rate"
                              placeholder={`1 ${line.costCurrency} in ${base}`}
                              inputMode="decimal"
                              value={line.costFxRate}
                              onChange={(event) =>
                                patchLine(line.key, { costFxRate: event.target.value })
                              }
                            />
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label="Remove line"
                          onClick={() =>
                            setLines((rows) => rows.filter((row) => row.key !== line.key))
                          }
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Field label="Notes" hint="Printed on the document">
            <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
          </Field>
        </div>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-base">Totals</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <Label className="flex items-center gap-2">
              <Checkbox
                checked={taxEnabled}
                onCheckedChange={(value) => setTaxEnabled(value === true)}
              />
              Add tax
            </Label>
            {taxEnabled && (
              <Field label="Tax rate (%)">
                <Input
                  inputMode="decimal"
                  value={taxRate}
                  onChange={(event) => setTaxRate(event.target.value)}
                />
              </Field>
            )}
            {totals && (
              <div className="grid gap-1 tabular-nums">
                <div className="flex justify-between">
                  <span>Subtotal</span>
                  <span>{formatMoney(totals.subtotal, currency)}</span>
                </div>
                {taxEnabled && (
                  <div className="flex justify-between">
                    <span>Tax</span>
                    <span>{formatMoney(totals.tax, currency)}</span>
                  </div>
                )}
                <div className="flex justify-between border-t pt-1 font-medium">
                  <span>Total</span>
                  <span>{formatMoney(totals.total, currency)}</span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="flex h-[90svh] flex-col sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Preview</DialogTitle>
          </DialogHeader>
          {preview && <PdfViewer src={preview} title="Invoice preview" className="flex-1" />}
        </DialogContent>
      </Dialog>
    </>
  )
}
