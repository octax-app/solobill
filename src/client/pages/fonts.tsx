import { Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { Confirm, Empty, Field, Loading, PageHeader } from '@/components/common'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import type { Font } from '@/lib/types'

const ACCEPT = '.ttf,.otf,.woff'

function UploadForm() {
  const [name, setName] = useState('')
  const [hasFile, setHasFile] = useState(false)
  const [busy, setBusy] = useState(false)
  const regularRef = useRef<HTMLInputElement>(null)
  const boldRef = useRef<HTMLInputElement>(null)

  async function upload() {
    const regular = regularRef.current?.files?.[0]
    if (!regular) return
    const form = new FormData()
    form.append('name', name.trim())
    form.append('file', regular)
    const bold = boldRef.current?.files?.[0]
    if (bold) form.append('bold', bold)
    setBusy(true)
    const created = await run(() => api.post<Font>('/fonts', form), 'Font uploaded')
    setBusy(false)
    if (!created) return
    setName('')
    setHasFile(false)
    if (regularRef.current) regularRef.current.value = ''
    if (boldRef.current) boldRef.current.value = ''
  }

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="text-base">Upload a font</CardTitle>
      </CardHeader>
      <CardContent className="grid items-start gap-4 sm:grid-cols-3">
        <Field label="Name">
          <Input maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Regular file" hint="TTF, OTF or WOFF">
          <Input
            ref={regularRef}
            type="file"
            accept={ACCEPT}
            onChange={(event) => setHasFile(Boolean(event.target.files?.length))}
          />
        </Field>
        <Field label="Bold file" hint="Optional. Without it, bold text uses the regular file.">
          <Input ref={boldRef} type="file" accept={ACCEPT} />
        </Field>
        <div className="sm:col-span-3">
          <Button disabled={busy || !hasFile || !name.trim()} onClick={upload}>
            Upload font
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

export function FontsPage() {
  const { data, isLoading } = useApi<Font[]>('/fonts')

  return (
    <>
      <PageHeader
        title="Fonts"
        description="Upload fonts to use on your templates. IBM Plex Sans Arabic is always available."
      />
      <UploadForm />
      {isLoading ? (
        <Loading />
      ) : !data?.length ? (
        <Empty>No fonts uploaded yet</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Font</TableHead>
              <TableHead>Bold</TableHead>
              <TableHead>Arabic</TableHead>
              <TableHead>Used by</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((font) => (
              <TableRow key={font.id}>
                <TableCell className="font-medium">{font.name}</TableCell>
                <TableCell>{font.boldFile ? 'Yes' : 'No'}</TableCell>
                <TableCell className="whitespace-normal">
                  {font.coversArabic ? (
                    <Badge variant="secondary">Yes</Badge>
                  ) : (
                    <>
                      <Badge variant="outline">No</Badge>
                      <p className="text-muted-foreground mt-1 text-xs">
                        No Arabic. Arabic text prints in IBM Plex.
                      </p>
                    </>
                  )}
                </TableCell>
                <TableCell className="whitespace-normal">
                  {font.usedBy.length ? font.usedBy.join(', ') : 'Not used'}
                </TableCell>
                <TableCell>
                  {font.usedBy.length ? (
                    <Button
                      size="icon"
                      variant="ghost"
                      disabled
                      aria-label={`${font.name} is in use and cannot be deleted`}
                      title="In use, so it cannot be deleted"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  ) : (
                    <Confirm
                      title="Delete this font?"
                      description="Issued PDFs keep their embedded font. This cannot be undone."
                      action="Delete font"
                      destructive
                      onConfirm={() => run(() => api.del(`/fonts/${font.id}`), 'Font deleted')}
                    >
                      <Button size="icon" variant="ghost" aria-label={`Delete ${font.name}`}>
                        <Trash2 className="size-4" />
                      </Button>
                    </Confirm>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  )
}
