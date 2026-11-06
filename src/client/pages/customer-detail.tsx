import { Plus } from 'lucide-react'
import { Link, useParams } from 'react-router'
import { Empty, Loading, PageHeader, StatusBadge } from '@/components/common'
import { CustomerPaymentDialog } from '@/components/customer-payment-dialog'
import { SubscriptionDialog } from '@/components/subscription-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useApi } from '@/lib/api'
import type { Customer, CustomerSummary, InvoiceRow, Subscription } from '@/lib/types'
import { formatMoney } from '../../shared/money.ts'
import { dueOf, paymentLabel } from '../../shared/payments.ts'
import { CustomerDialog } from './customers.tsx'
import { SubscriptionTable } from './subscriptions.tsx'

export function CustomerDetailPage() {
  const id = Number(useParams().id)
  const customer = useApi<Customer>(`/customers/${id}`)
  const summary = useApi<CustomerSummary>(`/customers/${id}/summary`)
  const subscriptions = useApi<Subscription[]>(`/subscriptions?customerId=${id}`)
  const invoices = useApi<InvoiceRow[]>(`/invoices?customerId=${id}`)

  if (!customer.data || !summary.data) return <Loading />
  const row = customer.data
  const base = summary.data.baseCurrency
  const numbers = summary.data.summary
  const stats = [
    { label: 'Total billed', value: numbers.revenue },
    { label: 'Original cost', value: numbers.cost },
    { label: 'Profit', value: numbers.profit },
    { label: 'Pending', value: summary.data.pending },
  ]

  return (
    <>
      <PageHeader
        title={row.name}
        description={row.company}
        actions={
          <>
            <StatusBadge status={row.status} />
            <CustomerDialog existing={row}>
              <Button variant="outline">Edit customer</Button>
            </CustomerDialog>
            <Button asChild>
              <Link to={`/invoices/new?customerId=${id}`}>New invoice</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to={`/proformas/new?customerId=${id}`}>New proforma</Link>
            </Button>
            <CustomerPaymentDialog customer={row}>
              <Button variant="outline">Add payment</Button>
            </CustomerPaymentDialog>
          </>
        }
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.label}>
            <CardHeader>
              <CardDescription>{stat.label}</CardDescription>
              <CardTitle className="text-2xl tabular-nums">
                {formatMoney(stat.value, base)}
              </CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>
      <div className="mb-6 grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            {row.email && <div>{row.email}</div>}
            {row.phone && <div>{row.phone}</div>}
            {row.address && <div className="whitespace-pre-line">{row.address}</div>}
            {row.taxNumber && <div>Tax number: {row.taxNumber}</div>}
            <div>Currency: {row.currency}</div>
            {row.notes && (
              <div className="text-muted-foreground whitespace-pre-line">{row.notes}</div>
            )}
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Subscriptions</CardTitle>
            <SubscriptionDialog customerId={id}>
              <Button size="sm" variant="outline">
                <Plus className="size-4" /> Add
              </Button>
            </SubscriptionDialog>
          </CardHeader>
          <CardContent>
            {subscriptions.data ? <SubscriptionTable rows={subscriptions.data} /> : <Loading />}
          </CardContent>
        </Card>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Invoices and proformas</CardTitle>
          </CardHeader>
          <CardContent>
            {!invoices.data?.length ? (
              <Empty>No invoices yet.</Empty>
            ) : (
              <Table>
                <TableBody>
                  {invoices.data.map((invoice) => (
                    <TableRow key={invoice.id}>
                      <TableCell>
                        <Link className="underline" to={`/invoices/${invoice.id}`}>
                          {invoice.number ?? 'Draft'}
                        </Link>
                        <div className="text-muted-foreground text-xs capitalize">
                          {invoice.type}
                        </div>
                      </TableCell>
                      <TableCell>{invoice.issuedOn ?? 'Not issued'}</TableCell>
                      <TableCell>
                        <StatusBadge status={paymentLabel(invoice)} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMoney(invoice.total, invoice.currency)}
                        {paymentLabel(invoice) === 'partial' && (
                          <div className="text-muted-foreground text-xs">
                            {formatMoney(dueOf(invoice), invoice.currency)} due
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Linked original invoices</CardTitle>
          </CardHeader>
          <CardContent>
            {summary.data.linkedOriginals.length === 0 ? (
              <Empty>No original invoices are linked to this customer.</Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Provider</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {summary.data.linkedOriginals.map((original) => (
                    <TableRow key={original.id}>
                      <TableCell>
                        <Link className="underline" to={`/originals/${original.id}`}>
                          {original.providerName} {original.number}
                        </Link>
                      </TableCell>
                      <TableCell>{original.issuedOn}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMoney(original.total, original.currency)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  )
}
