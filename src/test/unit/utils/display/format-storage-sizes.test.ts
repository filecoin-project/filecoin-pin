// import { SIZE_CONSTANTS } from '@filoz/synapse-sdk'
import { describe, expect, it } from 'vitest'
import { makeStorageUnit } from '../../../../utils/capacity/units.js'
import { formatStorageCapacity, formatStorageSize } from '../../../../utils/display/format-storage-sizes.js'

describe('formatStorageCapacity', () => {
  describe('TiB formatting (>= 1024 GiB)', () => {
    it('should format large TiB values with default precision', () => {
      expect(formatStorageCapacity(makeStorageUnit(1, 'TiB'))).toBe('1.0 TiB/month')
      expect(formatStorageCapacity(makeStorageUnit(2, 'TiB'))).toBe('2.0 TiB/month')
      expect(formatStorageCapacity(makeStorageUnit(5, 'TiB'))).toBe('5.0 TiB/month')
    })

    it('should format large TiB values with custom precision', () => {
      expect(formatStorageCapacity(makeStorageUnit(1, 'TiB'), 2)).toBe('1.00 TiB/month')
      expect(formatStorageCapacity(makeStorageUnit(1.5, 'TiB'), 2)).toBe('1.50 TiB/month')
      expect(formatStorageCapacity(makeStorageUnit(2, 'TiB'), 0)).toBe('2 TiB/month')
    })

    it('should format very large TiB values (>= 100 TiB) with rounded numbers', () => {
      expect(formatStorageCapacity(makeStorageUnit(100, 'TiB'))).toBe('100.0 TiB/month')
      expect(formatStorageCapacity(makeStorageUnit(1000, 'TiB'))).toBe('1,000.0 TiB/month')
      expect(formatStorageCapacity(makeStorageUnit(10000, 'TiB'))).toBe('10,000.0 TiB/month')
    })

    it('should handle edge case at 100 TiB boundary', () => {
      expect(formatStorageCapacity(makeStorageUnit(99.99999999999999, 'TiB'))).toBe('100.0 TiB/month') // Just under 100 TiB (99.999... rounds to 100.0)
      expect(formatStorageCapacity(makeStorageUnit(100, 'TiB'))).toBe('100.0 TiB/month') // Exactly 100 TiB
    })
  })

  describe('GiB formatting (0.9 - 1023.9 GiB)', () => {
    it('should format GiB values with default precision', () => {
      expect(formatStorageCapacity(makeStorageUnit(0.9, 'GiB'))).toBe('0.9 GiB/month')
      expect(formatStorageCapacity(makeStorageUnit(1, 'GiB'))).toBe('1.0 GiB/month')
      expect(formatStorageCapacity(makeStorageUnit(10, 'GiB'))).toBe('10.0 GiB/month')
      expect(formatStorageCapacity(makeStorageUnit(100, 'GiB'))).toBe('100.0 GiB/month') // >= 100 GiB uses rounded format
      expect(formatStorageCapacity(makeStorageUnit(500, 'GiB'))).toBe('500.0 GiB/month') // >= 100 GiB uses rounded format
      expect(formatStorageCapacity(makeStorageUnit(1023.9, 'GiB'))).toBe('1,023.9 GiB/month')
    })

    it('should format GiB values with custom precision', () => {
      expect(formatStorageCapacity(makeStorageUnit(100.375, 'GiB'), 0)).toBe('100 GiB/month')
      expect(formatStorageCapacity(makeStorageUnit(100.375, 'GiB'), 1)).toBe('100.4 GiB/month')
      expect(formatStorageCapacity(makeStorageUnit(100.375, 'GiB'), 2)).toBe('100.38 GiB/month')
      expect(formatStorageCapacity(makeStorageUnit(100.375, 'GiB'), 3)).toBe('100.375 GiB/month')
    })

    it('should format large GiB values (>= 100 GiB) with rounded numbers', () => {
      expect(formatStorageCapacity(makeStorageUnit(100, 'GiB'))).toBe('100.0 GiB/month')
      expect(formatStorageCapacity(makeStorageUnit(1000, 'GiB'))).toBe(`1,000.0 GiB/month`)
      expect(formatStorageCapacity(makeStorageUnit(10000, 'GiB'))).toBe(`10,000.0 GiB/month`)
    })

    it('should handle edge case at 100 GiB boundary', () => {
      expect(formatStorageCapacity(makeStorageUnit(99.9, 'GiB'))).toBe('99.9 GiB/month') // Just under 100 GiB
      expect(formatStorageCapacity(makeStorageUnit(100, 'GiB'))).toBe('100.0 GiB/month') // Exactly 100 GiB
    })
  })

  describe('MiB formatting (< 0.9 GiB)', () => {
    it('should format small values in MiB with default precision', () => {
      expect(formatStorageCapacity(makeStorageUnit(0.1, 'MiB'))).toBe('0.1 MiB/month') // >= 10 MiB uses rounded format
      expect(formatStorageCapacity(makeStorageUnit(0.5, 'MiB'))).toBe('0.5 MiB/month') // >= 10 MiB uses rounded format
      expect(formatStorageCapacity(makeStorageUnit(0.8, 'MiB'))).toBe('0.8 MiB/month') // >= 10 MiB uses rounded format
    })

    it('should format small values in MiB with custom precision', () => {
      expect(formatStorageCapacity(makeStorageUnit(102.4, 'MiB'), 2)).toBe('102.40 MiB/month') // Custom precision overrides rounding
      expect(formatStorageCapacity(makeStorageUnit(512, 'MiB'), 0)).toBe('512 MiB/month')
    })

    it('should format very small values (< 10 MiB) with precision', () => {
      expect(formatStorageCapacity(makeStorageUnit(1, 'MiB'))).toBe('1.0 MiB/month')
      expect(formatStorageCapacity(makeStorageUnit(5.1, 'MiB'))).toBe('5.1 MiB/month')
      expect(formatStorageCapacity(makeStorageUnit(9.2, 'MiB'))).toBe('9.2 MiB/month')
    })

    it('should format larger MiB values (>= 10 MiB) with rounded numbers', () => {
      expect(formatStorageCapacity(makeStorageUnit(10, 'MiB'), 0)).toBe('10 MiB/month')
      expect(formatStorageCapacity(makeStorageUnit(102, 'MiB'), 0)).toBe('102 MiB/month')
      expect(formatStorageCapacity(makeStorageUnit(512, 'MiB'), 0)).toBe('512 MiB/month')
    })

    it('should handle edge case at 10 MiB boundary', () => {
      expect(formatStorageCapacity(makeStorageUnit(9.2, 'MiB'))).toBe('9.2 MiB/month') // Just under 10 MiB
      expect(formatStorageCapacity(makeStorageUnit(10, 'MiB'), 0)).toBe('10 MiB/month') // Exactly 10 MiB
    })
  })

  describe('edge cases and boundary conditions', () => {
    it('should handle zero capacity', () => {
      expect(formatStorageCapacity(makeStorageUnit(0, 'B'))).toBe('0 B/month')
    })

    it('should handle very small positive values', () => {
      expect(formatStorageCapacity(makeStorageUnit(0.1, 'KiB'))).toBe('0.1 KiB/month')
      expect(formatStorageCapacity(makeStorageUnit(0.01, 'KiB'), 2)).toBe('0.01 KiB/month')
    })

    it('should handle exact boundary values', () => {
      // 0.9 GiB boundary
      expect(formatStorageCapacity(makeStorageUnit(911, 'MiB'), 0)).toBe('911 MiB/month')
      expect(formatStorageCapacity(makeStorageUnit(0.9, 'GiB'))).toBe('0.9 GiB/month')

      // 1024 GiB boundary
      expect(formatStorageCapacity(makeStorageUnit(1023.9, 'GiB'))).toBe(`1,023.9 GiB/month`)
      expect(formatStorageCapacity(makeStorageUnit(1, 'TiB'))).toBe('1.0 TiB/month')
    })

    it('should handle negative values by returning 0', () => {
      expect(formatStorageCapacity(makeStorageUnit(-1, 'TiB'))).toBe('0 B/month')
      expect(formatStorageCapacity(makeStorageUnit(-0.1, 'GiB'))).toBe('0 B/month')
    })
  })

  describe('precision handling', () => {
    it('should respect precision parameter for all unit types', () => {
      // TiB
      expect(formatStorageCapacity(makeStorageUnit(1, 'TiB'), 0)).toBe('1 TiB/month')
      expect(formatStorageCapacity(makeStorageUnit(1, 'TiB'), 1)).toBe('1.0 TiB/month')
      expect(formatStorageCapacity(makeStorageUnit(1, 'TiB'), 2)).toBe('1.00 TiB/month')
      expect(formatStorageCapacity(makeStorageUnit(1, 'TiB'), 3)).toBe('1.000 TiB/month')

      // GiB
      expect(formatStorageCapacity(makeStorageUnit(2, 'GiB'), 0)).toBe('2 GiB/month')
      expect(formatStorageCapacity(makeStorageUnit(1.5, 'GiB'), 1)).toBe('1.5 GiB/month')
      expect(formatStorageCapacity(makeStorageUnit(1.5, 'GiB'), 2)).toBe('1.50 GiB/month')

      // MiB
      expect(formatStorageCapacity(makeStorageUnit(102, 'MiB'), 0)).toBe('102 MiB/month')
      expect(formatStorageCapacity(makeStorageUnit(102.4, 'MiB'), 1)).toBe('102.4 MiB/month') // Custom precision overrides rounding
      expect(formatStorageCapacity(makeStorageUnit(102.4, 'MiB'), 2)).toBe('102.40 MiB/month')
    })
  })
})

describe.skip('formatStorageSize', () => {
  describe('TiB formatting', () => {
    it('should format large TiB values', () => {
      expect(formatStorageSize(makeStorageUnit(1, 'TiB'))).toBe('1.00 TiB')
      expect(formatStorageSize(makeStorageUnit(10, 'TiB'))).toBe('10.00 TiB')
      expect(formatStorageSize(makeStorageUnit(100, 'TiB'))).toBe('100.00 TiB')
    })

    it('should format TiB values with custom precision', () => {
      expect(formatStorageSize(makeStorageUnit(1.5, 'TiB'), 1)).toBe('1.5 TiB')
      expect(formatStorageSize(makeStorageUnit(1.5, 'TiB'), 3)).toBe('1.500 TiB')
    })
  })

  describe('GiB formatting', () => {
    it('should format GiB values', () => {
      expect(formatStorageSize(makeStorageUnit(102.4, 'GiB'))).toBe('102.40 GiB')
      expect(formatStorageSize(makeStorageUnit(512, 'GiB'))).toBe('512.00 GiB')
      expect(formatStorageSize(makeStorageUnit(921.6, 'GiB'))).toBe('921.60 GiB')
    })

    it('should format GiB values with custom precision', () => {
      expect(formatStorageSize(makeStorageUnit(102.4, 'GiB'), 1)).toBe('102.4 GiB')
      expect(formatStorageSize(makeStorageUnit(512, 'GiB'), 0)).toBe('512 GiB')
    })
  })

  describe('MiB formatting', () => {
    it('should format MiB values', () => {
      expect(formatStorageSize(makeStorageUnit(1.05, 'MiB'))).toBe('1.05 MiB') // Very small TiB values
      expect(formatStorageSize(makeStorageUnit(10.49, 'MiB'))).toBe('10.49 MiB')
      expect(formatStorageSize(makeStorageUnit(104.86, 'MiB'))).toBe('104.86 MiB')
    })

    it('should format MiB values with custom precision', () => {
      expect(formatStorageSize(makeStorageUnit(1, 'MiB'), 1)).toBe('1.0 MiB')
      expect(formatStorageSize(makeStorageUnit(10, 'MiB'), 0)).toBe('10 MiB')
    })
  })

  describe('KiB formatting', () => {
    it('should format very small values in KiB', () => {
      expect(formatStorageSize(makeStorageUnit(1.07, 'KiB'))).toBe('1.07 KiB') // Even smaller TiB values
      expect(formatStorageSize(makeStorageUnit(10.74, 'KiB'))).toBe('10.74 KiB')
    })

    it('should format KiB values with custom precision', () => {
      expect(formatStorageSize(makeStorageUnit(1.1, 'KiB'), 1)).toBe('1.1 KiB')
      expect(formatStorageSize(makeStorageUnit(11, 'KiB'), 0)).toBe('11 KiB')
    })
  })

  describe('edge cases', () => {
    it('should handle zero', () => {
      expect(formatStorageSize(makeStorageUnit(0, 'B'))).toBe('0.00 B')
    })

    it('should handle very small values', () => {
      expect(formatStorageSize(makeStorageUnit(1.1, 'B'))).toBe('1.10 B') // Extremely small TiB values
    })

    it('should handle negative values by returning 0', () => {
      expect(formatStorageSize(makeStorageUnit(-1, 'B'))).toBe('0.00 B')
    })
  })
})
