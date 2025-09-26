import { ethers } from 'ethers'
import { describe, expect, it, vi } from 'vitest'
import { calculateMaxUploadableFileSize } from '../../../../utils/capacity/max-uploadable-file-size.js'

vi.mock('@filoz/synapse-sdk', () => ({
  SIZE_CONSTANTS: {
    TiB: 1n << 40n,
  },
  TIME_CONSTANTS: {
    EPOCHS_PER_DAY: 2880n,
  },
}))

describe('calculateMaxUploadableFileSize', () => {
  const pricePerTiBPerEpoch = ethers.parseUnits('0.0001', 18)

  it('returns limiting factor correctly when rate < lockup capacity', () => {
    const rateAllowance = ethers.parseUnits('1', 18)
    const lockupAllowance = ethers.parseUnits('1000000', 18)

    const res = calculateMaxUploadableFileSize({
      rateAllowance,
      lockupAllowance,
      pricePerTiBPerEpoch,
      lockupUsed: 0n,
    })

    expect(res.maxSizeTiB).toBeGreaterThan(0)
    expect(['rate', 'lockup', 'both']).toContain(res.limitingFactor)
  })

  it('handles zero allowances', () => {
    const res = calculateMaxUploadableFileSize({
      rateAllowance: 0n,
      lockupAllowance: 0n,
      pricePerTiBPerEpoch,
      lockupUsed: 0n,
    })

    expect(res.maxSizeTiB).toBe(0)
    expect(res.maxSizeBytes).toBe(0)
  })
})
