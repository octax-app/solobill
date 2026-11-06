import { describe, expect, it } from 'vitest'
import {
  allocatePayment,
  discountedTotals,
  dueOf,
  overpaidOf,
  paymentLabel,
  revenueAdjustment,
} from './payments.ts'

const invoice = { total: 1_050_000, subtotal: 1_000_000, currency: 'USD', fxRate: 100_000_000 }

describe('balances', () => {
  it('never shows a negative due', () => {
    const paid = { total: 100, paidAmount: 130, discountAmount: 0 }
    expect(dueOf(paid)).toBe(0)
    expect(overpaidOf(paid)).toBe(30)
  })

  it('labels a started invoice as partial only while issued', () => {
    const base = { total: 100, paidAmount: 40, discountAmount: 0 }
    expect(paymentLabel({ ...base, status: 'issued' })).toBe('partial')
    expect(paymentLabel({ ...base, status: 'void' })).toBe('void')
    expect(paymentLabel({ ...base, paidAmount: 0, status: 'issued' })).toBe('issued')
  })
})

describe('revenue adjustment', () => {
  it('takes only the net share of a discount off', () => {
    const adjust = revenueAdjustment({ ...invoice, paidAmount: 0, discountAmount: 105_000 }, 'USD')
    expect(adjust).toBe(-100_000)
  })

  it('adds the whole overpayment', () => {
    const adjust = revenueAdjustment(
      { ...invoice, paidAmount: 1_080_000, discountAmount: 0 },
      'USD',
    )
    expect(adjust).toBe(30_000)
  })

  it('converts at the invoice rate', () => {
    const omr = {
      total: 100_000,
      subtotal: 100_000,
      currency: 'OMR',
      fxRate: 260_000_000,
      paidAmount: 110_000,
      discountAmount: 0,
    }
    expect(revenueAdjustment(omr, 'USD')).toBe(26_000)
  })

  it('is zero on a zero total invoice', () => {
    const empty = { ...invoice, total: 0, subtotal: 0, paidAmount: 0, discountAmount: 0 }
    expect(revenueAdjustment(empty, 'USD')).toBe(0)
  })
})

describe('allocatePayment', () => {
  const open = [
    { id: 3, issuedOn: '2026-03-01', due: 300 },
    { id: 1, issuedOn: '2026-01-01', due: 100 },
    { id: 2, issuedOn: '2026-01-01', due: 200 },
  ]

  it('fills the oldest first, by date then id', () => {
    expect(allocatePayment(250, open)).toEqual({
      allocations: [
        { invoiceId: 1, amount: 100 },
        { invoiceId: 2, amount: 150 },
      ],
      excess: 0,
    })
  })

  it('stops exactly at a settled invoice', () => {
    expect(allocatePayment(100, open).allocations).toEqual([{ invoiceId: 1, amount: 100 }])
  })

  it('leaves the excess on the last invoice', () => {
    const split = allocatePayment(650, open)
    expect(split.excess).toBe(50)
    expect(split.allocations.at(-1)).toEqual({ invoiceId: 3, amount: 350 })
  })

  it('has nothing to fill with no open invoices', () => {
    expect(allocatePayment(100, [])).toEqual({ allocations: [], excess: 0 })
  })
})

describe('discounted totals', () => {
  const invoice = { subtotal: 1_000_000, tax: 50_000, total: 1_050_000, currency: 'USD' }

  it('takes the discount off before tax', () => {
    expect(discountedTotals({ ...invoice, discountAmount: 105_000 })).toEqual({
      discount: 100_000,
      tax: 45_000,
      total: 945_000,
    })
  })

  it('leaves the figures alone with no discount', () => {
    expect(discountedTotals({ ...invoice, discountAmount: 0 })).toEqual({
      discount: 0,
      tax: 50_000,
      total: 1_050_000,
    })
  })

  it('always adds up, with no tax lost to rounding', () => {
    const uneven = { subtotal: 333_300, tax: 16_700, total: 350_000, currency: 'OMR' }
    const { discount, tax, total } = discountedTotals({ ...uneven, discountAmount: 123_400 })
    expect(uneven.subtotal - discount + tax).toBe(total)
  })
})
