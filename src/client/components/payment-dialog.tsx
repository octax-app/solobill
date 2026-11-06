import { type ReactElement, useState } from 'react'
import { Field } from '@/components/common'
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
import { api, run } from '@/lib/api'
import type { Invoice } from '@/lib/types'
import { todayISO } from '../../shared/dates.ts'
import {
  amountInput,
  currencyDecimals,
  formatMoney,
  parseAmount,
  roundToCurrency,
} from '../../shared/money.ts'
import { discountLimit, discountWithTax, dueOf } from '../../shared/payments.ts'

/** Why an amount cannot be saved, or null when it can. */
export function amountProblem(amount: number | null, currency: string) {
  if (amount === null || amount <= 0) return 'Enter an amount above 0'
  if (amount !== roundToCurrency(amount, currency)) {
    return `${currency} amounts can have at most ${currencyDecimals(currency)} decimal places`
  }
  return null
}

const blankForm = (due: number) => ({
  amount: due > 0 ? amountInput(due) : '',
  paidOn: todayISO(),
  note: '',
})

export function PaymentDialog({
  invoice,
  kind,
  children,
}: {
  invoice: Invoice
  kind: 'payment' | 'discount'
  children: ReactElement
}) {
  const due = dueOf(invoice)
  const discount = kind === 'discount'
  const start = discount ? discountLimit(invoice) : due
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(blankForm(start))
  const { currency } = invoice
  const amount = parseAmount(form.amount)
  const tooMuch = discount && amount !== null && amount > start
  const basis = invoice.taxEnabled ? ' before tax' : ''
  const problem = tooMuch
    ? `The discount cannot be more than ${formatMoney(start, currency)}${basis}`
    : amountProblem(amount, currency)
  const extra = !discount && amount !== null ? amount - due : 0

  async function save() {
    const done = await run(
      () =>
        api.post(`/invoices/${invoice.id}/payments`, {
          kind,
          amount,
          paidOn: form.paidOn,
          note: form.note,
        }),
      discount ? 'Discount added' : 'Payment added',
    )
    if (done) setOpen(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // The due moves with every payment, so each opening starts from the current one.
        if (next) setForm(blankForm(start))
        setOpen(next)
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{discount ? 'Add a discount' : 'Add a payment'}</DialogTitle>
          <DialogDescription>
            {formatMoney(due, currency)} is due on {invoice.number}.
            {discount &&
              ' A discount lowers profit, prints on the PDF and replaces the stored PDF.'}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field
            label={
              discount && invoice.taxEnabled
                ? `Amount before tax in ${currency}`
                : `Amount in ${currency}`
            }
            hint={form.amount ? (problem ?? undefined) : undefined}
          >
            <Input
              inputMode="decimal"
              value={form.amount}
              onChange={(event) => setForm({ ...form, amount: event.target.value })}
            />
          </Field>
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
          {discount && invoice.taxEnabled && amount !== null && !problem && (
            <p className="text-muted-foreground text-sm">
              {formatMoney(discountWithTax(amount, invoice), currency)} comes off the amount due
            </p>
          )}
          {extra > 0 && !problem && (
            <p className="text-muted-foreground text-sm">
              {formatMoney(extra, currency)} extra counts as profit
            </p>
          )}
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={Boolean(problem) || !form.paidOn}>
            {discount ? 'Add discount' : 'Add payment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
