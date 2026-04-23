import { TIME_CONSTANTS } from '@filoz/synapse-sdk'
import { describe, expect, it } from 'vitest'
import {
  calculateStorageRunway,
  computeAdjustmentForExactDays,
  computeAdjustmentForExactDaysWithPiece,
  computeAdjustmentForExactDeposit,
  computeTopUpForDuration,
  DEFAULT_LOCKUP_DAYS,
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
    chainId: 314159,
    address: '0x0000000000000000000000000000000000000000',
    filBalance: 0n,
    walletUsdfcBalance: 0n,
    filecoinPayBalance: params.filecoinPayBalance,
    currentAllowances,
  }
}

describe('computeTopUpForDuration', () => {
  it('returns 0 topUp when days <= 0', () => {
    const rateUsed = 1_000_000_000_000_000_000n // 1 USDFC/epoch
    const status = makeStatus({ filecoinPayBalance: 0n, rateUsed })
    const res = computeTopUpForDuration(status, 0)
    expect(res.topUp).toBe(0n)
    expect(res.perDay).toBe(rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY)
  })

  it('returns 0 topUp when rateUsed = 0', () => {
    const status = makeStatus({ filecoinPayBalance: 1_000n, rateUsed: 0n })
    const res = computeTopUpForDuration(status, 10)
    expect(res.topUp).toBe(0n)
    expect(res.perDay).toBe(0n)
  })

  it('returns 0 topUp when available already covers the period', () => {
    const rateUsed = 1_000_000_000_000_000_000n // 1 USDFC/epoch
    const perDay = rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY
    const days = 10
    const filecoinPayBalance = perDay * BigInt(days)
    const status = makeStatus({ filecoinPayBalance, lockupUsed: 0n, rateUsed })
    const res = computeTopUpForDuration(status, days)
    expect(res.topUp).toBe(0n)
    expect(res.available).toBe(filecoinPayBalance)
  })

  it('returns 0 topUp when deposit covers the period but lockup exceeds balance', () => {
    const rateUsed = 1_000_000_000_000_000_000n // 1 USDFC/epoch
    const perDay = rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY
    const days = 10
    const lockupUsed = perDay * 30n
    const filecoinPayBalance = perDay * BigInt(days)
    const status = makeStatus({ filecoinPayBalance, lockupUsed, rateUsed })
    const res = computeTopUpForDuration(status, days)
    expect(res.topUp).toBe(0n)
    expect(res.available).toBe(0n)
  })

  it('returns required topUp when deposit is insufficient', () => {
    const rateUsed = 1_000_000_000_000_000_000n // 1 USDFC/epoch
    const perDay = rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY
    const days = 10
    const filecoinPayBalance = perDay * 5n // only 5 days funded
    const lockupUsed = 0n
    const status = makeStatus({ filecoinPayBalance, lockupUsed, rateUsed })
    const res = computeTopUpForDuration(status, days)
    expect(res.topUp).toBe(perDay * 5n)
    expect(res.available).toBe(filecoinPayBalance)
  })
})

describe('computeAdjustmentForExactDays', () => {
  it('throws on negative days', () => {
    const status = makeStatus({ filecoinPayBalance: 0n, lockupUsed: 0n, rateUsed: 1n })
    expect(() => computeAdjustmentForExactDays(status, -1)).toThrow('days must be non-negative')
  })

  it('returns zeros when rateUsed is 0', () => {
    const status = makeStatus({ filecoinPayBalance: 1_000n, lockupUsed: 100n, rateUsed: 0n })
    const res = computeAdjustmentForExactDays(status, 10)
    expect(res.delta).toBe(0n)
    expect(res.targetAvailable).toBe(0n)
    expect(res.targetDeposit).toBe(1_000n)
    expect(res.available).toBe(900n)
  })

  it('returns positive delta when more deposit needed (includes 1-hour safety)', () => {
    const rateUsed = 1_000_000_000_000_000_000n // 1 USDFC/epoch
    const perDay = rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY
    const days = 30
    const available = perDay * 30n // exactly 30 days
    const status = makeStatus({ filecoinPayBalance: available, lockupUsed: 0n, rateUsed })
    const res = computeAdjustmentForExactDays(status, days)
    const perHour = perDay / 24n
    const safety = perHour > 0n ? perHour : 1n
    expect(res.delta).toBe(safety)
    expect(res.targetAvailable).toBe(perDay * 30n + safety)
    expect(res.targetDeposit).toBe(perDay * 30n + safety)
  })

  it('returns negative delta when withdrawal possible', () => {
    const rateUsed = 1_000_000_000_000_000_000n // 1 USDFC/epoch
    const perDay = rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY
    const days = 5
    const perHour = perDay / 24n
    const safety = perHour > 0n ? perHour : 1n
    const targetAvailable = perDay * BigInt(days) + safety
    const available = targetAvailable + 1_000n // a bit more than target
    const status = makeStatus({ filecoinPayBalance: available, lockupUsed: 0n, rateUsed })
    const res = computeAdjustmentForExactDays(status, days)
    expect(res.delta).toBe(-1_000n)
  })

  it('uses total deposited balance when lockupUsed exceeds balance', () => {
    const rateUsed = 1_000_000_000_000_000_000n // 1 USDFC/epoch
    const perDay = rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY
    const filecoinPayBalance = perDay * 20n
    const lockupUsed = perDay * 30n
    const status = makeStatus({ filecoinPayBalance, lockupUsed, rateUsed })

    const res = computeAdjustmentForExactDays(status, 20)

    const perHour = perDay / 24n
    const safety = perHour > 0n ? perHour : 1n
    expect(res.delta).toBe(safety)
    expect(res.available).toBe(0n)
    expect(res.targetDeposit).toBe(filecoinPayBalance + safety)
  })

  it('does not plan withdrawals below the current lockup', () => {
    const rateUsed = 1_000_000_000_000_000_000n // 1 USDFC/epoch
    const perDay = rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY
    const lockupUsed = perDay * 30n
    const filecoinPayBalance = lockupUsed + perDay * 5n
    const status = makeStatus({ filecoinPayBalance, lockupUsed, rateUsed })

    const res = computeAdjustmentForExactDays(status, 5)

    expect(res.targetDeposit).toBe(lockupUsed)
    expect(res.delta).toBe(lockupUsed - filecoinPayBalance)
  })
})

describe('computeAdjustmentForExactDeposit', () => {
  it('throws on negative target', () => {
    const status = makeStatus({ filecoinPayBalance: 0n, lockupUsed: 0n, rateUsed: 0n })
    expect(() => computeAdjustmentForExactDeposit(status, -1n)).toThrow('target deposit cannot be negative')
  })

  it('clamps target to lockup when target below locked funds', () => {
    const filecoinPayBalance = 1_000n
    const lockupUsed = 800n
    const status = makeStatus({ filecoinPayBalance, lockupUsed, rateUsed: 1n })
    const res = computeAdjustmentForExactDeposit(status, 500n)
    expect(res.clampedTarget).toBe(lockupUsed)
    // Need to withdraw down to locked amount
    expect(res.delta).toBe(lockupUsed - filecoinPayBalance) // negative
  })

  it('returns zero delta when already at target', () => {
    const filecoinPayBalance = 2_000n
    const lockupUsed = 500n
    const status = makeStatus({ filecoinPayBalance, lockupUsed, rateUsed: 1n })
    const res = computeAdjustmentForExactDeposit(status, filecoinPayBalance)
    expect(res.delta).toBe(0n)
    expect(res.clampedTarget).toBe(filecoinPayBalance)
  })

  it('returns positive delta when more deposit needed', () => {
    const filecoinPayBalance = 1_000n
    const lockupUsed = 100n
    const status = makeStatus({ filecoinPayBalance, lockupUsed, rateUsed: 1n })
    const res = computeAdjustmentForExactDeposit(status, 1_500n)
    expect(res.delta).toBe(500n)
    expect(res.clampedTarget).toBe(1_500n)
  })
})

describe('computeAdjustmentForExactDaysWithPiece', () => {
  it('calculates deposit for new file when rateUsed is 0', () => {
    // Scenario: No existing storage, uploading first file
    const status = makeStatus({ filecoinPayBalance: 0n, lockupUsed: 0n, rateUsed: 0n })
    const pieceSizeBytes = 1024 * 1024 * 1024 // 1 GiB
    const pricePerTiBPerEpoch = 1_000_000_000_000_000n // 0.001 USDFC per TiB per epoch
    const days = 30

    const res = computeAdjustmentForExactDaysWithPiece(status, days, pieceSizeBytes, pricePerTiBPerEpoch)

    // Should require deposit for both lockup and runway
    expect(res.delta).toBeGreaterThan(0n)
    expect(res.newRateUsed).toBeGreaterThan(0n)
    expect(res.newLockupUsed).toBeGreaterThan(0n)
  })

  it('adds file requirements to existing usage', () => {
    // Scenario: Existing storage, adding another file
    const rateUsed = 1_000_000_000_000_000_000n // 1 USDFC/epoch
    const lockupUsed = rateUsed * BigInt(30) * TIME_CONSTANTS.EPOCHS_PER_DAY // 30 days worth
    const filecoinPayBalance = (lockupUsed * 12n) / 10n // 20% buffer
    const status = makeStatus({ filecoinPayBalance, lockupUsed, rateUsed })

    const pieceSizeBytes = 1024 * 1024 * 1024 // 1 GiB
    const pricePerTiBPerEpoch = 1_000_000_000_000_000n // 0.001 USDFC per TiB per epoch
    const days = 30

    const res = computeAdjustmentForExactDaysWithPiece(status, days, pieceSizeBytes, pricePerTiBPerEpoch)

    // New rate should be higher than existing
    expect(res.newRateUsed).toBeGreaterThan(rateUsed)
    expect(res.newLockupUsed).toBeGreaterThan(lockupUsed)
  })

  it('keeps deposit at least at buffered lockup when runway target is smaller', () => {
    const status = makeStatus({ filecoinPayBalance: 0n, lockupUsed: 0n, rateUsed: 0n })
    const pieceSizeBytes = 1024
    const pricePerTiBPerEpoch = 1_000_000_000_000_000n // 0.001 USDFC per TiB per epoch
    const days = 1

    const res = computeAdjustmentForExactDaysWithPiece(status, days, pieceSizeBytes, pricePerTiBPerEpoch)

    const perDay = res.newRateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY
    const perHour = perDay / 24n
    const safety = perHour > 0n ? perHour : 1n
    const runwayCost = BigInt(days) * perDay + safety

    expect(res.targetDeposit).toBeGreaterThanOrEqual(res.newLockupUsed)
    expect(res.targetDeposit).toBeGreaterThan(runwayCost)
  })
})

describe('calculateStorageRunway', () => {
  it('returns unknown when status is null', () => {
    const result = calculateStorageRunway(null)
    expect(result.state).toBe('unknown')
    expect(result.days).toBe(0)
    expect(result.hours).toBe(0)
  })

  it('returns no-spend when rateUsed is 0', () => {
    const result = calculateStorageRunway({
      filecoinPayBalance: 1_000_000n,
      currentAllowances: { rateUsed: 0n, lockupUsed: 0n } as ServiceApprovalStatus,
    })
    expect(result.state).toBe('no-spend')
    expect(result.days).toBe(0)
  })

  it('calculates correct runway when lockupUsed is 0', () => {
    const rateUsed = 1_000_000_000_000_000_000n // 1 USDFC/epoch
    const perDay = rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY
    const filecoinPayBalance = perDay * 20n // 20 days worth
    const result = calculateStorageRunway({
      filecoinPayBalance,
      currentAllowances: { rateUsed, lockupUsed: 0n } as ServiceApprovalStatus,
    })
    expect(result.state).toBe('active')
    expect(result.days).toBe(20)
    expect(result.hours).toBe(0)
  })

  it('calculates correct runway when lockupUsed exceeds balance', () => {
    // This reproduces the reported bug: with 68 datasets on mainnet,
    // lockupUsed (~30 days of spend) can exceed the deposited balance,
    // causing the runway display to show ~0 days instead of the correct value.
    const rateUsed = 1_000_000_000_000_000_000n // 1 USDFC/epoch
    const perDay = rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY
    const lockupUsed = perDay * 30n // 30 days of lockup
    const filecoinPayBalance = perDay * 20n // only 20 days of deposit (less than lockup)

    const result = calculateStorageRunway({
      filecoinPayBalance,
      currentAllowances: { rateUsed, lockupUsed } as ServiceApprovalStatus,
    })

    expect(result.state).toBe('active')
    // Runway should be based on total balance / daily rate = 20 days
    // NOT (balance - lockup) / daily rate = 0 days
    expect(result.days).toBe(20)
    expect(result.hours).toBe(0)
  })

  it('matches the production report from issue 385', () => {
    const perDay = 467_000_000_000_000_000n // 0.4670 USDFC/day
    const rateUsed = perDay / TIME_CONSTANTS.EPOCHS_PER_DAY
    const filecoinPayBalance = 10_522_500_000_000_000_000n // 10.5225 USDFC
    const lockupUsed = perDay * 30n

    const result = calculateStorageRunway({
      filecoinPayBalance,
      currentAllowances: { rateUsed, lockupUsed } as ServiceApprovalStatus,
    })

    expect(result.state).toBe('active')
    expect(result.available).toBe(0n)
    expect(result.days).toBe(22)
  })

  it('calculates correct runway when lockupUsed is less than balance', () => {
    const rateUsed = 1_000_000_000_000_000_000n // 1 USDFC/epoch
    const perDay = rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY
    const lockupUsed = perDay * 10n // 10 days of lockup
    const filecoinPayBalance = perDay * 25n // 25 days of deposit

    const result = calculateStorageRunway({
      filecoinPayBalance,
      currentAllowances: { rateUsed, lockupUsed } as ServiceApprovalStatus,
    })

    expect(result.state).toBe('active')
    // Runway should be total balance / daily rate = 25 days
    expect(result.days).toBe(25)
    expect(result.hours).toBe(0)
  })

  it('keeps runway and available distinct when lockup exceeds balance', () => {
    const rateUsed = 1_000_000_000_000_000_000n // 1 USDFC/epoch
    const perDay = rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY
    const lockupUsed = perDay * 30n
    const filecoinPayBalance = perDay * 20n

    const result = calculateStorageRunway({
      filecoinPayBalance,
      currentAllowances: { rateUsed, lockupUsed } as ServiceApprovalStatus,
    })

    expect(result.available).toBe(0n)
    expect(result.days).toBe(20)
    expect(result.hours).toBe(0)
  })

  it('calculates correct hours remainder', () => {
    const rateUsed = 1_000_000_000_000_000_000n // 1 USDFC/epoch
    const perDay = rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY
    const lockupUsed = perDay * 30n
    // Balance covers 20 days + 12 hours (half a day extra)
    const filecoinPayBalance = perDay * 20n + perDay / 2n

    const result = calculateStorageRunway({
      filecoinPayBalance,
      currentAllowances: { rateUsed, lockupUsed } as ServiceApprovalStatus,
    })

    expect(result.state).toBe('active')
    expect(result.days).toBe(20)
    expect(result.hours).toBe(12)
  })
})
