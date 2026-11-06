import { useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Confirm, Field, Loading, PageHeader } from '@/components/common'
import { MappingEditor } from '@/components/mapping-editor'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { api, fileUrl, run, useApi } from '@/lib/api'
import type { Template } from '@/lib/types'
import { parsePercent, percentText } from '../../shared/money.ts'

function DetailsForm({ template }: { template: Template }) {
  const [form, setForm] = useState({
    name: template.name,
    companyName: template.companyName,
    companyAddress: template.companyAddress,
    taxNumber: template.taxNumber,
    bankDetails: template.bankDetails,
    taxRate: percentText(template.defaultTaxRate),
  })
  const logoRef = useRef<HTMLInputElement>(null)
  const set = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }))

  function save() {
    const { taxRate, ...details } = form
    return run(async () => {
      await api.put(`/templates/${template.id}`, {
        ...details,
        defaultTaxRate: parsePercent(taxRate) ?? 50_000,
      })
      const logo = logoRef.current?.files?.[0]
      if (logo) await api.upload(`/templates/${template.id}/logo`, logo)
    }, 'Template saved').then(() => undefined)
  }

  return (
    <Card>
      <CardContent className="grid gap-4 pt-6 sm:grid-cols-2">
        <Field label="Template name" className="sm:col-span-2">
          <Input value={form.name} onChange={(event) => set({ name: event.target.value })} />
        </Field>
        <Field label="Company name" hint="Only needed when Your company is in the layout">
          <Input
            value={form.companyName}
            onChange={(event) => set({ companyName: event.target.value })}
          />
        </Field>
        <Field label="Tax number" hint="Only needed when Tax details is in the layout">
          <Input
            value={form.taxNumber}
            onChange={(event) => set({ taxNumber: event.target.value })}
          />
        </Field>
        <Field label="Company address" className="sm:col-span-2">
          <Textarea
            value={form.companyAddress}
            onChange={(event) => set({ companyAddress: event.target.value })}
          />
        </Field>
        <Field label="Bank details" className="sm:col-span-2">
          <Textarea
            value={form.bankDetails}
            onChange={(event) => set({ bankDetails: event.target.value })}
          />
        </Field>
        <Field label="Default tax rate (%)">
          <Input
            inputMode="decimal"
            value={form.taxRate}
            onChange={(event) => set({ taxRate: event.target.value })}
          />
        </Field>
        <Field label="Company logo" hint="PNG or JPEG">
          <div className="flex items-center gap-2">
            {template.companyLogoFile && (
              <img src={fileUrl(template.companyLogoFile)} alt="" className="h-9 object-contain" />
            )}
            <Input ref={logoRef} type="file" accept="image/png,image/jpeg" />
          </div>
        </Field>
        <div className="sm:col-span-2">
          <Button onClick={save}>Save template</Button>
        </div>
      </CardContent>
    </Card>
  )
}

export function TemplateDetailPage() {
  const id = Number(useParams().id)
  const { data } = useApi<Template>(`/templates/${id}`)
  const navigate = useNavigate()
  if (!data) return <Loading />
  const usedBy = [...(data.usage?.providers ?? []), ...(data.usage?.services ?? [])]

  return (
    <>
      <PageHeader
        title={data.name}
        description={
          usedBy.length ? `Used by ${usedBy.map((row) => row.name).join(', ')}` : undefined
        }
        actions={
          <>
            {!data.isDefault && (
              <Button
                variant="outline"
                onClick={() =>
                  run(() => api.post(`/templates/${id}/default`), 'Default template set')
                }
              >
                Make default
              </Button>
            )}
            {data.kind === 'uploaded' && (
              <Confirm
                title="Delete this template?"
                description="This cannot be undone."
                action="Delete template"
                destructive
                onConfirm={async () => {
                  const done = await run(() => api.del(`/templates/${id}`), 'Template deleted')
                  if (done) navigate('/templates')
                }}
              >
                <Button variant="outline">Delete</Button>
              </Confirm>
            )}
          </>
        }
      />
      {data.problems.length > 0 && (
        <Alert className="mb-4">
          <AlertDescription>{data.problems.join('. ')}.</AlertDescription>
        </Alert>
      )}
      <Tabs defaultValue="details">
        <TabsList>
          <TabsTrigger value="details">Company details</TabsTrigger>
          <TabsTrigger value="layout">Layout</TabsTrigger>
        </TabsList>
        <TabsContent value="details">
          <DetailsForm key={data.id} template={data} />
        </TabsContent>
        <TabsContent value="layout">
          <MappingEditor key={data.id} template={data} />
        </TabsContent>
      </Tabs>
    </>
  )
}
