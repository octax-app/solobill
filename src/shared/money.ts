/**
 * The only place money math happens.
 *
 * Amounts and quantities are integers scaled by 10,000.
 * Exchange rates are integers scaled by 100,000,000: base units per 1 unit of the invoice currency.
 * Percentages are integers scaled by 10,000, so 5% is 50,000.
 */
export const AMOUNT_SCALE = 10_000
export const FX_SCALE = 100_000_000
export const PERCENT_SCALE = 10_000

export const CURRENCIES: Record<string, { decimals: number; name: string }> = {
  AED: { decimals: 2, name: 'UAE dirham' },
  BHD: { decimals: 3, name: 'Bahraini dinar' },
  EGP: { decimals: 2, name: 'Egyptian pound' },
  EUR: { decimals: 2, name: 'Euro' },
  GBP: { decimals: 2, name: 'Pound sterling' },
  IQD: { decimals: 3, name: 'Iraqi dinar' },
  JOD: { decimals: 3, name: 'Jordanian dinar' },
  KWD: { decimals: 3, name: 'Kuwaiti dinar' },
  OMR: { decimals: 3, name: 'Omani rial' },
  QAR: { decimals: 2, name: 'Qatari riyal' },
  SAR: { decimals: 2, name: 'Saudi riyal' },
  USD: { decimals: 2, name: 'US dollar' },
}

export const CURRENCY_CODES = Object.keys(CURRENCIES)

export function currencyDecimals(currency: string): number {
  const entry = CURRENCIES[currency]
  if (!entry) throw new Error(`Unknown currency: ${currency}`)
  return entry.decimals
}

function divRound(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n
  const n = numerator < 0n ? -numerator : numerator
  const d = denominator < 0n ? -denominator : denominator
  const rounded = (2n * n + d) / (2n * d)
  return negative ? -rounded : rounded
}

function toSafe(value: bigint): number {
  const n = Number(value)
  if (!Number.isSafeInteger(n)) throw new RangeError('Amount is too large')
  return n
}

/** Rounds half away from zero to the currency's own decimal places. */
export function roundToCurrency(amount: number, currency: string): number {
  const step = 10n ** BigInt(4 - currencyDecimals(currency))
  return toSafe(divRound(BigInt(amount), step) * step)
}

export function lineNet(quantity: number, unitPrice: number, currency: string): number {
  const raw = divRound(BigInt(quantity) * BigInt(unitPrice), BigInt(AMOUNT_SCALE))
  return roundToCurrency(toSafe(raw), currency)
}

export function taxOf(net: number, percent: number, currency: string): number {
  const raw = divRound(BigInt(net) * BigInt(percent), BigInt(100 * PERCENT_SCALE))
  return roundToCurrency(toSafe(raw), currency)
}

/** The share of `part` that belongs to `subtotal` out of `total`, which keeps tax out of profit. */
export function netShare(part: number, subtotal: number, total: number, currency: string): number {
  if (total === 0) return 0
  const raw = divRound(BigInt(part) * BigInt(subtotal), BigInt(total))
  return roundToCurrency(toSafe(raw), currency)
}

/** Converts an amount to the base currency using a locked rate. */
export function toBase(amount: number, fxRate: number, baseCurrency: string): number {
  const raw = divRound(BigInt(amount) * BigInt(fxRate), BigInt(FX_SCALE))
  return roundToCurrency(toSafe(raw), baseCurrency)
}

function parseScaled(input: string, scaleDigits: number): number | null {
  const cleaned = input.trim().replace(/,/g, '')
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(cleaned)
  if (!match || (!match[2] && !match[3])) return null
  const fraction = match[3] ?? ''
  if (fraction.length > scaleDigits) return null
  const digits = `${match[2] || '0'}${fraction.padEnd(scaleDigits, '0')}`
  const value = BigInt(digits)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null
  return Number(match[1] === '-' ? -value : value)
}

/** Parses "1,234.567" to a scaled amount. Returns null if it is not a number. */
export const parseAmount = (input: string) => parseScaled(input, 4)
export const parseFxRate = (input: string) => parseScaled(input, 8)
export const parsePercent = (input: string) => parseScaled(input, 4)

function plainDecimal(value: number, scaleDigits: number, minFraction: number): string {
  const negative = value < 0
  const digits = String(Math.abs(value)).padStart(scaleDigits + 1, '0')
  const whole = digits.slice(0, -scaleDigits)
  let fraction = digits.slice(-scaleDigits)
  while (fraction.length > minFraction && fraction.endsWith('0')) fraction = fraction.slice(0, -1)
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

/** Value for an input field, with no thousands separators or currency code. */
export const amountInput = (value: number) => plainDecimal(value, 4, 0)
export const fxRateInput = (value: number) => plainDecimal(value, 8, 0)
export const percentText = (value: number) => plainDecimal(value, 4, 0)

function grouped(plain: string): string {
  const [whole, fraction] = plain.split('.')
  const digits = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return fraction ? `${digits}.${fraction}` : digits
}

/** "1,234.500", using the currency's decimal places. */
export function formatAmount(amount: number, currency: string): string {
  return grouped(plainDecimal(roundToCurrency(amount, currency), 4, currencyDecimals(currency)))
}

/**
 * A unit price is shown as entered, never rounded: 0.015 USD stays "0.015".
 * It can be finer than the currency, and only the line total rounds. Short values are
 * still padded to the currency's decimal places, so 15 USD is "15.00".
 */
export function formatUnitPrice(amount: number, currency: string): string {
  return grouped(plainDecimal(amount, 4, currencyDecimals(currency)))
}

export const formatMoney = (amount: number, currency: string) =>
  `${formatAmount(amount, currency)} ${currency}`
