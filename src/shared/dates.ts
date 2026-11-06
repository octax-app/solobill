export type Cycle = 'monthly' | 'quarterly' | 'yearly' | 'once'

export const CYCLE_LABELS: Record<Cycle, string> = {
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  yearly: 'Yearly',
  once: 'One time',
}

export const todayISO = (now = new Date()) => now.toISOString().slice(0, 10)

export function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function addMonths(iso: string, months: number, anchorDay: number): string {
  const [year, month] = iso.split('-').map(Number)
  const target = new Date(Date.UTC(year, month - 1 + months, 1))
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate()
  target.setUTCDate(Math.min(anchorDay, lastDay))
  return target.toISOString().slice(0, 10)
}

/**
 * The next renewal after `iso`. `anchorIso` keeps the original day of the month,
 * so a 31 January start goes to 28 February and then back to 31 March.
 */
export function nextRenewal(iso: string, cycle: Cycle, anchorIso = iso): string | null {
  const anchorDay = Number(anchorIso.slice(8, 10))
  if (cycle === 'monthly') return addMonths(iso, 1, anchorDay)
  if (cycle === 'quarterly') return addMonths(iso, 3, anchorDay)
  if (cycle === 'yearly') return addMonths(iso, 12, anchorDay)
  return null
}

/**
 * The periods to bill from `first` up to and including `through`, and the date after them.
 * A one-time cycle has one period and no next date.
 */
export function billingPeriods(first: string, cycle: Cycle, through: string, anchorIso = first) {
  const periods: string[] = []
  let next: string | null = first
  while (next && next <= through) {
    periods.push(next)
    next = nextRenewal(next, cycle, anchorIso)
  }
  return { periods, next }
}

/** The first renewal after `today`, counted in cycles from `from`. */
export function renewalAfter(from: string, cycle: Cycle, today: string, anchorIso = from) {
  let next = nextRenewal(from, cycle, anchorIso)
  while (next && next <= today) next = nextRenewal(next, cycle, anchorIso)
  return next
}
