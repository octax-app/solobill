import { describe, expect, it } from 'vitest'
import {
  amountInput,
  formatAmount,
  formatUnitPrice,
  lineNet,
  parseAmount,
  parseFxRate,
  percentText,
  roundToCurrency,
  taxOf,
  toBase,
} from './money.ts'

describe('money', () => {
  it('parses and rejects input', () => {
    expect(parseAmount('1,234.5')).toBe(12_345_000)
    expect(parseAmount('.5')).toBe(5_000)
    expect(parseAmount('-2')).toBe(-20_000)
    expect(parseAmount('abc')).toBeNull()
    expect(parseAmount('')).toBeNull()
    expect(parseAmount('1.23456')).toBeNull()
    expect(parseFxRate('0.38499')).toBe(38_499_000)
  })

  it('rounds by currency decimals', () => {
    expect(roundToCurrency(12_345, 'USD')).toBe(12_300)
    expect(roundToCurrency(12_350, 'USD')).toBe(12_400)
    expect(roundToCurrency(12_345, 'OMR')).toBe(12_350)
    expect(roundToCurrency(-12_350, 'USD')).toBe(-12_400)
  })

  it('formats with grouping', () => {
    expect(formatAmount(12_345_000, 'USD')).toBe('1,234.50')
    expect(formatAmount(12_345_000, 'OMR')).toBe('1,234.500')
    expect(formatAmount(-5_000_000, 'USD')).toBe('-500.00')
    expect(formatAmount(0, 'KWD')).toBe('0.000')
  })

  it('keeps the precision of a unit price', () => {
    expect(formatUnitPrice(150, 'USD')).toBe('0.015')
    expect(formatUnitPrice(155, 'OMR')).toBe('0.0155')
    expect(formatUnitPrice(150_000, 'USD')).toBe('15.00')
    expect(formatUnitPrice(12_345_000, 'OMR')).toBe('1,234.500')
    expect(formatUnitPrice(0, 'USD')).toBe('0.00')
  })

  it('calculates line and tax', () => {
    expect(lineNet(30_000, 33_333, 'USD')).toBe(100_000)
    expect(lineNet(15_000, 1_234_500, 'OMR')).toBe(1_851_750)
    expect(taxOf(1_000_000, 50_000, 'OMR')).toBe(50_000)
    expect(taxOf(123_450, 50_000, 'USD')).toBe(6_200)
    expect(taxOf(123_450, 50_000, 'OMR')).toBe(6_170)
  })

  it('converts large values without losing precision', () => {
    const big = 900_000_000_000_000
    expect(toBase(big, 100_000_000, 'USD')).toBe(big)
    expect(toBase(1_000_000, 38_500_000, 'OMR')).toBe(385_000)
    expect(() => toBase(Number.MAX_SAFE_INTEGER, 500_000_000, 'USD')).toThrow(RangeError)
  })

  it('round-trips input text', () => {
    expect(amountInput(12_345_000)).toBe('1234.5')
    expect(amountInput(10_000)).toBe('1')
    expect(amountInput(50)).toBe('0.005')
    expect(percentText(50_000)).toBe('5')
    expect(percentText(52_500)).toBe('5.25')
  })
})
