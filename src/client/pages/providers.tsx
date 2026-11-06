import { Plus } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Choice, Confirm, Empty, Field, Loading, PageHeader } from '@/components/common'
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
import { api, fileUrl, run, useApi } from '@/lib/api'
import type { Provider, Template } from '@/lib/types'

function ProviderDialog({ existing, children }: { existing?: Provider; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ name: '', website: '', details: '', defaultTemplateId: '' })
  const templates = useApi<Template[]>(open ? '/templates' : null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setForm({
        name: existing?.name ?? '',
        website: existing?.website ?? '',
        details: existing?.details ?? '',
        defaultTemplateId: existing?.defaultTemplateId ? String(existing.defaultTemplateId) : '',
      })
    }
  }, [open, existing])

  async function save() {
    const body = { ...form, defaultTemplateId: Number(form.defaultTemplateId) || null }
    const saved = await run(async () => {
      const row = existing
        ? await api.put<Provider>(`/providers/${existing.id}`, body)
        : await api.post<Provider>('/providers', body)
      const file = fileRef.current?.files?.[0]
      if (file) await api.upload(`/providers/${row.id}/logo`, file)
      return row
    }, 'Provider saved')
    if (saved) setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{existing ? 'Edit provider' : 'Add provider'}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label="Name">
            <Input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </Field>
          <Field label="Logo" hint="PNG or JPEG. Only shown inside this app.">
            <Input ref={fileRef} type="file" accept="image/png,image/jpeg" />
          </Field>
          <Field label="Website">
            <Input
              value={form.website}
              onChange={(event) => setForm({ ...form, website: event.target.value })}
            />
          </Field>
          <Field label="Details">
            <Textarea
              value={form.details}
              onChange={(event) => setForm({ ...form, details: event.target.value })}
            />
          </Field>
          <Field label="Template for this provider">
            <Choice
              value={form.defaultTemplateId}
              onChange={(value) => setForm({ ...form, defaultTemplateId: value })}
              allowNone="Use the default template"
              options={(templates.data ?? []).map((row) => ({ value: row.id, label: row.name }))}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button onClick={save}>Save provider</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ProvidersPage() {
  const { data } = useApi<Provider[]>('/providers')
  const templates = useApi<Template[]>('/templates')
  const templateName = (id: number | null) =>
    templates.data?.find((row) => row.id === id)?.name ?? 'Default template'
  return (
    <>
      <PageHeader
        title="Providers"
        description="Internal labels, so you know which invoice is which. They are not printed on customer invoices."
        actions={
          <ProviderDialog>
            <Button>
              <Plus className="size-4" /> Add provider
            </Button>
          </ProviderDialog>
        }
      />
      {!data ? (
        <Loading />
      ) : data.length === 0 ? (
        <Empty>No providers yet.</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Provider</TableHead>
              <TableHead>Website</TableHead>
              <TableHead>Template</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <div className="flex items-center gap-2 font-medium">
                    {row.logoFile && (
                      <img src={fileUrl(row.logoFile)} alt="" className="size-6 object-contain" />
                    )}
                    {row.name}
                  </div>
                </TableCell>
                <TableCell>{row.website}</TableCell>
                <TableCell>{templateName(row.defaultTemplateId)}</TableCell>
                <TableCell className="text-right">
                  <ProviderDialog existing={row}>
                    <Button size="sm" variant="ghost">
                      Edit
                    </Button>
                  </ProviderDialog>
                  <Confirm
                    title={`Archive ${row.name}?`}
                    description="It will be hidden from lists. Existing invoices keep their link to it."
                    action="Archive provider"
                    onConfirm={() =>
                      run(() => api.post(`/providers/${row.id}/archive`), 'Provider archived')
                    }
                  >
                    <Button size="sm" variant="ghost">
                      Archive
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
