import { Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: ReactNode
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-muted-foreground mt-1 text-sm">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Field({
  label,
  children,
  hint,
  className,
}: {
  label: string
  children: ReactNode
  hint?: string
  className?: string
}) {
  return (
    <div className={`grid gap-1.5 ${className ?? ''}`}>
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  )
}

const NONE = '__none__'

export function Choice({
  value,
  onChange,
  options,
  placeholder,
  allowNone,
  disabled,
  className,
}: {
  value: string | number | null | undefined
  onChange: (value: string) => void
  options: { value: string | number; label: string }[]
  placeholder?: string
  allowNone?: string
  disabled?: boolean
  className?: string
}) {
  const current = value === null || value === undefined || value === '' ? undefined : String(value)
  return (
    <Select
      value={current ?? (allowNone ? NONE : undefined)}
      onValueChange={(next) => onChange(next === NONE ? '' : next)}
      disabled={disabled}
    >
      <SelectTrigger className={className ?? 'w-full'}>
        <SelectValue placeholder={placeholder ?? 'Choose'} />
      </SelectTrigger>
      <SelectContent>
        {allowNone && <SelectItem value={NONE}>{allowNone}</SelectItem>}
        {options.map((option) => (
          <SelectItem key={option.value} value={String(option.value)}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function Confirm({
  title,
  description,
  action,
  onConfirm,
  children,
  destructive,
}: {
  title: string
  description: string
  action: string
  onConfirm: () => void
  children: ReactNode
  destructive?: boolean
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{children}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className={
              destructive ? 'bg-destructive hover:bg-destructive/90 text-white' : undefined
            }
          >
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function Loading() {
  return (
    <div className="text-muted-foreground flex items-center gap-2 py-10 text-sm">
      <Loader2 className="size-4 animate-spin" /> Loading
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="text-muted-foreground py-10 text-center text-sm">{children}</div>
}

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  draft: 'outline',
  issued: 'secondary',
  partial: 'secondary',
  paid: 'default',
  void: 'destructive',
  converted: 'outline',
  overdue: 'destructive',
  unpaid: 'secondary',
  active: 'default',
  lead: 'secondary',
  archived: 'outline',
  paused: 'secondary',
  cancelled: 'outline',
}

const STATUS_LABEL: Record<string, string> = { partial: 'Partially paid' }

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant={STATUS_VARIANT[status] ?? 'outline'}
      className={STATUS_LABEL[status] ? undefined : 'capitalize'}
    >
      {STATUS_LABEL[status] ?? status}
    </Badge>
  )
}
