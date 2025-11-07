import { SIZE_CONSTANTS, TIME_CONSTANTS } from '@filoz/synapse-sdk'
import { ethers } from 'ethers'
import { describe, expect, it } from 'vitest'
import {
  applyFloorPricing,
  BUFFER_DENOMINATOR,
  BUFFER_NUMERATOR,
  calculatePieceUploadRequirements,
  calculateRequiredAllowances,
  computeAdjustmentForExactDaysWithPiece,
  DEFAULT_LOCKUP_DAYS,
  FLOOR_PRICE_DAYS,
  FLOOR_PRICE_PER_30_DAYS,
  getFloorAllowances,
  type PaymentStatus,
  type ServiceApprovalStatus,
} from '../../core/payments/index.js'

function makeStatus(params: { filecoinPayBalance: bigint; lockupUsed?: bigint; rateUsed?: bigint }): PaymentStatus {
  const currentAllowances: ServiceApprovalStatus = {
    rateAllowance: 0n,
    lockupAllowance: 0n,
    lockupUsed: params.lockupUsed ?? 0n,
    rateUsed: params.rateUsed ?? 0n,
    maxLockupPeriod: BigInt(DEFAULT_LOCKUP_DAYS) * TIME_CONSTANTS.EPOCHS_PER_DAY,
  }

  return {
    network: 'calibration',
    address: '0x0000000000000000000000000000000000000000',
    filBalance: 0n,
    walletUsdfcBalance: 0n,
    filecoinPayBalance: params.filecoinPayBalance,
    currentAllowances,
  }
}

function getBufferedFloorDeposit(): bigint {
  const floor = getFloorAllowances()
  return (floor.lockupAllowance * BUFFER_NUMERATOR) / BUFFER_DENOMINATOR
}

describe('Floor Pricing Constants', () => {
  it('floor price is 0.06 USDFC', () => {
    const expected = ethers.parseUnits('0.06', 18)
    expect(FLOOR_PRICE_PER_30_DAYS).toBe(expected)
  })

  it('floor price covers 30 days', () => {
    expect(FLOOR_PRICE_DAYS).toBe(30)
  })
})

describe('getFloorAllowances', () => {
  it('returns floor rate and lockup allowances', () => {
    const floor = getFloorAllowances()

    // Floor rate per epoch = 0.06 USDFC / (30 days * epochs per day)
    const epochsInFloorPeriod = BigInt(FLOOR_PRICE_DAYS) * TIME_CONSTANTS.EPOCHS_PER_DAY
    const expectedRateAllowance = FLOOR_PRICE_PER_30_DAYS / epochsInFloorPeriod

    expect(floor.rateAllowance).toBe(expectedRateAllowance)

    // Floor lockup = floor rate * lockup period
    const epochsInLockup = BigInt(DEFAULT_LOCKUP_DAYS) * TIME_CONSTANTS.EPOCHS_PER_DAY
    const expectedLockupAllowance = expectedRateAllowance * epochsInLockup

    expect(floor.lockupAllowance).toBe(expectedLockupAllowance)
    expect(floor.storageCapacityTiB).toBe(0) // Floor is not size-based
  })
})

describe('applyFloorPricing', () => {
  const mockPricing = 100_000_000_000_000n // Some arbitrary price per TiB per epoch

  const smallCases = [
    { label: 'tiny file (1 byte)', size: 1 },
    { label: 'small file (1 KB)', size: 1024 },
    { label: 'medium file (1 MB)', size: 1024 * 1024 },
  ]

  for (const { label, size } of smallCases) {
    it(`applies floor pricing to ${label}`, () => {
      const baseAllowances = calculateRequiredAllowances(size, mockPricing)
      const floorAdjusted = applyFloorPricing(baseAllowances)
      const floor = getFloorAllowances()

      expect(floorAdjusted.rateAllowance).toBe(floor.rateAllowance)
      expect(floorAdjusted.lockupAllowance).toBe(floor.lockupAllowance)
    })
  }

  it('does not apply floor for large file when base cost exceeds floor', () => {
    // Use a very high price to ensure base cost exceeds floor
    const highPrice = 1_000_000_000_000_000_000n // 1 USDFC per TiB per epoch
    const largeFile = Number(SIZE_CONSTANTS.GiB) * 100 // 100 GiB
    const baseAllowances = calculateRequiredAllowances(largeFile, highPrice)
    const floorAdjusted = applyFloorPricing(baseAllowances)
    const floor = getFloorAllowances()

    // Base cost should exceed floor, so base is returned
    expect(floorAdjusted.rateAllowance).toBeGreaterThan(floor.rateAllowance)
    expect(floorAdjusted.lockupAllowance).toBeGreaterThan(floor.lockupAllowance)
    expect(floorAdjusted.rateAllowance).toBe(baseAllowances.rateAllowance)
  })
})

describe('calculatePieceUploadRequirements - Floor Pricing Integration', () => {
  const mockPricing = 100_000_000_000_000n

  const floorSizes = [
    { label: '0-byte file', size: 0 },
    { label: '1 KB file', size: 1024 },
  ]

  for (const { label, size } of floorSizes) {
    it(`enforces floor price for ${label}`, () => {
      const status = makeStatus({ filecoinPayBalance: 0n })
      const requirements = calculatePieceUploadRequirements(status, size, mockPricing)
      const floor = getFloorAllowances()

      expect(requirements.required.rateAllowance).toBe(floor.rateAllowance)
      expect(requirements.required.lockupAllowance).toBe(floor.lockupAllowance)
    })
  }

  it('requires deposit with 10% buffer applied', () => {
    const status = makeStatus({ filecoinPayBalance: 0n })
    const requirements = calculatePieceUploadRequirements(status, 0, mockPricing)
    const bufferedFloor = getBufferedFloorDeposit()
    expect(requirements.totalDepositNeeded).toBe(bufferedFloor)

    // User needs to deposit the buffered amount
    expect(requirements.insufficientDeposit).toBe(bufferedFloor)
    expect(requirements.canUpload).toBe(false)
  })

  it('allows upload when deposit meets buffered floor price', () => {
    const bufferedFloor = getBufferedFloorDeposit()
    const status = makeStatus({ filecoinPayBalance: bufferedFloor })

    const requirements = calculatePieceUploadRequirements(status, 0, mockPricing)

    expect(requirements.canUpload).toBe(true)
    expect(requirements.insufficientDeposit).toBe(0n)
  })

  it('blocks upload when deposit is below buffered floor price', () => {
    const bufferedFloor = getBufferedFloorDeposit()
    const slightlyLess = bufferedFloor - 1n
    const status = makeStatus({ filecoinPayBalance: slightlyLess })

    const requirements = calculatePieceUploadRequirements(status, 0, mockPricing)

    expect(requirements.canUpload).toBe(false)
    expect(requirements.insufficientDeposit).toBe(1n)
  })
})

describe('computeAdjustmentForExactDaysWithPiece - Floor Pricing Integration', () => {
  const mockPricing = 100_000_000_000_000n

  it('applies floor pricing for small file in auto-fund calculation', () => {
    const status = makeStatus({ filecoinPayBalance: 0n, lockupUsed: 0n, rateUsed: 0n })
    const adjustment = computeAdjustmentForExactDaysWithPiece(status, 30, 1024, mockPricing)
    const floor = getFloorAllowances()

    // Should use floor-adjusted allowances
    expect(adjustment.newRateUsed).toBe(floor.rateAllowance)
    expect(adjustment.newLockupUsed).toBe(floor.lockupAllowance)
  })

  it('calculates correct deposit delta with floor pricing', () => {
    const status = makeStatus({ filecoinPayBalance: 0n, lockupUsed: 0n, rateUsed: 0n })
    const adjustment = computeAdjustmentForExactDaysWithPiece(status, 30, 0, mockPricing)
    const floor = getFloorAllowances()

    // Target deposit = buffered lockup + runway
    const bufferedLockup = getBufferedFloorDeposit()
    const perDay = floor.rateAllowance * TIME_CONSTANTS.EPOCHS_PER_DAY
    const safety = perDay > 0n ? perDay / 24n : 1n
    const runwayCost = 30n * perDay + safety

    expect(adjustment.delta).toBeGreaterThan(0n)
    expect(adjustment.targetDeposit).toBe(bufferedLockup + runwayCost)
  })
})
