import { type ReactElement, useState } from 'react'
import { Choice, Field } from '@/components/common'
import { amountProblem } from '@/components/payment-dialog'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'
import { api, run, useApi } from '@/lib/api'
import type { Customer, CustomerPayment, InvoiceRow } from '@/lib/types'
import { todayISO } from '../../shared/dates.ts'
import { CURRENCY_CODES, formatMoney, parseAmount } from '../../shared/money.ts'
import { allocatePayment, dueOf } from '../../shared/payments.ts'

const blankForm = (currency: string) => ({ currency, amount: '', paidOn: todayISO(), note: '' })

export function CustomerPaymentDialog({
  customer,
  children,
}: {
  customer: Customer
  children: ReactElement
}) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(blankForm(customer.currency))
  const invoices = useApi<InvoiceRow[]>(
    open ? `/invoices?customerId=${customer.id}&status=issued&type=invoice` : null,
  )
  const { currency } = form
  const openInvoices = (invoices.data ?? [])
    .filter((invoice) => invoice.currency === currency)
    .map((invoice) => ({ ...invoice, due: dueOf(invoice) }))
    .filter((invoice) => invoice.due > 0)
  const totalDue = openInvoices.reduce((sum, invoice) => sum + invoice.due, 0)
  const amount = parseAmount(form.amount)
  const problem = amountProblem(amount, currency)
  const split = amount !== null && !problem ? allocatePayment(amount, openInvoices) : null
  const none = invoices.data !== undefined && openInvoices.length === 0

  async function save() {
    const done = await run(
      () =>
        api.post<CustomerPayment>(`/customers/${customer.id}/payments`, {
          currency,
          amount,
          paidOn: form.paidOn,
          note: form.note,
        }),
      'Payment added',
    )
    if (done) setOpen(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setForm(blankForm(customer.currency))
        setOpen(next)
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a payment</DialogTitle>
          <DialogDescription>
            One amount from {customer.name}, spread over their open invoices, oldest first.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid grid-cols-[1fr_7rem] gap-2">
            <Field label="Amount" hint={form.amount ? (problem ?? undefined) : undefined}>
              <Input
                inputMode="decimal"
                value={form.amount}
                onChange={(event) => setForm({ ...form, amount: event.target.value })}
              />
            </Field>
            <Field label="Currency">
              <Choice
                value={currency}
                onChange={(value) => setForm({ ...form, currency: value })}
                options={CURRENCY_CODES.map((code) => ({ value: code, label: code }))}
              />
            </Field>
          </div>
          <Field label="Date">
            <Input
              type="date"
              value={form.paidOn}
              onChange={(event) => setForm({ ...form, paidOn: event.target.value })}
            />
          </Field>
          <Field label="Note">
            <Input
              maxLength={500}
              value={form.note}
              onChange={(event) => setForm({ ...form, note: event.target.value })}
            />
          </Field>
          {none && (
            <p className="text-muted-foreground text-sm">
              No open {currency} invoices for this customer.
            </p>
          )}
          {openInvoices.length > 0 && (
            <p className="text-muted-foreground text-sm">
              {formatMoney(totalDue, currency)} is due across {openInvoices.length}{' '}
              {openInvoices.length === 1 ? 'invoice' : 'invoices'}.
            </p>
          )}
          {split && split.allocations.length > 0 && (
            <div className="grid gap-2 text-sm">
              <Table>
                <TableBody>
                  {split.allocations.map((row) => {
                    const invoice = openInvoices.find((item) => item.id === row.invoiceId)
                    const left = (invoice?.due ?? 0) - row.amount
                    return (
                      <TableRow key={row.invoiceId}>
                        <TableCell>{invoice?.number}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {left > 0
                            ? `Partly paid, ${formatMoney(left, currency)} left`
                            : 'Paid in full'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatMoney(row.amount, currency)}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
              {split.excess > 0 && (
                <p className="text-muted-foreground">
                  {formatMoney(split.excess, currency)} extra counts as profit
                </p>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            onClick={save}
            disabled={Boolean(problem) || !split?.allocations.length || !form.paidOn}
          >
            Add payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
