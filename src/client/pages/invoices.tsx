import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Choice, Empty, Loading, PageHeader, StatusBadge } from '@/components/common'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useApi } from '@/lib/api'
import type { InvoiceRow } from '@/lib/types'
import { formatMoney } from '../../shared/money.ts'
import { dueOf, paymentLabel } from '../../shared/payments.ts'

export function InvoicesPage({ type }: { type: 'invoice' | 'proforma' }) {
  const [params] = useSearchParams()
  const [status, setStatus] = useState(params.get('status') ?? '')
  const query = new URLSearchParams({ type })
  if (status) query.set('status', status)
  const { data } = useApi<InvoiceRow[]>(`/invoices?${query}`)
  const proforma = type === 'proforma'
  return (
    <>
      <PageHeader
        title={proforma ? 'Proformas' : 'Customer invoices'}
        description={
          proforma
            ? 'Quotes for potential customers. They never count toward profit or pending totals.'
            : undefined
        }
        actions={
          <Button asChild>
            <Link to={proforma ? '/proformas/new' : '/invoices/new'}>
              <Plus className="size-4" /> {proforma ? 'New proforma' : 'New invoice'}
            </Link>
          </Button>
        }
      />
      <div className="mb-4">
        <Choice
          className="w-44"
          value={status}
          onChange={setStatus}
          allowNone="All statuses"
          options={[
            { value: 'draft', label: 'Draft' },
            { value: 'issued', label: 'Issued' },
            ...(proforma
              ? [{ value: 'converted', label: 'Converted' }]
              : [{ value: 'paid', label: 'Paid' }]),
            { value: 'void', label: 'Void' },
          ]}
        />
      </div>
      {!data ? (
        <Loading />
      ) : data.length === 0 ? (
        <Empty>Nothing here yet.</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Number</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead>Issued</TableHead>
              <TableHead>{proforma ? 'Valid until' : 'Due date'}</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Total</TableHead>
              {!proforma && <TableHead className="text-right">Due</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <Link className="font-medium underline" to={`/invoices/${row.id}`}>
                    {row.number ?? 'Draft'}
                  </Link>
                </TableCell>
                <TableCell>{row.customerCompany || row.customerName}</TableCell>
                <TableCell>{row.providerName}</TableCell>
                <TableCell>{row.issuedOn}</TableCell>
                <TableCell>{proforma ? row.validUntil : row.dueOn}</TableCell>
                <TableCell>
                  <StatusBadge status={paymentLabel(row)} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatMoney(row.total, row.currency)}
                </TableCell>
                {!proforma && (
                  <TableCell className="text-right tabular-nums">
                    {row.status === 'issued' && formatMoney(dueOf(row), row.currency)}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  )
}
