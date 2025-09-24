import { ethers } from 'ethers'
import { describe, expect, it, vi } from 'vitest'
import { calculateCapacityForDuration } from '../../../../utils/capacity/capacity-for-duration.js'

// Mock the Synapse SDK
vi.mock('@filoz/synapse-sdk', () => ({
  TIME_CONSTANTS: {
    EPOCHS_PER_DAY: 2880n,
  },
}))

describe('calculateCapacityForDuration', () => {
  const pricePerTiBPerEpoch = ethers.parseUnits('0.0000565', 18) // Example pricing

  describe('capacity per epoch calculation', () => {
    it('should calculate capacity for 1 epoch correctly', () => {
      const rateAllowance = ethers.parseUnits('1000', 18) // 1000 USDFC
      const duration = 1 / 2880 // 1 epoch in days

      const capacity = calculateCapacityForDuration(rateAllowance, pricePerTiBPerEpoch, duration)

      // Expected: 1000 USDFC / 0.0000565 USDFC per TiB per epoch = ~17,699,115 TiB
      // But this is for 1 epoch, so it should be very large
      expect(capacity).toBeGreaterThan(0)
      expect(capacity).toBeCloseTo(17699115, 0)
    })

    it('should handle very small durations (less than 1 epoch)', () => {
      const rateAllowance = ethers.parseUnits('1000', 18)
      const duration = 1 / 2880 / 2 // Half an epoch

      const capacity = calculateCapacityForDuration(rateAllowance, pricePerTiBPerEpoch, duration)

      // Should use minimum 1 epoch calculation
      expect(capacity).toBeGreaterThan(0)
      expect(capacity).toBeCloseTo(17699115, 0)
    })
  })

  describe('capacity for specific durations', () => {
    it('should calculate capacity for 1 day correctly', () => {
      const rateAllowance = ethers.parseUnits('1000', 18)
      const duration = 1 // 1 day

      const capacity = calculateCapacityForDuration(rateAllowance, pricePerTiBPerEpoch, duration)

      // Expected: 1000 USDFC / (0.0000565 * 2880) = 1000 / 0.16272 = ~6,145.5 TiB
      expect(capacity).toBeCloseTo(6145.5, 1)
    })

    it('should calculate capacity for 10 days correctly', () => {
      const rateAllowance = ethers.parseUnits('1000', 18)
      const duration = 10 // 10 days

      const capacity = calculateCapacityForDuration(rateAllowance, pricePerTiBPerEpoch, duration)

      // Expected: 1000 USDFC / (0.0000565 * 2880 * 10) = 1000 / 1.6272 = ~614.55 TiB
      expect(capacity).toBeCloseTo(614.55, 1)
    })

    it('should calculate capacity for 30 days correctly', () => {
      const rateAllowance = ethers.parseUnits('1000', 18)
      const duration = 30 // 30 days

      const capacity = calculateCapacityForDuration(rateAllowance, pricePerTiBPerEpoch, duration)

      // Expected: 1000 USDFC / (0.0000565 * 2880 * 30) = 1000 / 4.8816 = ~204.85 TiB
      expect(capacity).toBeCloseTo(204.85, 1)
    })

    it('should calculate capacity for 90 days correctly', () => {
      const rateAllowance = ethers.parseUnits('1000', 18)
      const duration = 90 // 90 days

      const capacity = calculateCapacityForDuration(rateAllowance, pricePerTiBPerEpoch, duration)

      // Expected: 1000 USDFC / (0.0000565 * 2880 * 90) = 1000 / 14.6448 = ~68.28 TiB
      expect(capacity).toBeCloseTo(68.28, 1)
    })
  })

  describe('proportional relationships', () => {
    it('should show decreasing capacity as duration increases', () => {
      const rateAllowance = ethers.parseUnits('1000', 18)

      const capacity1Day = calculateCapacityForDuration(rateAllowance, pricePerTiBPerEpoch, 1)
      const capacity10Days = calculateCapacityForDuration(rateAllowance, pricePerTiBPerEpoch, 10)
      const capacity30Days = calculateCapacityForDuration(rateAllowance, pricePerTiBPerEpoch, 30)
      const capacity90Days = calculateCapacityForDuration(rateAllowance, pricePerTiBPerEpoch, 90)

      // Capacity should decrease as duration increases
      expect(capacity1Day).toBeGreaterThan(capacity10Days)
      expect(capacity10Days).toBeGreaterThan(capacity30Days)
      expect(capacity30Days).toBeGreaterThan(capacity90Days)

      // 10 days should be roughly 1/10th of 1 day
      expect(capacity10Days).toBeCloseTo(capacity1Day / 10, 1)

      // 30 days should be roughly 1/30th of 1 day
      expect(capacity30Days).toBeCloseTo(capacity1Day / 30, 1)

      // 90 days should be roughly 1/90th of 1 day
      expect(capacity90Days).toBeCloseTo(capacity1Day / 90, 1)
    })

    it('should maintain proportional relationship between capacity per epoch and capacity per day', () => {
      const rateAllowance = ethers.parseUnits('1000', 18)

      const capacityPerEpoch = calculateCapacityForDuration(rateAllowance, pricePerTiBPerEpoch, 1 / 2880)
      const capacityPerDay = calculateCapacityForDuration(rateAllowance, pricePerTiBPerEpoch, 1)

      // Capacity per day should be roughly 1/2880th of capacity per epoch
      // because you're paying for 2880 epochs instead of 1 epoch
      expect(capacityPerDay).toBeCloseTo(capacityPerEpoch / 2880, 1)
    })
  })

  describe('edge cases', () => {
    it('should handle zero price gracefully', () => {
      const rateAllowance = ethers.parseUnits('1000', 18)
      const duration = 1

      const capacity = calculateCapacityForDuration(rateAllowance, 0n, duration)

      expect(capacity).toBe(0)
    })

    it('should handle zero rate allowance', () => {
      const rateAllowance = 0n
      const duration = 1

      const capacity = calculateCapacityForDuration(rateAllowance, pricePerTiBPerEpoch, duration)

      expect(capacity).toBe(0)
    })

    it('should handle fractional days with precision', () => {
      const rateAllowance = ethers.parseUnits('1000', 18)
      const duration = 0.5 // Half a day

      const capacity = calculateCapacityForDuration(rateAllowance, pricePerTiBPerEpoch, duration)

      // Should be roughly double the capacity of 1 day
      const capacity1Day = calculateCapacityForDuration(rateAllowance, pricePerTiBPerEpoch, 1)
      expect(capacity).toBeCloseTo(capacity1Day * 2, 1)
    })
  })
})
