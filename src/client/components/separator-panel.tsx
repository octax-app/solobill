import { Trash2 } from 'lucide-react'
import { ColorField } from '@/components/color-field'
import { Choice, Field } from '@/components/common'
import { NumberInput } from '@/components/number-field'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { Separator } from '../../shared/render.ts'

export function SeparatorPanel({
  separator,
  onChange,
  onDelete,
}: {
  separator: Separator
  onChange: (patch: Partial<Separator>) => void
  onDelete: () => void
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Line</CardTitle>
        <Button size="icon" variant="ghost" aria-label="Delete line" onClick={onDelete}>
          <Trash2 className="size-4" />
        </Button>
      </CardHeader>
      <CardContent className="grid gap-3">
        <Field label="Orientation">
          <Choice
            value={separator.orientation}
            onChange={(value) => onChange({ orientation: value as Separator['orientation'] })}
            options={[
              { value: 'horizontal', label: 'Horizontal' },
              { value: 'vertical', label: 'Vertical' },
            ]}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Length">
            <NumberInput
              min={10}
              max={2000}
              value={separator.length}
              onValue={(length) => onChange({ length })}
            />
          </Field>
          <Field label="Thickness">
            <NumberInput
              min={0.25}
              max={6}
              step={0.25}
              value={separator.thickness}
              onValue={(thickness) => onChange({ thickness })}
            />
          </Field>
        </div>
        <ColorField
          label="Color"
          value={separator.color}
          onChange={(color) => onChange({ color })}
        />
      </CardContent>
    </Card>
  )
}
