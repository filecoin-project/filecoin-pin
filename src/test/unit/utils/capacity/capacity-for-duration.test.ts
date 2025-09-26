import { ethers } from 'ethers'
import { describe, expect, it, vi } from 'vitest'
import { calculateCapacityForDuration } from '../../../../utils/capacity/capacity-for-duration.js'

vi.mock('@filoz/synapse-sdk', () => ({
  TIME_CONSTANTS: {
    EPOCHS_PER_DAY: 2880n,
  },
}))

describe('calculateCapacityForDuration', () => {
  const pricePerTiBPerEpoch = ethers.parseUnits('0.0000565', 18)

  describe('rate allowance mode', () => {
    const rateAllowance = ethers.parseUnits('0.1', 18) // 0.1 USDFC/epoch

    it('returns the same capacity regardless of duration', () => {
      const perEpoch = calculateCapacityForDuration(rateAllowance, pricePerTiBPerEpoch, 1, {
        allowanceType: 'rate',
      })
      const tenDays = calculateCapacityForDuration(rateAllowance, pricePerTiBPerEpoch, 10, {
        allowanceType: 'rate',
      })
      const halfEpoch = calculateCapacityForDuration(rateAllowance, pricePerTiBPerEpoch, 1 / 2880 / 2, {
        allowanceType: 'rate',
      })

      expect(perEpoch).toBeGreaterThan(0)
      expect(tenDays).toBeCloseTo(perEpoch, 10)
      expect(halfEpoch).toBeCloseTo(perEpoch, 10)
    })

    it('matches the manual per-epoch ratio calculation', () => {
      const capacity = calculateCapacityForDuration(rateAllowance, pricePerTiBPerEpoch, 5, {
        allowanceType: 'rate',
      })
      const allowanceNumber = Number(ethers.formatUnits(rateAllowance, 18))
      const priceNumber = Number(ethers.formatUnits(pricePerTiBPerEpoch, 18))
      const expected = allowanceNumber / priceNumber

      expect(capacity).toBeCloseTo(expected, 6)
    })
  })

  describe('lockup allowance mode', () => {
    const lockupAllowance = ethers.parseUnits('10', 18) // 10 USDFC total

    it('scales inversely with duration', () => {
      const oneDay = calculateCapacityForDuration(lockupAllowance, pricePerTiBPerEpoch, 1)
      const tenDays = calculateCapacityForDuration(lockupAllowance, pricePerTiBPerEpoch, 10)
      const ninetyDays = calculateCapacityForDuration(lockupAllowance, pricePerTiBPerEpoch, 90)

      expect(oneDay).toBeGreaterThan(tenDays)
      expect(tenDays).toBeGreaterThan(ninetyDays)
      expect(tenDays).toBeCloseTo(oneDay / 10, 6)
      expect(ninetyDays).toBeCloseTo(oneDay / 90, 6)
    })

    it('rounds sub-epoch durations up to a single epoch', () => {
      const lessThanEpoch = calculateCapacityForDuration(lockupAllowance, pricePerTiBPerEpoch, 1 / 2880 / 2)
      const singleEpoch = calculateCapacityForDuration(lockupAllowance, pricePerTiBPerEpoch, 1 / 2880)

      expect(lessThanEpoch).toBeCloseTo(singleEpoch, 10)
    })
  })

  describe('edge cases', () => {
    const allowance = ethers.parseUnits('1', 18)

    it('returns 0 when price is 0', () => {
      const capacity = calculateCapacityForDuration(allowance, 0n, 1)
      const rateCapacity = calculateCapacityForDuration(allowance, 0n, 1, { allowanceType: 'rate' })

      expect(capacity).toBe(0)
      expect(rateCapacity).toBe(0)
    })

    it('returns 0 when allowance is 0', () => {
      const capacity = calculateCapacityForDuration(0n, pricePerTiBPerEpoch, 1)
      const rateCapacity = calculateCapacityForDuration(0n, pricePerTiBPerEpoch, 1, { allowanceType: 'rate' })

      expect(capacity).toBe(0)
      expect(rateCapacity).toBe(0)
    })

    it('returns 0 when duration is non-positive', () => {
      const zeroDuration = calculateCapacityForDuration(allowance, pricePerTiBPerEpoch, 0)
      const negativeDuration = calculateCapacityForDuration(allowance, pricePerTiBPerEpoch, -5)
      const zeroDurationRate = calculateCapacityForDuration(allowance, pricePerTiBPerEpoch, 0, {
        allowanceType: 'rate',
      })

      expect(zeroDuration).toBe(0)
      expect(negativeDuration).toBe(0)
      expect(zeroDurationRate).toBe(0)
    })
  })
})
