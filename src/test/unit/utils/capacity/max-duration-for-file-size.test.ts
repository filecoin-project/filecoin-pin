import { ethers } from 'ethers'
import { describe, expect, it, vi } from 'vitest'
import { calculateMaxDurationForFileSize } from '../../../../utils/capacity/max-duration-for-file-size.js'

// Mock TIME_CONSTANTS from SDK used internally
vi.mock('@filoz/synapse-sdk', () => ({
  TIME_CONSTANTS: {
    EPOCHS_PER_DAY: 2880n,
  },
  SIZE_CONSTANTS: {
    B: 1n,
    KiB: 1n << 10n,
    MiB: 1n << 20n,
    GiB: 1n << 30n,
    TiB: 1n << 40n,
    PiB: 1n << 50n,
  },
}))

describe('calculateMaxDurationForFileSize', () => {
  const pricePerTiBPerEpoch = ethers.parseUnits('0.0001', 18)

  it('computes duration and limiting factor when rate is limiting', () => {
    const fileSize = 10n * (1n << 20n) // 10 MiB
    // Make rate allowance small so rate becomes the limiting factor (< 10× required rate)
    const rateAllowance = ethers.parseUnits('0.000000001', 18) // 1e-9 USDFC/epoch
    const lockupAllowance = ethers.parseUnits('1000000', 18) // 1 million USDFC

    const res = calculateMaxDurationForFileSize({
      fileSize,
      rateAllowance,
      lockupAllowance,
      pricePerTiBPerEpoch,
    })

    expect(res.maxDurationDays).toBeGreaterThan(0)
    expect(res.limitingFactor).toBe('rate')
  })

  it('computes duration and limiting factor when lockup is limiting', () => {
    const fileSize = 10n * (1n << 20n) // 10 MiB
    const rateAllowance = ethers.parseUnits('1000000', 18) // 1 million USDFC
    const lockupAllowance = ethers.parseUnits('0.000000001', 18) // 1e-9 USDFC/epoch
    console.log('lockupAllowance', lockupAllowance)

    const res = calculateMaxDurationForFileSize({
      fileSize,
      rateAllowance,
      lockupAllowance,
      pricePerTiBPerEpoch,
    })

    expect(res.maxDurationDays).toBeGreaterThan(0)
    expect(res.limitingFactor).toBe('lockup')
  })

  it('caps lockup-based duration at 10 days when lockup sufficient', () => {
    const fileSize = 1n * (1n << 40n) // 1 TiB
    const rateAllowance = ethers.parseUnits('1000', 18) // 1000 USDFC/epoch
    const lockupAllowance = ethers.parseUnits('1000000000', 18) // 1 billion USDFC

    const res = calculateMaxDurationForFileSize({
      fileSize,
      rateAllowance,
      lockupAllowance,
      pricePerTiBPerEpoch,
    })

    expect(res.maxDurationDays).toBeLessThanOrEqual(10)
  })

  it('returns 0 when both allowances are zero', () => {
    const fileSize = 123n
    const rateAllowance = 0n
    const lockupAllowance = 0n

    const res = calculateMaxDurationForFileSize({
      fileSize,
      rateAllowance,
      lockupAllowance,
      pricePerTiBPerEpoch,
    })

    expect(res.maxDurationDays).toBe(0)
  })
})
