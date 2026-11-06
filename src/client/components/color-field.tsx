import { useState } from 'react'
import { Field } from '@/components/common'
import { isHexColor } from '@/components/template-layout'
import { Input } from '@/components/ui/input'

/** A typed value only reaches `onChange` once it is a whole #RRGGBB, so bad colors stay local. */
export function ColorField({
  label,
  value,
  onChange,
  swatch,
  placeholder,
}: {
  label: string
  value: string | null
  onChange: (value: string) => void
  /** The color the picker shows when the field is empty. */
  swatch?: string
  placeholder?: string
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? value ?? ''
  const invalid = draft !== null

  function type(text: string) {
    const next = text.trim()
    if (isHexColor(next) || (next === '' && swatch !== undefined)) {
      setDraft(null)
      onChange(next)
    } else {
      setDraft(text)
    }
  }

  return (
    <Field label={label}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} picker`}
          className="h-9 w-10 shrink-0 cursor-pointer rounded border bg-transparent p-0.5"
          value={value ?? swatch ?? '#000000'}
          onChange={(event) => {
            setDraft(null)
            onChange(event.target.value)
          }}
        />
        <Input
          aria-label={label}
          aria-invalid={invalid}
          placeholder={placeholder ?? '#RRGGBB'}
          value={shown}
          onChange={(event) => type(event.target.value)}
        />
      </div>
      {invalid && <p className="text-destructive text-xs">Enter a color as #RRGGBB</p>}
    </Field>
  )
}
