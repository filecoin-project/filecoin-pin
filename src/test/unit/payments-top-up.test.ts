import { describe, expect, it } from 'vitest'
import { clampDepositToLimit } from '../../core/payments/index.js'

describe('clampDepositToLimit', () => {
  it('passes the request through when no limit is set', () => {
    const result = clampDepositToLimit(100n, 50n, undefined)
    expect(result).toEqual({ deposit: 50n, reason: 'passthrough' })
  })

  it('returns 0 with already-at-limit when current balance meets the limit', () => {
    const result = clampDepositToLimit(100n, 25n, 100n)
    expect(result.deposit).toBe(0n)
    expect(result.reason).toBe('already-at-limit')
    expect(result.message).toContain('already equals or exceeds')
  })

  it('clamps the deposit to the largest amount that does not exceed the limit', () => {
    const result = clampDepositToLimit(80n, 50n, 100n)
    expect(result.deposit).toBe(20n)
    expect(result.reason).toBe('clamped')
    expect(result.message).toContain('Reducing')
  })
})
