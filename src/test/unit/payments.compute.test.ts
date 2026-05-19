import { TIME_CONSTANTS } from '@filoz/synapse-sdk'
import { describe, expect, it } from 'vitest'
import {
  type AccountSummary,
  computeAdjustmentForExactDays,
  computeAdjustmentForExactDaysWithPiece,
  computeAdjustmentForExactDeposit,
  computeTopUpForDuration,
  deriveStorageRunway,
} from '../../core/payments/index.js'

function makeSummary(params: { filecoinPayBalance: bigint; lockupUsed?: bigint; rateUsed?: bigint }): AccountSummary {
  const totalLockup = params.lockupUsed ?? 0n
  const lockupRatePerEpoch = params.rateUsed ?? 0n
  // SDK math: runway = (funds - lockup) / rate; coverage = funds / rate
  // We don't validate exact epoch values here, just that helpers consume the summary correctly.
  const runwayInEpochs = lockupRatePerEpoch === 0n ? 0n : (params.filecoinPayBalance - totalLockup) / lockupRatePerEpoch
  const grossCoverageInEpochs = lockupRatePerEpoch === 0n ? 0n : params.filecoinPayBalance / lockupRatePerEpoch
  const availableFunds = params.filecoinPayBalance > totalLockup ? params.filecoinPayBalance - totalLockup : 0n
  return {
    funds: params.filecoinPayBalance,
    availableFunds,
    totalLockup,
    lockupRatePerEpoch,
    runwayInEpochs: runwayInEpochs > 0n ? runwayInEpochs : 0n,
    grossCoverageInEpochs,
  }
}

describe('computeTopUpForDuration', () => {
  it('returns 0 topUp when days <= 0', () => {
    const rateUsed = 1_000_000_000_000_000_000n
    const summary = makeSummary({ filecoinPayBalance: 0n, rateUsed })
    const res = computeTopUpForDuration(summary, 0n, 0)
    expect(res.topUp).toBe(0n)
    expect(res.perDay).toBe(rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY)
  })

  it('returns 0 topUp when rateUsed = 0', () => {
    const summary = makeSummary({ filecoinPayBalance: 1_000n, rateUsed: 0n })
    const res = computeTopUpForDuration(summary, 1_000n, 10)
    expect(res.topUp).toBe(0n)
    expect(res.perDay).toBe(0n)
  })

  it('returns 0 topUp when balance already covers the period', () => {
    const rateUsed = 1_000_000_000_000_000_000n
    const perDay = rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY
    const days = 10
    const filecoinPayBalance = perDay * BigInt(days)
    const summary = makeSummary({ filecoinPayBalance, lockupUsed: 0n, rateUsed })
    const res = computeTopUpForDuration(summary, filecoinPayBalance, days)
    expect(res.topUp).toBe(0n)
  })

  it('issue #385: balance covers days even when lockup exceeds balance', () => {
    const rateUsed = 1_000_000_000_000_000_000n
    const perDay = rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY
    const days = 10
    const lockupUsed = perDay * 30n
    const filecoinPayBalance = perDay * BigInt(days)
    const summary = makeSummary({ filecoinPayBalance, lockupUsed, rateUsed })
    const res = computeTopUpForDuration(summary, filecoinPayBalance, days)
    expect(res.topUp).toBe(0n)
    expect(res.lockupUsed).toBe(lockupUsed)
  })

  it('returns required topUp when balance is insufficient', () => {
    const rateUsed = 1_000_000_000_000_000_000n
    const perDay = rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY
    const days = 10
    const filecoinPayBalance = perDay * 5n
    const summary = makeSummary({ filecoinPayBalance, lockupUsed: 0n, rateUsed })
    const res = computeTopUpForDuration(summary, filecoinPayBalance, days)
    expect(res.topUp).toBe(perDay * 5n)
  })
})

describe('computeAdjustmentForExactDays', () => {
  it('throws on negative days', () => {
    const summary = makeSummary({ filecoinPayBalance: 0n, lockupUsed: 0n, rateUsed: 1n })
    expect(() => computeAdjustmentForExactDays(summary, 0n, -1)).toThrow('days must be non-negative')
  })

  it('returns zeros when rateUsed is 0', () => {
    const summary = makeSummary({ filecoinPayBalance: 1_000n, lockupUsed: 100n, rateUsed: 0n })
    const res = computeAdjustmentForExactDays(summary, 1_000n, 10)
    expect(res.delta).toBe(0n)
    expect(res.targetDeposit).toBe(1_000n)
  })

  it('returns positive delta when more deposit needed (includes 1-hour safety)', () => {
    const rateUsed = 1_000_000_000_000_000_000n
    const perDay = rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY
    const days = 30
    const balance = perDay * 30n
    const summary = makeSummary({ filecoinPayBalance: balance, lockupUsed: 0n, rateUsed })
    const res = computeAdjustmentForExactDays(summary, balance, days)
    const safety = perDay / 24n
    expect(res.delta).toBe(safety)
    expect(res.targetDeposit).toBe(perDay * 30n + safety)
  })

  it('returns negative delta when withdrawal possible', () => {
    const rateUsed = 1_000_000_000_000_000_000n
    const perDay = rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY
    const days = 5
    const safety = perDay / 24n
    const targetDeposit = perDay * BigInt(days) + safety
    const balance = targetDeposit + 1_000n
    const summary = makeSummary({ filecoinPayBalance: balance, lockupUsed: 0n, rateUsed })
    const res = computeAdjustmentForExactDays(summary, balance, days)
    expect(res.delta).toBe(-1_000n)
  })

  it('targets gross coverage when lockupUsed exceeds balance', () => {
    const rateUsed = 1_000_000_000_000_000_000n
    const perDay = rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY
    const balance = perDay * 20n
    const lockupUsed = perDay * 30n
    const summary = makeSummary({ filecoinPayBalance: balance, lockupUsed, rateUsed })

    const res = computeAdjustmentForExactDays(summary, balance, 20)

    const safety = perDay / 24n
    expect(res.delta).toBe(safety)
    expect(res.targetDeposit).toBe(balance + safety)
  })

  it('does not plan withdrawals below the current lockup', () => {
    const rateUsed = 1_000_000_000_000_000_000n
    const perDay = rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY
    const lockupUsed = perDay * 30n
    const balance = lockupUsed + perDay * 5n
    const summary = makeSummary({ filecoinPayBalance: balance, lockupUsed, rateUsed })

    const res = computeAdjustmentForExactDays(summary, balance, 5)

    expect(res.targetDeposit).toBe(lockupUsed)
    expect(res.delta).toBe(lockupUsed - balance)
  })
})

describe('computeAdjustmentForExactDeposit', () => {
  it('throws on negative target', () => {
    const summary = makeSummary({ filecoinPayBalance: 0n, lockupUsed: 0n, rateUsed: 0n })
    expect(() => computeAdjustmentForExactDeposit(summary, 0n, -1n)).toThrow('target deposit cannot be negative')
  })

  it('clamps target to lockup when target below locked funds', () => {
    const balance = 1_000n
    const lockupUsed = 800n
    const summary = makeSummary({ filecoinPayBalance: balance, lockupUsed, rateUsed: 1n })
    const res = computeAdjustmentForExactDeposit(summary, balance, 500n)
    expect(res.clampedTarget).toBe(lockupUsed)
    expect(res.delta).toBe(lockupUsed - balance)
  })

  it('returns zero delta when already at target', () => {
    const balance = 2_000n
    const lockupUsed = 500n
    const summary = makeSummary({ filecoinPayBalance: balance, lockupUsed, rateUsed: 1n })
    const res = computeAdjustmentForExactDeposit(summary, balance, balance)
    expect(res.delta).toBe(0n)
    expect(res.clampedTarget).toBe(balance)
  })

  it('returns positive delta when more deposit needed', () => {
    const balance = 1_000n
    const lockupUsed = 100n
    const summary = makeSummary({ filecoinPayBalance: balance, lockupUsed, rateUsed: 1n })
    const res = computeAdjustmentForExactDeposit(summary, balance, 1_500n)
    expect(res.delta).toBe(500n)
    expect(res.clampedTarget).toBe(1_500n)
  })
})

describe('computeAdjustmentForExactDaysWithPiece', () => {
  it('calculates deposit for new file when rateUsed is 0', () => {
    const summary = makeSummary({ filecoinPayBalance: 0n, lockupUsed: 0n, rateUsed: 0n })
    const pieceSizeBytes = 1024 * 1024 * 1024
    const pricePerTiBPerEpoch = 1_000_000_000_000_000n
    const days = 30

    const res = computeAdjustmentForExactDaysWithPiece(summary, 0n, days, pieceSizeBytes, pricePerTiBPerEpoch)

    expect(res.delta).toBeGreaterThan(0n)
    expect(res.newRateUsed).toBeGreaterThan(0n)
    expect(res.newLockupUsed).toBeGreaterThan(0n)
  })

  it('adds file requirements to existing usage', () => {
    const rateUsed = 1_000_000_000_000_000_000n
    const lockupUsed = rateUsed * 30n * TIME_CONSTANTS.EPOCHS_PER_DAY
    const balance = (lockupUsed * 12n) / 10n
    const summary = makeSummary({ filecoinPayBalance: balance, lockupUsed, rateUsed })

    const pieceSizeBytes = 1024 * 1024 * 1024
    const pricePerTiBPerEpoch = 1_000_000_000_000_000n
    const days = 30

    const res = computeAdjustmentForExactDaysWithPiece(summary, balance, days, pieceSizeBytes, pricePerTiBPerEpoch)

    expect(res.newRateUsed).toBeGreaterThan(rateUsed)
    expect(res.newLockupUsed).toBeGreaterThan(lockupUsed)
  })

  it('keeps deposit at least at buffered lockup when runway target is smaller', () => {
    const summary = makeSummary({ filecoinPayBalance: 0n, lockupUsed: 0n, rateUsed: 0n })
    const pieceSizeBytes = 1024
    const pricePerTiBPerEpoch = 1_000_000_000_000_000n
    const days = 1

    const res = computeAdjustmentForExactDaysWithPiece(summary, 0n, days, pieceSizeBytes, pricePerTiBPerEpoch)

    const perDay = res.newRateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY
    const safety = perDay / 24n > 0n ? perDay / 24n : 1n
    const runwayCost = BigInt(days) * perDay + safety

    expect(res.targetDeposit).toBeGreaterThanOrEqual(res.newLockupUsed)
    expect(res.targetDeposit).toBeGreaterThan(runwayCost)
  })
})

describe('deriveStorageRunway', () => {
  it('returns no-spend when rate is 0', () => {
    const result = deriveStorageRunway({
      funds: 1_000_000n,
      availableFunds: 1_000_000n,
      totalLockup: 0n,
      lockupRatePerEpoch: 0n,
      runwayInEpochs: 0n,
      grossCoverageInEpochs: 0n,
    })
    expect(result.state).toBe('no-spend')
    expect(result.runwayDays).toBe(0)
    expect(result.coverageDays).toBe(0)
  })

  it('converts SDK epochs to days/hours for both metrics', () => {
    const rate = 1_000_000_000_000_000_000n
    const result = deriveStorageRunway({
      funds: 0n,
      availableFunds: 0n,
      totalLockup: 0n,
      lockupRatePerEpoch: rate,
      runwayInEpochs: TIME_CONSTANTS.EPOCHS_PER_DAY * 5n,
      grossCoverageInEpochs: TIME_CONSTANTS.EPOCHS_PER_DAY * 20n,
    })
    expect(result.state).toBe('active')
    expect(result.runwayDays).toBe(5)
    expect(result.coverageDays).toBe(20)
  })

  it('issue #385: lockup exceeds balance — runway near zero, coverage substantial', () => {
    // SDK runwayInEpochs would clamp to 0 when lockup >= balance
    const rate = 1_000_000_000_000_000_000n
    const result = deriveStorageRunway({
      funds: rate * TIME_CONSTANTS.EPOCHS_PER_DAY * 20n,
      availableFunds: 0n,
      totalLockup: rate * TIME_CONSTANTS.EPOCHS_PER_DAY * 30n,
      lockupRatePerEpoch: rate,
      runwayInEpochs: 0n,
      grossCoverageInEpochs: TIME_CONSTANTS.EPOCHS_PER_DAY * 20n,
    })
    expect(result.runwayDays).toBe(0)
    expect(result.coverageDays).toBe(20)
  })

  it('projection input goes through resolveAccountState (synthetic state)', () => {
    const rate = 1_000_000_000_000_000_000n
    const perDay = rate * TIME_CONSTANTS.EPOCHS_PER_DAY
    const result = deriveStorageRunway({
      funds: perDay * 25n,
      lockupCurrent: perDay * 10n,
      lockupRate: rate,
    })
    // Coverage = 25 days, runway = 25-10 = 15 days
    expect(result.coverageDays).toBe(25)
    expect(result.runwayDays).toBe(15)
  })

  it('hour remainder', () => {
    const rate = 1_000_000_000_000_000_000n
    const result = deriveStorageRunway({
      funds: 0n,
      availableFunds: 0n,
      totalLockup: 0n,
      lockupRatePerEpoch: rate,
      runwayInEpochs: TIME_CONSTANTS.EPOCHS_PER_DAY * 20n + TIME_CONSTANTS.EPOCHS_PER_HOUR * 12n,
      grossCoverageInEpochs: TIME_CONSTANTS.EPOCHS_PER_DAY * 20n + TIME_CONSTANTS.EPOCHS_PER_HOUR * 12n,
    })
    expect(result.runwayDays).toBe(20)
    expect(result.runwayHours).toBe(12)
    expect(result.coverageDays).toBe(20)
    expect(result.coverageHours).toBe(12)
  })
})
