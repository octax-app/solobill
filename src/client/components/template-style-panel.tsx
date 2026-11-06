import { Link } from 'react-router'
import { ColorField } from '@/components/color-field'
import { Choice, Field } from '@/components/common'
import { NumberInput } from '@/components/number-field'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { Font } from '@/lib/types'
import type { TemplateStyle } from '../../shared/render.ts'

export const fontOptions = (fonts: Font[]) =>
  fonts.map((font) => ({ value: font.id, label: font.name }))

export function TemplateStylePanel({
  style,
  fonts,
  onChange,
}: {
  style: TemplateStyle
  fonts: Font[]
  onChange: (patch: Partial<TemplateStyle>) => void
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Whole template</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid grid-cols-2 items-start gap-3">
          <ColorField
            label="Text color"
            value={style.textColor}
            onChange={(textColor) => onChange({ textColor })}
          />
          <Field label="Line height">
            <NumberInput
              min={1}
              max={3}
              step={0.05}
              value={style.lineHeight}
              onValue={(lineHeight) => onChange({ lineHeight })}
            />
          </Field>
        </div>
        <Field label="Font">
          <Choice
            value={style.fontId}
            allowNone="IBM Plex Sans Arabic (built in)"
            options={fontOptions(fonts)}
            onChange={(value) => onChange({ fontId: value ? Number(value) : null })}
          />
          {fonts.length === 0 && (
            <p className="text-muted-foreground text-xs">
              Upload your own on the{' '}
              <Link className="underline" to="/fonts">
                Fonts page
              </Link>
              .
            </p>
          )}
        </Field>
      </CardContent>
    </Card>
  )
}
