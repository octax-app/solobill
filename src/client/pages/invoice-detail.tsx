import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { Choice, Confirm, Field, Loading, PageHeader, StatusBadge } from '@/components/common'
import { PaymentDialog } from '@/components/payment-dialog'
import { PdfViewer } from '@/components/pdf-viewer'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import type {
  InvoiceFull,
  InvoiceLine,
  InvoicePayment,
  OriginalLineOption,
  Settings,
  Template,
} from '@/lib/types'
import {
  amountInput,
  CURRENCY_CODES,
  formatMoney,
  fxRateInput,
  parseAmount,
  parseFxRate,
} from '../../shared/money.ts'
import { discountedTotals, dueOf, overpaidOf, paymentLabel } from '../../shared/payments.ts'
import { customItemsFor } from '../../shared/render.ts'

function CostDialog({
  invoiceId,
  line,
  base,
}: {
  invoiceId: number
  line: InvoiceLine
  base: string
}) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({
    costAmount: amountInput(line.costAmount),
    costCurrency: line.costCurrency,
    costFxRate: line.costFxRate ? fxRateInput(line.costFxRate) : '',
    originalInvoiceLineId: line.originalInvoiceLineId ? String(line.originalInvoiceLineId) : '',
  })
  const options = useApi<OriginalLineOption[]>(open ? '/original-lines' : null)

  async function save() {
    const done = await run(
      () =>
        api.patch(`/invoices/${invoiceId}/lines/${line.id}/cost`, {
          costAmount: parseAmount(form.costAmount) ?? 0,
          costCurrency: form.costCurrency,
          costFxRate: parseFxRate(form.costFxRate) ?? 0,
          originalInvoiceLineId: Number(form.originalInvoiceLineId) || null,
        }),
      'Cost saved',
    )
    if (done) setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost">
          Edit cost
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit cost</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label="Linked original invoice line">
            <Choice
              value={form.originalInvoiceLineId}
              allowNone="Not linked"
              onChange={(value) => {
                const match = options.data?.find((row) => row.id === Number(value))
                setForm({
                  ...form,
                  originalInvoiceLineId: value,
                  ...(match
                    ? { costAmount: amountInput(match.total), costCurrency: match.currency }
                    : {}),
                })
              }}
              options={(options.data ?? []).map((row) => ({
                value: row.id,
                label: `${row.providerName} ${row.number}: ${row.description}`,
              }))}
            />
          </Field>
          <Field label="Cost">
            <div className="flex gap-2">
              <Input
                inputMode="decimal"
                value={form.costAmount}
                onChange={(event) => setForm({ ...form, costAmount: event.target.value })}
              />
              <Choice
                className="w-28"
                value={form.costCurrency}
                onChange={(value) => setForm({ ...form, costCurrency: value })}
                options={CURRENCY_CODES.map((code) => ({ value: code, label: code }))}
              />
            </div>
          </Field>
          {form.costCurrency !== base && (
            <Field label={`Rate: 1 ${form.costCurrency} in ${base}`}>
              <Input
                inputMode="decimal"
                value={form.costFxRate}
                onChange={(event) => setForm({ ...form, costFxRate: event.target.value })}
              />
            </Field>
          )}
        </div>
        <DialogFooter>
          <Button onClick={save}>Save cost</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PaymentsCard({
  payments,
  currency,
  locked,
}: {
  payments: InvoicePayment[]
  currency: string
  locked: boolean
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Payments</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Note</TableHead>
              {!locked && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {payments.map((row) => {
              const discount = row.kind === 'discount'
              const name = discount ? 'discount' : 'payment'
              return (
                <TableRow key={row.id}>
                  <TableCell>{row.paidOn}</TableCell>
                  <TableCell>
                    <Badge variant={discount ? 'outline' : 'secondary'}>
                      {discount ? 'Discount' : row.groupId ? 'Customer payment' : 'Payment'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(row.amount, currency)}
                  </TableCell>
                  <TableCell className="whitespace-normal">{row.note}</TableCell>
                  {!locked && (
                    <TableCell className="text-right">
                      <Confirm
                        title={
                          row.groupId ? 'Remove this customer payment?' : `Remove this ${name}?`
                        }
                        description={
                          row.groupId
                            ? 'This was one customer payment, so the whole payment is removed from every invoice it was split across.'
                            : `The ${name} of ${formatMoney(row.amount, currency)} is removed and the amount due goes back up.`
                        }
                        action="Remove"
                        destructive
                        onConfirm={() =>
                          run(
                            () => api.del(`/payments/${row.id}`),
                            `${discount ? 'Discount' : 'Payment'} removed`,
                          )
                        }
                      >
                        <Button size="sm" variant="ghost">
                          Remove
                        </Button>
                      </Confirm>
                    </TableCell>
                  )}
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

export function InvoiceDetailPage() {
  const id = Number(useParams().id)
  const navigate = useNavigate()
  const { data } = useApi<InvoiceFull>(`/invoices/${id}`)
  const settings = useApi<Settings>('/settings')
  const template = useApi<Template>(
    data?.status === 'draft' ? `/templates/${data.templateId}` : null,
  )
  if (!data || !settings.data) return <Loading />

  // An issued document shows what was printed, whatever has happened to the template since.
  const customItems =
    data.customSnapshot ?? customItemsFor(template.data?.customFields ?? [], data.customValues)
  const base = settings.data.baseCurrency
  const draft = data.status === 'draft'
  const proforma = data.type === 'proforma'
  const issued = data.status === 'issued'
  const paid = data.status === 'paid'
  const totalCost = data.lines.reduce((sum, line) => sum + line.costBase, 0)
  const pdfUrl = `/api/v1/invoices/${id}/pdf`
  const due = dueOf(data)
  const overpaid = overpaidOf(data)
  const totals = discountedTotals(data)
  const undoDescription = [
    'Every payment and discount on this invoice is removed and it goes back to issued with nothing paid.',
    data.payments.some((row) => row.groupId) &&
      'A customer payment is removed from every invoice it was split across.',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <>
      <PageHeader
        title={data.number ?? (proforma ? 'Draft proforma' : 'Draft invoice')}
        description={data.source === 'renewal' ? 'Created from a renewal' : undefined}
        actions={
          <>
            <StatusBadge status={paymentLabel(data)} />
            {draft && (
              <Button asChild>
                <Link to={`/invoices/${id}/edit`}>Edit draft</Link>
              </Button>
            )}
            {draft && data.source === 'renewal' && (
              <Confirm
                title="Discard this renewal?"
                description="The draft is voided and the subscription moves to its next renewal date."
                action="Discard renewal"
                destructive
                onConfirm={() => run(() => api.post(`/invoices/${id}/void`), 'Renewal discarded')}
              >
                <Button variant="outline">Discard</Button>
              </Confirm>
            )}
            {draft && data.source === 'manual' && (
              <Confirm
                title="Delete this draft?"
                description="This cannot be undone."
                action="Delete draft"
                destructive
                onConfirm={async () => {
                  const done = await run(() => api.del(`/invoices/${id}`), 'Draft deleted')
                  if (done) navigate(proforma ? '/proformas' : '/invoices')
                }}
              >
                <Button variant="outline">Delete</Button>
              </Confirm>
            )}
            {issued && !proforma && (
              <>
                <PaymentDialog invoice={data} kind="payment">
                  <Button variant="outline">Add payment</Button>
                </PaymentDialog>
                <PaymentDialog invoice={data} kind="discount">
                  <Button variant="outline">Discount</Button>
                </PaymentDialog>
                <Button
                  onClick={() => run(() => api.post(`/invoices/${id}/paid`, {}), 'Marked as paid')}
                >
                  Mark as paid
                </Button>
              </>
            )}
            {paid && (
              <Confirm
                title="Undo paid?"
                description={undoDescription}
                action="Undo paid"
                destructive
                onConfirm={() =>
                  run(() => api.post(`/invoices/${id}/undo-payments`), 'Back to issued')
                }
              >
                <Button variant="outline">Undo paid</Button>
              </Confirm>
            )}
            {issued && proforma && (
              <Button
                onClick={async () => {
                  const created = await run(
                    () => api.post<InvoiceFull>(`/invoices/${id}/convert`),
                    'Draft invoice created',
                  )
                  if (created) navigate(`/invoices/${created.id}/edit`)
                }}
              >
                Convert to invoice
              </Button>
            )}
            {issued && data.payments.length === 0 && (
              <Confirm
                title="Reverse this document?"
                description="It goes back to draft and keeps its number. Its stored PDF is deleted and cannot be recovered, so any copy already sent stays the only one."
                action="Reverse document"
                destructive
                onConfirm={() => run(() => api.post(`/invoices/${id}/reverse`), 'Back to draft')}
              >
                <Button variant="outline">Reverse</Button>
              </Confirm>
            )}
            {(issued || paid) && (
              <Confirm
                title="Void this document?"
                description="Its number stays used and it no longer counts toward any totals. This cannot be undone."
                action="Void document"
                destructive
                onConfirm={() => run(() => api.post(`/invoices/${id}/void`), 'Document voided')}
              >
                <Button variant="outline">Void</Button>
              </Confirm>
            )}
            <Button
              variant="outline"
              onClick={async () => {
                const copy = await run(
                  () => api.post<InvoiceFull>(`/invoices/${id}/duplicate`),
                  'Draft created',
                )
                if (copy) navigate(`/invoices/${copy.id}/edit`)
              }}
            >
              Duplicate
            </Button>
            {data.pdfFile && (
              <Button asChild variant="outline">
                <a href={pdfUrl} download={`${data.number}.pdf`}>
                  Download PDF
                </a>
              </Button>
            )}
          </>
        }
      />
      <div className="grid gap-6 xl:grid-cols-2">
        <div className="grid min-w-0 content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Lines and internal cost</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Description</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.lines.map((line) => (
                    <TableRow key={line.id}>
                      <TableCell className="whitespace-normal">{line.description}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMoney(line.total, data.currency)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMoney(line.costAmount, line.costCurrency)}
                      </TableCell>
                      <TableCell className="text-right">
                        <CostDialog key={line.costAmount} invoiceId={id} line={line} base={base} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="grid gap-1 pt-6 text-sm tabular-nums">
              <div className="flex justify-between">
                <span>Subtotal</span>
                <span>{formatMoney(data.subtotal, data.currency)}</span>
              </div>
              {totals.discount > 0 && (
                <div className="flex justify-between">
                  <span>Discount</span>
                  <span>-{formatMoney(totals.discount, data.currency)}</span>
                </div>
              )}
              {data.taxEnabled && (
                <div className="flex justify-between">
                  <span>Tax</span>
                  <span>{formatMoney(totals.tax, data.currency)}</span>
                </div>
              )}
              <div className="flex justify-between font-medium">
                <span>Total</span>
                <span>{formatMoney(totals.total, data.currency)}</span>
              </div>
              {data.paidAmount > 0 && (
                <div className="flex justify-between">
                  <span>Paid</span>
                  <span>{formatMoney(data.paidAmount, data.currency)}</span>
                </div>
              )}
              {!proforma && (issued || paid) && (
                <div className="flex justify-between font-medium">
                  <span>Due</span>
                  <span>{formatMoney(due, data.currency)}</span>
                </div>
              )}
              {overpaid > 0 && (
                <div className="flex justify-between">
                  <span>Overpaid</span>
                  <span>{formatMoney(overpaid, data.currency)}</span>
                </div>
              )}
              <div className="text-muted-foreground mt-2 flex justify-between border-t pt-2">
                <span>Profit (internal)</span>
                <span>
                  {formatMoney(data.baseSubtotal + data.revenueAdjustBase - totalCost, base)}
                </span>
              </div>
              {data.paidOn && (
                <div className="text-muted-foreground flex justify-between">
                  <span>Paid on</span>
                  <span>{data.paidOn}</span>
                </div>
              )}
            </CardContent>
          </Card>
          {data.payments.length > 0 && (
            <PaymentsCard
              payments={data.payments}
              currency={data.currency}
              locked={!issued && !paid}
            />
          )}
          {customItems.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Custom items</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-1 text-sm">
                {customItems.map((item) => (
                  <div key={`${item.region}:${item.label}`} className="flex justify-between gap-4">
                    <span className="text-muted-foreground">{item.label}</span>
                    <span className="text-right">{item.value}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
        <PdfViewer
          key={`${data.updatedAt}-${data.pdfFile}`}
          src={pdfUrl}
          title="Invoice PDF"
          className="max-h-[85svh]"
        />
      </div>
    </>
  )
}
