import { lineNet, taxOf, toBase } from './money.ts'

export interface CalcLineInput {
  quantity: number
  unitPrice: number
}

export interface CalcInput<L extends CalcLineInput> {
  currency: string
  baseCurrency: string
  fxRate: number
  taxEnabled: boolean
  taxRate: number
  lines: L[]
}

/**
 * Tax is calculated per line and totals are the sum of the lines,
 * so printed columns always add up.
 */
export function calculateInvoice<L extends CalcLineInput>(input: CalcInput<L>) {
  const { currency, baseCurrency, fxRate, taxEnabled, taxRate } = input
  const lines = input.lines.map((line) => {
    const net = lineNet(line.quantity, line.unitPrice, currency)
    const tax = taxEnabled ? taxOf(net, taxRate, currency) : 0
    return { ...line, net, tax, total: net + tax }
  })
  const subtotal = lines.reduce((sum, line) => sum + line.net, 0)
  const tax = lines.reduce((sum, line) => sum + line.tax, 0)
  const total = subtotal + tax
  return {
    lines,
    subtotal,
    tax,
    total,
    baseSubtotal: toBase(subtotal, fxRate, baseCurrency),
    baseTotal: toBase(total, fxRate, baseCurrency),
  }
}
