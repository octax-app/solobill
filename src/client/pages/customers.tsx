import { Plus } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { Choice, Empty, Field, Loading, PageHeader, StatusBadge } from '@/components/common'
import { Button } from '@/components/ui/button'
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
import { Textarea } from '@/components/ui/textarea'
import { api, run, useApi } from '@/lib/api'
import type { Customer } from '@/lib/types'
import { CURRENCY_CODES } from '../../shared/money.ts'

const blank = {
  status: 'active' as Customer['status'],
  name: '',
  company: '',
  email: '',
  phone: '',
  address: '',
  taxNumber: '',
  currency: 'USD',
  notes: '',
}

export function CustomerDialog({
  existing,
  defaultStatus,
  onSaved,
  children,
}: {
  existing?: Customer
  defaultStatus?: Customer['status']
  onSaved?: (customer: Customer) => void
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const start = existing ?? { ...blank, status: defaultStatus ?? 'active' }
  const [form, setForm] = useState(start)
  const set = (patch: Partial<typeof blank>) => setForm((current) => ({ ...current, ...patch }))

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the dialog opens
  useEffect(() => {
    if (open) setForm(start)
  }, [open])

  async function save() {
    const { status, name, company, email, phone, address, taxNumber, currency, notes } = form
    const body = { status, name, company, email, phone, address, taxNumber, currency, notes }
    const saved = await run(
      () =>
        existing
          ? api.put<Customer>(`/customers/${existing.id}`, body)
          : api.post<Customer>('/customers', body),
      existing ? 'Customer saved' : 'Customer added',
    )
    if (saved) {
      setOpen(false)
      onSaved?.(saved)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{existing ? 'Edit customer' : 'Add customer'}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <Input value={form.name} onChange={(event) => set({ name: event.target.value })} />
          </Field>
          <Field label="Company">
            <Input
              value={form.company}
              onChange={(event) => set({ company: event.target.value })}
            />
          </Field>
          <Field label="Email">
            <Input
              type="email"
              value={form.email}
              onChange={(event) => set({ email: event.target.value })}
            />
          </Field>
          <Field label="Phone">
            <Input value={form.phone} onChange={(event) => set({ phone: event.target.value })} />
          </Field>
          <Field label="Tax number">
            <Input
              value={form.taxNumber}
              onChange={(event) => set({ taxNumber: event.target.value })}
            />
          </Field>
          <Field label="Currency">
            <Choice
              value={form.currency}
              onChange={(value) => set({ currency: value })}
              options={CURRENCY_CODES.map((code) => ({ value: code, label: code }))}
            />
          </Field>
          <Field label="Status">
            <Choice
              value={form.status}
              onChange={(value) => set({ status: value as Customer['status'] })}
              options={[
                { value: 'lead', label: 'Potential customer' },
                { value: 'active', label: 'Active' },
                { value: 'archived', label: 'Archived' },
              ]}
            />
          </Field>
          <Field label="Address" className="sm:col-span-2">
            <Textarea
              value={form.address}
              onChange={(event) => set({ address: event.target.value })}
            />
          </Field>
          <Field label="Notes" className="sm:col-span-2">
            <Textarea value={form.notes} onChange={(event) => set({ notes: event.target.value })} />
          </Field>
        </div>
        <DialogFooter>
          <Button onClick={save}>Save customer</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function CustomersPage() {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const params = new URLSearchParams()
  if (search) params.set('q', search)
  if (status) params.set('status', status)
  const { data } = useApi<Customer[]>(`/customers?${params}`)
  return (
    <>
      <PageHeader
        title="Customers"
        actions={
          <CustomerDialog>
            <Button>
              <Plus className="size-4" /> Add customer
            </Button>
          </CustomerDialog>
        }
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <Input
          className="max-w-xs"
          placeholder="Search name, company or email"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Choice
          className="w-48"
          value={status}
          onChange={setStatus}
          allowNone="All customers"
          options={[
            { value: 'lead', label: 'Potential customers' },
            { value: 'active', label: 'Active' },
            { value: 'archived', label: 'Archived' },
          ]}
        />
      </div>
      {!data ? (
        <Loading />
      ) : data.length === 0 ? (
        <Empty>No customers found.</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Company</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Currency</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <Link className="font-medium underline" to={`/customers/${row.id}`}>
                    {row.name}
                  </Link>
                </TableCell>
                <TableCell>{row.company}</TableCell>
                <TableCell>{row.email}</TableCell>
                <TableCell>{row.currency}</TableCell>
                <TableCell>
                  <StatusBadge status={row.status} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  )
}
