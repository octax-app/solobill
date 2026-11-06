import { Plus, Trash2 } from 'lucide-react'
import { Choice } from '@/components/common'
import { NumberInput } from '@/components/number-field'
import {
  customFieldNote,
  MAX_CUSTOM_FIELDS,
  newCustomField,
  sortFields,
} from '@/components/template-layout'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  CUSTOM_FIELD_REGIONS,
  CUSTOM_FIELD_TYPES,
  type CustomField,
  type CustomFieldType,
  REGION_LABELS,
  type RegionKey,
} from '../../shared/render.ts'

const TYPE_NAMES: Record<CustomFieldType, string> = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
}

export function CustomFieldsPanel({
  fields,
  mapped,
  onChange,
}: {
  fields: CustomField[]
  mapped: ReadonlySet<RegionKey>
  onChange: (fields: CustomField[]) => void
}) {
  const patch = (id: string, change: Partial<CustomField>) =>
    onChange(fields.map((field) => (field.id === id ? { ...field, ...change } : field)))

  return (
    <Card className="xl:col-span-2">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Custom items</CardTitle>
        <Button
          size="sm"
          variant="outline"
          disabled={fields.length >= MAX_CUSTOM_FIELDS}
          onClick={() => onChange([...fields, newCustomField(fields)])}
        >
          <Plus className="size-4" /> Add item
        </Button>
      </CardHeader>
      <CardContent>
        {fields.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Add items such as a customer ID. Their values are entered on each invoice.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Label</TableHead>
                <TableHead className="w-28">Type</TableHead>
                <TableHead className="w-48">Block</TableHead>
                <TableHead className="w-20">Required</TableHead>
                <TableHead className="w-20">Order</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {fields.map((field) => {
                const note = customFieldNote(field, mapped)
                return (
                  <TableRow key={field.id}>
                    <TableCell className="min-w-44 align-top whitespace-normal">
                      <Input
                        aria-label="Item label"
                        aria-invalid={!field.label.trim()}
                        maxLength={60}
                        value={field.label}
                        onChange={(event) => patch(field.id, { label: event.target.value })}
                      />
                      {note && <p className="text-muted-foreground mt-1 text-xs">{note}</p>}
                    </TableCell>
                    <TableCell className="align-top">
                      <Choice
                        value={field.type}
                        onChange={(value) =>
                          patch(field.id, { type: value as CustomField['type'] })
                        }
                        options={CUSTOM_FIELD_TYPES.map((type) => ({
                          value: type,
                          label: TYPE_NAMES[type],
                        }))}
                      />
                    </TableCell>
                    <TableCell className="align-top">
                      <Choice
                        value={field.region}
                        onChange={(value) =>
                          patch(field.id, { region: value as CustomField['region'] })
                        }
                        options={CUSTOM_FIELD_REGIONS.map((region) => ({
                          value: region,
                          label: REGION_LABELS[region],
                        }))}
                      />
                    </TableCell>
                    <TableCell className="align-top">
                      <div className="flex h-9 items-center">
                        <Checkbox
                          aria-label="Required"
                          checked={field.required}
                          onCheckedChange={(value) => patch(field.id, { required: value === true })}
                        />
                      </div>
                    </TableCell>
                    <TableCell className="align-top">
                      {/* Rows re-sort on blur, because moving a row while typing loses focus. */}
                      <NumberInput
                        aria-label="Item order"
                        min={0}
                        max={999}
                        value={field.order}
                        onValue={(order) => patch(field.id, { order })}
                        onBlur={() => onChange(sortFields(fields))}
                      />
                    </TableCell>
                    <TableCell className="align-top">
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Delete ${field.label || 'item'}`}
                        onClick={() => onChange(fields.filter((row) => row.id !== field.id))}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
