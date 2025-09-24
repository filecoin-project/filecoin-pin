import { describe, expect, it } from 'vitest'
import {
  applyRatio,
  calculateRate,
  calculateRatioAsNumber,
  calculateRatioSafe,
  divRound,
  ratio,
  ratioToFixed,
  ratioToNumber,
  STORAGE_SCALE_MAX,
  scaledToNumber,
  scaleNumberRatio,
  scaleRatio,
  scaleRatioForNumber,
} from '../../../../utils/numbers/safe-scaling.js'

describe('Safe scaling functions', () => {
  describe('scaleRatio', () => {
    it('scales a simple ratio correctly', () => {
      const { scaled, scale } = scaleRatio(3n, 2n)
      expect(scale).toBe(BigInt(STORAGE_SCALE_MAX))
      expect(scaled).toBe((3n * BigInt(STORAGE_SCALE_MAX)) / 2n)

      // Verify we can recover the original ratio
      const recoveredRatio = scaledToNumber(scaled, scale)
      expect(recoveredRatio).toBeCloseTo(1.5, 6)
    })

    it('handles zero numerator', () => {
      const { scaled, scale } = scaleRatio(0n, 2n)
      expect(scaled).toBe(0n)
      expect(scale).toBe(1n)

      const ratio = scaledToNumber(scaled, scale)
      expect(ratio).toBe(0)
    })

    it('throws error for negative numerator', () => {
      expect(() => scaleRatio(-1n, 2n)).toThrow('numerator must be >= 0')
    })

    it('handles very large numbers with adaptive scaling', () => {
      const largeNum = 1000000000000000n
      const largeDen = 1000000000000001n
      const { scaled, scale } = scaleRatio(largeNum, largeDen)

      // For very large numbers, scale will be reduced from STORAGE_SCALE_MAX
      expect(scale).toBeGreaterThan(0n)
      expect(scaled).toBe(divRound(largeNum * scale, largeDen))

      const ratio = scaledToNumber(scaled, scale)
      const expected = Number(largeNum) / Number(largeDen)
      expect(Math.abs(ratio - expected) / expected).toBeLessThan(1e-10)
    })

    it('throws error for zero denominator', () => {
      expect(() => scaleRatio(1n, 0n)).toThrow('denominator must be > 0')
    })

    it('throws error for negative denominator', () => {
      expect(() => scaleRatio(1n, -1n)).toThrow('denominator must be > 0')
    })

    it('handles denominator larger than numerator', () => {
      const { scaled, scale } = scaleRatio(1n, 3n)
      expect(scale).toBe(BigInt(STORAGE_SCALE_MAX))
      expect(scaled).toBe(divRound(BigInt(STORAGE_SCALE_MAX), 3n))

      const ratio = scaledToNumber(scaled, scale)
      expect(ratio).toBeCloseTo(1 / 3, 6)
    })

    it('prevents overflow in intermediate calculations', () => {
      const num = 9007199254740992n // Just under MAX_SAFE_INTEGER
      const den = 2n

      const { scaled, scale } = scaleRatio(num, den)

      // Verify we can safely convert back to a number
      const result = scaledToNumber(scaled, scale)
      expect(result).toBe(Number(num) / Number(den))
      expect(Number.isFinite(result)).toBe(true)
    })

    it('handles calculations that would overflow with direct Number arithmetic', () => {
      // This scenario would overflow if done with regular JavaScript numbers
      const largePrice = BigInt(Number.MAX_SAFE_INTEGER)
      const storageAmount = 2.1 // Use a value that will cause precision loss

      // Our safe scaling handles it correctly:
      const safeResult = calculateRate(largePrice, storageAmount)

      // Demonstrate the unsafe version loses precision
      const unsafeResult = BigInt(Number(largePrice) * storageAmount)
      expect(unsafeResult).not.toBe(safeResult) // Precision lost in Number conversion

      // The safe result should be more accurate
      expect(safeResult).toBeGreaterThan(unsafeResult)
    })

    it('demonstrates precision loss in naive Number arithmetic', () => {
      // Use a tiny ratio (~0.000234) constructed from very large bigints so
      // converting to Number loses precision in the unsafe path.
      const scale = 10000000000000019n // > 2^53, forces precision loss in Number
      const depositedAmount = 234n * scale // numerator
      const requiredDeposit = 1000000n * scale // denominator

      // Unsafe approach (converts to Number first):
      const unsafeRatio = Number(depositedAmount) / Number(requiredDeposit)
      const unsafePrecision = unsafeRatio * 1000000 // expect ~234, but not exactly

      // Safe approach (keeps precision via scaling first):
      const safeRatio = calculateRatioAsNumber(depositedAmount, requiredDeposit)
      const safePrecision = safeRatio * 1000000

      // Safe path yields the exact expected integer when scaled
      expect(safePrecision).toBe(234)
      // Unsafe path should differ due to precision loss
      expect(unsafePrecision).not.toBe(234)
    })
  })

  describe('scaleRatioForNumber', () => {
    it('optimizes scale for safe Number conversion', () => {
      const num = 9007199254740992n // Very large number
      const den = 2n

      const { scaled, scale } = scaleRatioForNumber(num, den)

      // Should always be convertible to Number
      expect(() => scaledToNumber(scaled, scale)).not.toThrow()

      const result = scaledToNumber(scaled, scale)
      expect(result).toBe(Number(num) / Number(den))
    })

    it('handles ratios that would overflow with max scaling', () => {
      const veryLargeNum = BigInt(Number.MAX_SAFE_INTEGER) / 2n
      const smallDen = 1n

      const { scaled, scale } = scaleRatioForNumber(veryLargeNum, smallDen)

      // Should not throw when converting
      const result = scaledToNumber(scaled, scale)
      expect(Number.isFinite(result)).toBe(true)
      expect(result).toBeCloseTo(Number(veryLargeNum), -5) // Allow some precision loss
    })
  })

  describe('scaledToNumber', () => {
    it('converts scaled bigint back to number correctly', () => {
      const scaled = 15000000n // 1.5 * STORAGE_SCALE_MAX
      const scale = BigInt(STORAGE_SCALE_MAX)
      const result = scaledToNumber(scaled, scale)
      expect(result).toBe(1.5)
    })

    it('handles zero scaled value', () => {
      const result = scaledToNumber(0n, BigInt(STORAGE_SCALE_MAX))
      expect(result).toBe(0)
    })

    it('handles integer result', () => {
      const scaled = BigInt(STORAGE_SCALE_MAX)
      const scale = BigInt(STORAGE_SCALE_MAX)
      const result = scaledToNumber(scaled, scale)
      expect(result).toBe(1)
    })

    it('throws error for zero scale', () => {
      expect(() => scaledToNumber(1n, 0n)).toThrow('scale must be > 0')
    })

    it('throws error for negative scale', () => {
      expect(() => scaledToNumber(1n, -1n)).toThrow('scale must be > 0')
    })

    it('throws error for negative scaled value', () => {
      expect(() => scaledToNumber(-1n, BigInt(STORAGE_SCALE_MAX))).toThrow('scaled must be >= 0')
    })

    it('demonstrates safe scaling vs direct calculation', () => {
      const num = 9007199254740992n // MAX_SAFE_INTEGER
      const den = 2n

      const { scaled, scale } = scaleRatio(num, den)
      const safeResult = scaledToNumber(scaled, scale)

      expect(safeResult).toBe(Number(num) / Number(den))
      expect(Number.isFinite(safeResult)).toBe(true)
    })

    it('shows precision preservation for smaller ratios', () => {
      const num = 1000000n
      const den = 3n

      const { scaled, scale } = scaleRatio(num, den)
      const result = scaledToNumber(scaled, scale)

      const expectedRatio = Number(num) / Number(den)
      const relativeError = Math.abs(result - expectedRatio) / expectedRatio

      expect(relativeError).toBeLessThan(1e-6) // Very good precision
      expect(Number.isFinite(result)).toBe(true)
    })
  })

  describe('divRound', () => {
    it('handles different rounding modes correctly', () => {
      expect(divRound(7n, 3n, 'floor')).toBe(2n)
      expect(divRound(7n, 3n, 'ceil')).toBe(3n)
      expect(divRound(7n, 3n, 'trunc')).toBe(2n)
      expect(divRound(7n, 3n, 'half-up')).toBe(2n)

      // Test tie-breaking
      expect(divRound(5n, 2n, 'half-up')).toBe(3n) // 2.5 -> 3
      expect(divRound(5n, 2n, 'half-down')).toBe(2n) // 2.5 -> 2
      expect(divRound(5n, 2n, 'half-even')).toBe(2n) // 2.5 -> 2 (even)
      expect(divRound(3n, 2n, 'half-even')).toBe(2n) // 1.5 -> 2 (even)
    })
  })

  describe('ratio (exact fractions)', () => {
    it('creates reduced fractions', () => {
      const frac = ratio(6n, 9n)
      expect(frac.p).toBe(2n)
      expect(frac.q).toBe(3n)
    })

    it('handles zero numerator', () => {
      const frac = ratio(0n, 5n)
      expect(frac.p).toBe(0n)
      expect(frac.q).toBe(1n)
    })
  })

  describe('ratioToNumber', () => {
    it('converts exact ratios to numbers safely', () => {
      const result = ratioToNumber(1n, 3n)
      expect(result).toBeCloseTo(1 / 3, 6)
    })

    it('handles large ratios', () => {
      const largeNum = BigInt(Number.MAX_SAFE_INTEGER) / 100n
      const result = ratioToNumber(largeNum, 1n)
      expect(Number.isFinite(result)).toBe(true)
    })
  })

  describe('ratioToFixed', () => {
    it('formats ratios as fixed-point strings', () => {
      expect(ratioToFixed(1n, 3n, 4)).toBe('0.3333')
      expect(ratioToFixed(22n, 7n, 6)).toBe('3.142857')
      expect(ratioToFixed(5n, 2n, 1)).toBe('2.5')
    })

    it('handles zero decimals', () => {
      expect(ratioToFixed(7n, 3n, 0)).toBe('2')
      expect(ratioToFixed(8n, 3n, 0)).toBe('3') // rounds up
    })
  })

  describe('High-level convenience functions', () => {
    describe('calculateRatioAsNumber', () => {
      it('safely calculates ratios as numbers', () => {
        const result = calculateRatioAsNumber(3n, 2n)
        expect(result).toBeCloseTo(1.5, 10)
      })

      it('throws for values too large to convert', () => {
        const hugeDenominator = 1n
        const hugeNumerator = BigInt(Number.MAX_SAFE_INTEGER) * 1000n

        expect(() => calculateRatioAsNumber(hugeNumerator, hugeDenominator)).toThrow(
          'too large for safe Number conversion'
        )
      })
    })

    describe('calculateRatioSafe', () => {
      it('returns null for values too large to convert safely', () => {
        const hugeDenominator = 1n
        const hugeNumerator = BigInt(Number.MAX_SAFE_INTEGER) * 1000n

        const result = calculateRatioSafe(hugeNumerator, hugeDenominator)
        expect(result).toBeNull()
      })

      it('returns valid numbers for safe conversions', () => {
        const result = calculateRatioSafe(3n, 2n)
        expect(result).toBeCloseTo(1.5, 10)
      })
    })

    describe('calculateRate', () => {
      it('safely multiplies bigint price by number storage', () => {
        const pricePerTiB = 1000000000000000n // Large price
        const storageAmount = 1.5

        const result = calculateRate(pricePerTiB, storageAmount)
        expect(result).toBe(1500000000000000n) // 1.5 * price
      })
    })

    describe('applyRatio', () => {
      it('applies bigint ratios to JS numbers', () => {
        const baseValue = 100
        const numerator = 3n
        const denominator = 2n

        const result = applyRatio(baseValue, numerator, denominator)
        expect(result).toBeCloseTo(150, 10) // 100 * 1.5
      })
    })
  })

  describe('Edge cases and robustness', () => {
    it('handles extremely tiny denominators that round to zero', () => {
      // Test the edge case where denominator is so small it rounds to 0n
      const numerator = 1.0
      const tinyDenominator = 1e-308 // Extremely tiny positive number

      // Should not throw due to zero denominator after rounding
      expect(() => scaleNumberRatio(numerator, tinyDenominator)).not.toThrow()

      const { scaled, scale } = scaleNumberRatio(numerator, tinyDenominator)
      expect(scale).toBeGreaterThan(0n)
      expect(scaled).toBeGreaterThan(0n)
    })

    it('handles very large scale factors correctly', () => {
      // Test with numbers that require maximum scaling
      const smallNum = 1n
      const largeDen = 1000000n

      const { scaled, scale } = scaleRatio(smallNum, largeDen)
      expect(scale).toBe(BigInt(STORAGE_SCALE_MAX))
      expect(scaled).toBe(BigInt(STORAGE_SCALE_MAX) / largeDen)

      const ratio = scaledToNumber(scaled, scale)
      expect(ratio).toBeCloseTo(Number(smallNum) / Number(largeDen), 10)
    })
  })

  describe('Real-world usage scenarios', () => {
    it('handles deposit ratio calculations correctly', () => {
      const testScenarios = [
        { deposited: 500n, required: 1000n, potential: 200, expectedActual: 100 },
        { deposited: 1500n, required: 1000n, potential: 100, expectedActual: 150 },
        { deposited: 750n, required: 500n, potential: 80, expectedActual: 120 },
      ]

      testScenarios.forEach(({ deposited, required, potential, expectedActual }) => {
        const actualGiB = applyRatio(potential, deposited, required)
        expect(actualGiB).toBeCloseTo(expectedActual, 10)
      })
    })

    it('maintains precision across multiple calculations', () => {
      const baseDeposit = 1000n
      const baseRequired = 1000n

      for (let multiplier = 1; multiplier <= 10; multiplier++) {
        const ratio = calculateRatioAsNumber(baseDeposit * BigInt(multiplier), baseRequired)
        expect(ratio).toBeCloseTo(multiplier, 10)

        const potentialGiB = 50
        const actualGiB = potentialGiB * ratio
        expect(actualGiB).toBeCloseTo(potentialGiB * multiplier, 10)
      }
    })

    it('demonstrates rounding mode effects', () => {
      // Test different rounding modes with a ratio that shows clear differences
      const num = 10n
      const den = 3n // 10/3 = 3.333...

      const floorRatio = calculateRatioAsNumber(num, den, 'floor') // Should truncate down
      const ceilRatio = calculateRatioAsNumber(num, den, 'ceil') // Should round up
      const halfUpRatio = calculateRatioAsNumber(num, den, 'half-up') // Should be between

      expect(floorRatio).toBeLessThan(ceilRatio)
      expect(halfUpRatio).toBeGreaterThanOrEqual(floorRatio)
      expect(halfUpRatio).toBeLessThanOrEqual(ceilRatio)
      // At integer scales, half-up will equal either floor or ceil depending on remainder
      expect(halfUpRatio === floorRatio || halfUpRatio === ceilRatio).toBe(true)

      // Verify the actual differences are meaningful
      expect(ceilRatio - floorRatio).toBeCloseTo(1 / STORAGE_SCALE_MAX, 10)
    })
  })
})
