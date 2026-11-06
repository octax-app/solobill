import { Upload } from 'lucide-react'
import { useRef } from 'react'
import { Link, useNavigate } from 'react-router'
import { Loading, PageHeader } from '@/components/common'
import { Badge } from '@/components/ui/badge'
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
import type { Template } from '@/lib/types'

export function TemplatesPage() {
  const { data } = useApi<Template[]>('/templates')
  const fileRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()

  async function upload(file: File | undefined) {
    if (!file) return
    const created = await run(() => api.upload<Template>('/templates', file), 'Template uploaded')
    if (created) navigate(`/templates/${created.id}`)
  }

  return (
    <>
      <PageHeader
        title="Templates"
        description="Your company layouts. Upload a PDF, then mark where each piece of data goes."
        actions={
          <>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf"
              hidden
              onChange={(event) => upload(event.target.files?.[0])}
            />
            <Button onClick={() => fileRef.current?.click()}>
              <Upload className="size-4" /> Upload PDF template
            </Button>
          </>
        }
      />
      {!data ? (
        <Loading />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Template</TableHead>
              <TableHead>Company</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <Link className="font-medium underline" to={`/templates/${row.id}`}>
                    {row.name}
                  </Link>{' '}
                  {row.isDefault && <Badge variant="secondary">Default</Badge>}
                </TableCell>
                <TableCell>{row.companyName || 'Not entered'}</TableCell>
                <TableCell>
                  {row.ready ? <Badge>Ready</Badge> : <Badge variant="outline">Needs setup</Badge>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  )
}
