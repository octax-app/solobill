import { Plus, Trash2 } from 'lucide-react'
import { ColorField } from '@/components/color-field'
import { Choice, Field } from '@/components/common'
import { NumberInput } from '@/components/number-field'
import { fontOptions } from '@/components/template-style-panel'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { Font } from '@/lib/types'
import {
  BORDER_MODES,
  type BorderMode,
  COLUMN_KEYS,
  type ColumnKey,
  DEFAULT_BORDER_COLOR,
  DEFAULT_COLUMNS,
  REGION_LABELS,
  type Region,
  type TableColumn,
  type TemplateStyle,
} from '../../shared/render.ts'

const COLUMN_NAMES: Record<ColumnKey, string> = {
  description: 'Description',
  quantity: 'Quantity',
  unit_price: 'Unit price',
  tax_rate: 'Tax rate',
  tax_amount: 'Tax amount',
  total: 'Total',
}

const BORDER_NAMES: Record<BorderMode, string> = {
  none: 'None',
  horizontal: 'Horizontal',
  vertical: 'Vertical',
  both: 'Both',
}

function ColumnList({
  columns,
  onChange,
}: {
  columns: TableColumn[]
  onChange: (columns: TableColumn[]) => void
}) {
  const patch = (index: number, change: Partial<TableColumn>) =>
    onChange(columns.map((row, position) => (position === index ? { ...row, ...change } : row)))

  return (
    <div className="grid gap-2">
      {columns.map((column, index) => (
        <div key={column.key} className="grid gap-1 rounded border p-2">
          <div className="flex items-center justify-between text-xs font-medium">
            {COLUMN_NAMES[column.key]}
            <Button
              size="icon"
              variant="ghost"
              className="size-6"
              aria-label={`Remove ${COLUMN_NAMES[column.key]}`}
              onClick={() => onChange(columns.filter((_, row) => row !== index))}
            >
              <Trash2 className="size-3" />
            </Button>
          </div>
          <div className="grid grid-cols-[1fr_64px] gap-2">
            <Input
              aria-label="Column label"
              value={column.label}
              onChange={(event) => patch(index, { label: event.target.value })}
            />
            <NumberInput
              aria-label="Column width"
              min={10}
              max={2000}
              value={column.width}
              onValue={(width) => patch(index, { width })}
            />
          </div>
        </div>
      ))}
      {COLUMN_KEYS.filter((key) => !columns.some((column) => column.key === key)).map((key) => (
        <Button
          key={key}
          size="sm"
          variant="outline"
          onClick={() => {
            const preset = DEFAULT_COLUMNS.find((column) => column.key === key)
            if (preset) onChange([...columns, preset])
          }}
        >
          <Plus className="size-3" /> {COLUMN_NAMES[key]}
        </Button>
      ))}
    </div>
  )
}

export function RegionPanel({
  region,
  style,
  fonts,
  onChange,
}: {
  region: Region
  style: TemplateStyle
  fonts: Font[]
  onChange: (patch: Partial<Region>) => void
}) {
  const table = region.key === 'line_table'

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{REGION_LABELS[region.key]}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Font size">
            <NumberInput
              min={6}
              max={48}
              value={region.fontSize}
              onValue={(fontSize) => onChange({ fontSize })}
            />
          </Field>
          <Field label="Alignment">
            <Choice
              value={region.align}
              onChange={(value) => onChange({ align: value as Region['align'] })}
              options={[
                { value: 'left', label: 'Left' },
                { value: 'center', label: 'Center' },
                { value: 'right', label: 'Right' },
              ]}
            />
          </Field>
        </div>
        {region.key !== 'logo' && (
          <>
            <div className="grid grid-cols-2 items-start gap-3">
              <ColorField
                label="Color"
                value={region.color ?? null}
                swatch={style.textColor}
                placeholder="Inherit"
                onChange={(color) => onChange({ color: color || null })}
              />
              <Field label="Line height">
                <NumberInput
                  min={1}
                  max={3}
                  step={0.05}
                  placeholder="Inherit"
                  value={region.lineHeight}
                  onValue={(lineHeight) => onChange({ lineHeight })}
                  onEmpty={() => onChange({ lineHeight: null })}
                />
              </Field>
            </div>
            <Field label="Font">
              <Choice
                value={region.fontId}
                allowNone="Inherit"
                options={fontOptions(fonts)}
                onChange={(value) => onChange({ fontId: value ? Number(value) : null })}
              />
            </Field>
          </>
        )}
        {table && (
          <>
            <div className="grid grid-cols-2 items-end gap-3">
              <Field label="Row height">
                <NumberInput
                  min={10}
                  max={120}
                  value={region.rowHeight ?? 20}
                  onValue={(rowHeight) => onChange({ rowHeight })}
                />
              </Field>
              <Label className="flex h-9 items-center gap-2">
                <Checkbox
                  checked={region.showHeader !== false}
                  onCheckedChange={(value) => onChange({ showHeader: value === true })}
                />
                Print headers
              </Label>
            </div>
            <div className="grid grid-cols-2 items-start gap-3">
              <Field label="Borders">
                <Choice
                  value={region.borders ?? 'none'}
                  onChange={(value) => onChange({ borders: value as BorderMode })}
                  options={BORDER_MODES.map((mode) => ({
                    value: mode,
                    label: BORDER_NAMES[mode],
                  }))}
                />
              </Field>
              <ColorField
                label="Border color"
                value={region.borderColor ?? null}
                swatch={DEFAULT_BORDER_COLOR}
                placeholder={DEFAULT_BORDER_COLOR}
                onChange={(borderColor) => onChange({ borderColor: borderColor || null })}
              />
            </div>
            <ColumnList
              columns={region.columns ?? []}
              onChange={(columns) => onChange({ columns })}
            />
          </>
        )}
      </CardContent>
    </Card>
  )
}
