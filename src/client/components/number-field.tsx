import { type ComponentProps, useState } from 'react'
import { Input } from '@/components/ui/input'

type NumberInputProps = Omit<ComponentProps<typeof Input>, 'value' | 'onChange' | 'type'> & {
  value: number | null | undefined
  min?: number
  max?: number
  onValue: (value: number) => void
  /** Called when the field is cleared. Without it a cleared field is NaN, which fails the check. */
  onEmpty?: () => void
}

/**
 * Keeps what is being typed, so `1.` or an emptied box does not jump to another number.
 * The layout check refuses anything out of range before it is sent.
 */
export function NumberInput({
  value,
  min,
  max,
  onValue,
  onEmpty,
  onBlur,
  ...props
}: NumberInputProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const bad =
    value !== null &&
    value !== undefined &&
    (!Number.isFinite(value) ||
      (min !== undefined && value < min) ||
      (max !== undefined && value > max))
  const stored = value === null || value === undefined || Number.isNaN(value) ? '' : String(value)

  return (
    <Input
      {...props}
      type="number"
      min={min}
      max={max}
      aria-invalid={bad}
      value={draft ?? stored}
      onChange={(event) => {
        const text = event.target.value
        setDraft(text)
        if (text.trim() === '' && onEmpty) onEmpty()
        else onValue(text.trim() === '' ? Number.NaN : Number(text))
      }}
      onBlur={(event) => {
        setDraft(null)
        onBlur?.(event)
      }}
    />
  )
}
