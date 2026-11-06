import { describe, expect, it } from 'vitest'
import { calculateInvoice } from './calc.ts'
import { nextRenewal } from './dates.ts'

const base = { baseCurrency: 'OMR', fxRate: 100_000_000, taxRate: 50_000 }

describe('calculateInvoice', () => {
  it('adds printed columns exactly in a 2-decimal currency', () => {
    const result = calculateInvoice({
      ...base,
      baseCurrency: 'USD',
      currency: 'USD',
      taxEnabled: true,
      lines: [
        { quantity: 10_000, unitPrice: 123_300 },
        { quantity: 10_000, unitPrice: 123_300 },
        { quantity: 10_000, unitPrice: 123_300 },
      ],
    })
    expect(result.lines[0].tax).toBe(6_200)
    expect(result.subtotal).toBe(369_900)
    expect(result.tax).toBe(18_600)
    expect(result.total).toBe(result.lines.reduce((sum, line) => sum + line.total, 0))
  })

  it('handles a 3-decimal currency', () => {
    const result = calculateInvoice({
      ...base,
      currency: 'OMR',
      taxEnabled: true,
      lines: [{ quantity: 15_000, unitPrice: 1_234_500 }],
    })
    expect(result.subtotal).toBe(1_851_750)
    expect(result.tax).toBe(92_590)
    expect(result.total).toBe(1_944_340)
  })

  it('has no tax when unchecked and converts to base', () => {
    const result = calculateInvoice({
      ...base,
      currency: 'USD',
      fxRate: 38_500_000,
      taxEnabled: false,
      lines: [{ quantity: 10_000, unitPrice: 1_000_000 }],
    })
    expect(result.tax).toBe(0)
    expect(result.baseSubtotal).toBe(385_000)
  })
})

describe('nextRenewal', () => {
  it('keeps the anchor day through short months', () => {
    expect(nextRenewal('2026-01-31', 'monthly', '2026-01-31')).toBe('2026-02-28')
    expect(nextRenewal('2026-02-28', 'monthly', '2026-01-31')).toBe('2026-03-31')
  })
  it('handles other cycles', () => {
    expect(nextRenewal('2026-11-15', 'quarterly')).toBe('2027-02-15')
    expect(nextRenewal('2024-02-29', 'yearly')).toBe('2025-02-28')
    expect(nextRenewal('2026-11-15', 'once')).toBeNull()
  })
})
