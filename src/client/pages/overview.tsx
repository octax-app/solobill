import { useState } from 'react'
import { Link } from 'react-router'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Choice, Empty, Loading, PageHeader, StatusBadge } from '@/components/common'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
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
import type { Overview } from '@/lib/types'
import { todayISO } from '../../shared/dates.ts'
import { formatAmount, formatMoney } from '../../shared/money.ts'

type Period = 'month' | 'quarter' | 'year' | 'custom'

function periodDates(period: Period, today: string) {
  const year = today.slice(0, 4)
  const month = Number(today.slice(5, 7))
  if (period === 'year') return { from: `${year}-01-01`, to: today }
  if (period === 'quarter') {
    const start = String(Math.floor((month - 1) / 3) * 3 + 1).padStart(2, '0')
    return { from: `${year}-${start}-01`, to: today }
  }
  return { from: `${today.slice(0, 7)}-01`, to: today }
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      {note && <CardContent className="text-muted-foreground text-xs">{note}</CardContent>}
    </Card>
  )
}

export function OverviewPage() {
  const today = todayISO()
  const [period, setPeriod] = useState<Period>('month')
  const [custom, setCustom] = useState(periodDates('month', today))
  const dates = period === 'custom' ? custom : periodDates(period, today)
  const { data } = useApi<Overview>(`/overview?from=${dates.from}&to=${dates.to}`)

  if (!data) return <Loading />
  const base = data.baseCurrency
  const money = (value: number) => formatMoney(value, base)
  const overdue = (dueOn: string | null) => Boolean(dueOn && dueOn < today)

  return (
    <>
      <PageHeader
        title="Overview"
        actions={
          <>
            <Choice
              className="w-40"
              value={period}
              onChange={(value) => setPeriod(value as Period)}
              options={[
                { value: 'month', label: 'This month' },
                { value: 'quarter', label: 'This quarter' },
                { value: 'year', label: 'This year' },
                { value: 'custom', label: 'Custom range' },
              ]}
            />
            {period === 'custom' && (
              <>
                <Input
                  type="date"
                  aria-label="From"
                  className="w-40"
                  value={custom.from}
                  onChange={(event) => setCustom({ ...custom, from: event.target.value })}
                />
                <Input
                  type="date"
                  aria-label="To"
                  className="w-40"
                  value={custom.to}
                  onChange={(event) => setCustom({ ...custom, to: event.target.value })}
                />
              </>
            )}
          </>
        }
      />

      {(data.draftsToReview > 0 || data.unallocatedCost > 0) && (
        <div className="mb-4 grid gap-2">
          {data.draftsToReview > 0 && (
            <Alert>
              <AlertDescription>
                <span>
                  {data.draftsToReview} renewal{' '}
                  {data.draftsToReview === 1 ? 'draft is' : 'drafts are'} waiting for review.{' '}
                  <Link className="underline" to="/invoices?status=draft">
                    Review drafts
                  </Link>
                </span>
              </AlertDescription>
            </Alert>
          )}
          {data.unallocatedCost > 0 && (
            <Alert>
              <AlertDescription>
                {money(data.unallocatedCost)} of provider invoices in this period is not linked to a
                customer line. It is not included in profit.
              </AlertDescription>
            </Alert>
          )}
        </div>
      )}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Revenue" value={money(data.summary.revenue)} note="Excludes tax" />
        <Stat label="Cost" value={money(data.summary.cost)} />
        <Stat label="Profit" value={money(data.summary.profit)} />
        <Stat label="Margin" value={`${data.summary.margin}%`} />
      </div>

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>To collect</CardTitle>
            <CardDescription>{money(data.toCollectTotal)} unpaid by customers</CardDescription>
          </CardHeader>
          <CardContent>
            {data.toCollect.length === 0 ? (
              <Empty>Customers have paid everything.</Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.toCollect.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>
                        <Link className="font-medium underline" to={`/invoices/${row.id}`}>
                          {row.number}
                        </Link>
                        <div className="text-muted-foreground text-xs">{row.customerName}</div>
                      </TableCell>
                      <TableCell>
                        {row.dueOn ?? 'None'}{' '}
                        {overdue(row.dueOn) && <StatusBadge status="overdue" />}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMoney(row.due, row.currency)}
                        {row.due !== row.total && (
                          <div className="text-muted-foreground text-xs">
                            of {formatMoney(row.total, row.currency)}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            run(() => api.post(`/invoices/${row.id}/paid`, {}), 'Marked as paid')
                          }
                        >
                          Mark as paid
                        </Button>
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
            <CardTitle>To pay</CardTitle>
            <CardDescription>{money(data.toPayTotal)} unpaid to providers</CardDescription>
          </CardHeader>
          <CardContent>
            {data.toPay.length === 0 ? (
              <Empty>You have paid all provider invoices.</Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.toPay.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>
                        <Link className="font-medium underline" to={`/originals/${row.id}`}>
                          {row.providerName}
                        </Link>
                        <div className="text-muted-foreground text-xs">
                          {row.number || 'No number'}
                        </div>
                      </TableCell>
                      <TableCell>
                        {row.dueOn ?? 'None'}{' '}
                        {overdue(row.dueOn) && <StatusBadge status="overdue" />}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMoney(row.total, row.currency)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            run(() => api.post(`/originals/${row.id}/paid`, {}), 'Marked as paid')
                          }
                        >
                          Mark as paid
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Renewals in the next 30 days</CardTitle>
          </CardHeader>
          <CardContent>
            {data.renewals.length === 0 ? (
              <Empty>Nothing renews in the next 30 days.</Empty>
            ) : (
              <Table>
                <TableBody>
                  {data.renewals.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>
                        <Link className="font-medium underline" to={`/customers/${row.customerId}`}>
                          {row.customerName}
                        </Link>
                        <div className="text-muted-foreground text-xs">
                          {row.serviceName}
                          {row.label ? `, ${row.label}` : ''}
                        </div>
                      </TableCell>
                      <TableCell>{row.nextRenewalOn}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMoney(row.priceAmount, row.priceCurrency)}
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
            <CardTitle>Profit by month</CardTitle>
            <CardDescription>Last 12 months, in {base}</CardDescription>
          </CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.trend}>
                <CartesianGrid vertical={false} stroke="var(--border)" />
                <XAxis
                  dataKey="month"
                  tickLine={false}
                  axisLine={false}
                  fontSize={12}
                  tickFormatter={(value: string) => value.slice(5)}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  fontSize={12}
                  width={60}
                  tickFormatter={(value: number) => formatAmount(value, base).split('.')[0]}
                />
                <Tooltip
                  cursor={{ fill: 'var(--muted)' }}
                  formatter={(value) => [money(Number(value)), 'Profit']}
                />
                <Bar dataKey="profit" fill="var(--primary)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>
    </>
  )
}
