import { TIME_CONSTANTS } from '@filoz/synapse-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveAccountStatus, formatFundedUntil } from '../../payments/status.js'

const EPOCHS_14_DAYS = TIME_CONSTANTS.EPOCHS_PER_DAY * 14n

describe('deriveAccountStatus', () => {
  it('returns DEFICIT when runway is 0', () => {
    expect(deriveAccountStatus(0n, 0n)).toBe('DEFICIT')
  })

  it('returns DEFICIT when debt is positive', () => {
    expect(deriveAccountStatus(0n, 1n)).toBe('DEFICIT')
  })

  it('returns WARNING at exactly 14 days runway', () => {
    expect(deriveAccountStatus(EPOCHS_14_DAYS, 0n)).toBe('WARNING')
  })

  it('returns WARNING below 14 days runway', () => {
    expect(deriveAccountStatus(EPOCHS_14_DAYS - 1n, 0n)).toBe('WARNING')
  })

  it('returns HEALTHY above 14 days runway', () => {
    expect(deriveAccountStatus(EPOCHS_14_DAYS + 1n, 0n)).toBe('HEALTHY')
  })

  it('returns HEALTHY for very long runway', () => {
    expect(deriveAccountStatus(TIME_CONSTANTS.EPOCHS_PER_DAY * 365n, 0n)).toBe('HEALTHY')
  })
})

describe('formatFundedUntil', () => {
  it('returns no-spend message when lockup rate is 0', () => {
    expect(formatFundedUntil(9999n, 0n)).toBe('No active storage spend')
  })

  it('returns termination warning when runway is 0', () => {
    expect(formatFundedUntil(0n, 1n)).toBe('Providers may terminate service at any time')
  })

  it('returns indefinitely message for sentinel runway values', () => {
    expect(formatFundedUntil(BigInt(Number.MAX_SAFE_INTEGER), 1n)).toBe('Funded indefinitely')
  })

  describe('normal runway', () => {
    const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z').getTime()

    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(FIXED_NOW)
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('formats 30-day runway with correct day count', () => {
      const runway = TIME_CONSTANTS.EPOCHS_PER_DAY * 30n
      const result = formatFundedUntil(runway, 1n)
      expect(result).toMatch(/^Funded until .+ {2}\(30 days\)$/)
    })

    it('formats 1-day runway with correct day count', () => {
      const runway = TIME_CONSTANTS.EPOCHS_PER_DAY * 1n
      const result = formatFundedUntil(runway, 1n)
      expect(result).toMatch(/^Funded until .+ {2}\(1 days\)$/)
    })

    it('truncates partial days in day count', () => {
      // 1.5 days worth of epochs → shows "1 days"
      const runway = (TIME_CONSTANTS.EPOCHS_PER_DAY * 3n) / 2n
      const result = formatFundedUntil(runway, 1n)
      expect(result).toContain('(1 days)')
    })
  })
})
