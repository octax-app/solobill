import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { Confirm, Empty, Loading, PageHeader, StatusBadge } from '@/components/common'
import { SubscriptionDialog } from '@/components/subscription-dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { api, run, useApi } from '@/lib/api'
import type { Subscription } from '@/lib/types'
import { CYCLE_LABELS } from '../../shared/dates.ts'
import { formatMoney } from '../../shared/money.ts'

export function SubscriptionTable({
  rows,
  showCustomer,
}: {
  rows: Subscription[]
  showCustomer?: boolean
}) {
  const [showCancelled, setShowCancelled] = useState(false)
  if (rows.length === 0) return <Empty>No subscriptions yet.</Empty>
  const cancelled = rows.filter((row) => row.status === 'cancelled').length
  const visible = showCancelled ? rows : rows.filter((row) => row.status !== 'cancelled')
  return (
    <>
      {cancelled > 0 && (
        <Label className="mb-3 flex items-center gap-2 text-sm">
          <Checkbox
            checked={showCancelled}
            onCheckedChange={(checked) => setShowCancelled(checked === true)}
          />
          Show cancelled ({cancelled})
        </Label>
      )}
      {visible.length === 0 ? (
        <Empty>No active subscriptions.</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              {showCustomer && <TableHead>Customer</TableHead>}
              <TableHead>Service</TableHead>
              <TableHead>Cycle</TableHead>
              <TableHead>Next renewal</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((row) => (
              <TableRow key={row.id}>
                {showCustomer && (
                  <TableCell>
                    <Link className="underline" to={`/customers/${row.customerId}`}>
                      {row.customerName}
                    </Link>
                  </TableCell>
                )}
                <TableCell>
                  {row.serviceName}
                  <div className="text-muted-foreground text-xs">
                    {[
                      row.providerName,
                      row.label,
                      row.lines.length > 1 ? `${row.lines.length} lines` : '',
                    ]
                      .filter(Boolean)
                      .join(', ')}
                  </div>
                </TableCell>
                <TableCell>{CYCLE_LABELS[row.cycle]}</TableCell>
                <TableCell>{row.nextRenewalOn ?? 'None'}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatMoney(row.costAmount, row.costCurrency)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatMoney(row.priceAmount, row.priceCurrency)}
                </TableCell>
                <TableCell>
                  <StatusBadge status={row.status} />
                </TableCell>
                <TableCell className="text-right">
                  <SubscriptionDialog existing={row}>
                    <Button size="sm" variant="ghost">
                      Edit
                    </Button>
                  </SubscriptionDialog>
                  <Confirm
                    title="Delete this subscription?"
                    description="Renewal drafts that were never issued are deleted with it. A subscription with issued invoices cannot be deleted, so cancel it instead."
                    action="Delete subscription"
                    destructive
                    onConfirm={() =>
                      run(() => api.del(`/subscriptions/${row.id}`), 'Subscription deleted')
                    }
                  >
                    <Button size="sm" variant="ghost">
                      Delete
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

export function SubscriptionsPage() {
  const { data } = useApi<Subscription[]>('/subscriptions')
  return (
    <>
      <PageHeader
        title="Subscriptions"
        description="Which customer has which service, and when it renews."
        actions={
          <SubscriptionDialog>
            <Button>
              <Plus className="size-4" /> Add subscription
            </Button>
          </SubscriptionDialog>
        }
      />
      {data ? <SubscriptionTable rows={data} showCustomer /> : <Loading />}
    </>
  )
}
