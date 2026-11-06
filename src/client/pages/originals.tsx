import { Plus } from 'lucide-react'
import { Link } from 'react-router'
import { Empty, Loading, PageHeader, StatusBadge } from '@/components/common'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { api, run, useApi } from '@/lib/api'
import type { Original } from '@/lib/types'
import { todayISO } from '../../shared/dates.ts'
import { formatMoney } from '../../shared/money.ts'

export function OriginalsPage() {
  const { data } = useApi<Original[]>('/originals')
  const today = todayISO()
  return (
    <>
      <PageHeader
        title="Original invoices"
        description="What providers charge you. For your reference only, never shown to customers."
        actions={
          <Button asChild>
            <Link to="/originals/new">
              <Plus className="size-4" /> Add original invoice
            </Link>
          </Button>
        }
      />
      {!data ? (
        <Loading />
      ) : data.length === 0 ? (
        <Empty>No original invoices yet.</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Provider</TableHead>
              <TableHead>Number</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Due</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((row) => {
              const overdue = !row.paidOn && row.dueOn && row.dueOn < today
              return (
                <TableRow key={row.id}>
                  <TableCell>
                    <Link className="font-medium underline" to={`/originals/${row.id}`}>
                      {row.providerName}
                    </Link>
                  </TableCell>
                  <TableCell>{row.number}</TableCell>
                  <TableCell>{row.issuedOn}</TableCell>
                  <TableCell>{row.dueOn}</TableCell>
                  <TableCell>
                    <StatusBadge status={row.paidOn ? 'paid' : overdue ? 'overdue' : 'unpaid'} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(row.total, row.currency)}
                  </TableCell>
                  <TableCell className="text-right">
                    {!row.paidOn && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          run(() => api.post(`/originals/${row.id}/paid`, {}), 'Marked as paid')
                        }
                      >
                        Mark as paid
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
    </>
  )
}
