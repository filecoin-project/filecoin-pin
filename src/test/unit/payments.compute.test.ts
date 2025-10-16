import { TIME_CONSTANTS } from '@filoz/synapse-sdk'
import { describe, expect, it } from 'vitest'
import {
  computeAdjustmentForExactDays,
  computeAdjustmentForExactDaysWithFile,
  computeAdjustmentForExactDeposit,
  computeTopUpForDuration,
  type PaymentStatus,
  type ServiceApprovalStatus,
} from '../../core/payments/index.js'

function makeStatus(params: { depositedAmount: bigint; lockupUsed?: bigint; rateUsed?: bigint }): PaymentStatus {
  const currentAllowances: ServiceApprovalStatus = {
    rateAllowance: 0n,
    lockupAllowance: 0n,
    lockupUsed: params.lockupUsed ?? 0n,
    rateUsed: params.rateUsed ?? 0n,
  }

  return {
    network: 'calibration',
    address: '0x0000000000000000000000000000000000000000',
    filBalance: 0n,
    usdfcBalance: 0n,
    depositedAmount: params.depositedAmount,
    currentAllowances,
  }
}

describe('computeTopUpForDuration', () => {
  it('returns 0 topUp when days <= 0', () => {
    const rateUsed = 1_000_000_000_000_000_000n // 1 USDFC/epoch
    const status = makeStatus({ depositedAmount: 0n, rateUsed })
    const res = computeTopUpForDuration(status, 0)
    expect(res.topUp).toBe(0n)
    expect(res.perDay).toBe(rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY)
  })

  it('returns 0 topUp when rateUsed = 0', () => {
    const status = makeStatus({ depositedAmount: 1_000n, rateUsed: 0n })
    const res = computeTopUpForDuration(status, 10)
    expect(res.topUp).toBe(0n)
    expect(res.perDay).toBe(0n)
  })

  it('returns 0 topUp when available already covers the period', () => {
    const rateUsed = 1_000_000_000_000_000_000n // 1 USDFC/epoch
    const perDay = rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY
    const days = 10
    const depositedAmount = perDay * BigInt(days)
    const status = makeStatus({ depositedAmount, lockupUsed: 0n, rateUsed })
    const res = computeTopUpForDuration(status, days)
    expect(res.topUp).toBe(0n)
    expect(res.available).toBe(depositedAmount)
  })

  it('returns required topUp when available is insufficient', () => {
    const rateUsed = 1_000_000_000_000_000_000n // 1 USDFC/epoch
    const perDay = rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY
    const days = 10
    const available = perDay * 5n // only 5 days funded
    const lockupUsed = 0n
    const depositedAmount = available + lockupUsed
    const status = makeStatus({ depositedAmount, lockupUsed, rateUsed })
    const res = computeTopUpForDuration(status, days)
    expect(res.topUp).toBe(perDay * 5n)
    expect(res.available).toBe(available)
  })
})

describe('computeAdjustmentForExactDays', () => {
  it('throws on negative days', () => {
    const status = makeStatus({ depositedAmount: 0n, lockupUsed: 0n, rateUsed: 1n })
    expect(() => computeAdjustmentForExactDays(status, -1)).toThrow('days must be non-negative')
  })

  it('returns zeros when rateUsed is 0', () => {
    const status = makeStatus({ depositedAmount: 1_000n, lockupUsed: 100n, rateUsed: 0n })
    const res = computeAdjustmentForExactDays(status, 10)
    expect(res.delta).toBe(0n)
    expect(res.targetAvailable).toBe(0n)
    expect(res.available).toBe(900n)
  })

  it('returns positive delta when more deposit needed (includes 1-hour safety)', () => {
    const rateUsed = 1_000_000_000_000_000_000n // 1 USDFC/epoch
    const perDay = rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY
    const days = 10
    const available = perDay * 10n // exactly 10 days
    const status = makeStatus({ depositedAmount: available, lockupUsed: 0n, rateUsed })
    const res = computeAdjustmentForExactDays(status, days)
    const perHour = perDay / 24n
    const safety = perHour > 0n ? perHour : 1n
    expect(res.delta).toBe(safety)
    expect(res.targetAvailable).toBe(perDay * 10n + safety)
  })

  it('returns negative delta when withdrawal possible', () => {
    const rateUsed = 1_000_000_000_000_000_000n // 1 USDFC/epoch
    const perDay = rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY
    const days = 5
    const perHour = perDay / 24n
    const safety = perHour > 0n ? perHour : 1n
    const targetAvailable = perDay * BigInt(days) + safety
    const available = targetAvailable + 1_000n // a bit more than target
    const status = makeStatus({ depositedAmount: available, lockupUsed: 0n, rateUsed })
    const res = computeAdjustmentForExactDays(status, days)
    expect(res.delta).toBe(-1_000n)
  })
})

describe('computeAdjustmentForExactDeposit', () => {
  it('throws on negative target', () => {
    const status = makeStatus({ depositedAmount: 0n, lockupUsed: 0n, rateUsed: 0n })
    expect(() => computeAdjustmentForExactDeposit(status, -1n)).toThrow('target deposit cannot be negative')
  })

  it('clamps target to lockup when target below locked funds', () => {
    const depositedAmount = 1_000n
    const lockupUsed = 800n
    const status = makeStatus({ depositedAmount, lockupUsed, rateUsed: 1n })
    const res = computeAdjustmentForExactDeposit(status, 500n)
    expect(res.clampedTarget).toBe(lockupUsed)
    // Need to withdraw down to locked amount
    expect(res.delta).toBe(lockupUsed - depositedAmount) // negative
  })

  it('returns zero delta when already at target', () => {
    const depositedAmount = 2_000n
    const lockupUsed = 500n
    const status = makeStatus({ depositedAmount, lockupUsed, rateUsed: 1n })
    const res = computeAdjustmentForExactDeposit(status, depositedAmount)
    expect(res.delta).toBe(0n)
    expect(res.clampedTarget).toBe(depositedAmount)
  })

  it('returns positive delta when more deposit needed', () => {
    const depositedAmount = 1_000n
    const lockupUsed = 100n
    const status = makeStatus({ depositedAmount, lockupUsed, rateUsed: 1n })
    const res = computeAdjustmentForExactDeposit(status, 1_500n)
    expect(res.delta).toBe(500n)
    expect(res.clampedTarget).toBe(1_500n)
  })
})

describe('computeAdjustmentForExactDaysWithFile', () => {
  it('calculates deposit for new file when rateUsed is 0', () => {
    // Scenario: No existing storage, uploading first file
    const status = makeStatus({ depositedAmount: 0n, lockupUsed: 0n, rateUsed: 0n })
    const carSizeBytes = 1024 * 1024 * 1024 // 1 GiB
    const pricePerTiBPerEpoch = 1_000_000_000_000_000n // 0.001 USDFC per TiB per epoch
    const days = 30

    const res = computeAdjustmentForExactDaysWithFile(status, days, carSizeBytes, pricePerTiBPerEpoch)

    // Should require deposit for both lockup and runway
    expect(res.delta).toBeGreaterThan(0n)
    expect(res.newRateUsed).toBeGreaterThan(0n)
    expect(res.newLockupUsed).toBeGreaterThan(0n)
  })

  it('adds file requirements to existing usage', () => {
    // Scenario: Existing storage, adding another file
    const rateUsed = 1_000_000_000_000_000_000n // 1 USDFC/epoch
    const lockupUsed = rateUsed * BigInt(10) * TIME_CONSTANTS.EPOCHS_PER_DAY // 10 days worth
    const depositedAmount = (lockupUsed * 12n) / 10n // 20% buffer
    const status = makeStatus({ depositedAmount, lockupUsed, rateUsed })

    const carSizeBytes = 1024 * 1024 * 1024 // 1 GiB
    const pricePerTiBPerEpoch = 1_000_000_000_000_000n // 0.001 USDFC per TiB per epoch
    const days = 30

    const res = computeAdjustmentForExactDaysWithFile(status, days, carSizeBytes, pricePerTiBPerEpoch)

    // New rate should be higher than existing
    expect(res.newRateUsed).toBeGreaterThan(rateUsed)
    expect(res.newLockupUsed).toBeGreaterThan(lockupUsed)
  })
})
