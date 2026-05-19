/**
 * Storage runway helpers.
 *
 * Two metrics derived from on-chain account state:
 *
 * - `runway`: epochs until top-up is needed. Excludes funds already locked
 *   into rails.
 * - `coverage`: total epochs the deposit covers, including currently locked
 *   funds.
 *
 * Both are surfaced together because either alone is misleading.
 */

import { resolveAccountState } from '@filoz/synapse-core/pay'
import { type Synapse, TIME_CONSTANTS } from '@filoz/synapse-sdk'
import { maxUint256 } from 'viem'
import type { StorageRunwaySummary } from './types.js'

/** Subset of `synapse.payments.accountSummary` output we consume. */
export interface AccountRunwayInput {
  funds: bigint
  totalLockup: bigint
  lockupRatePerEpoch: bigint
  runwayInEpochs: bigint
  grossCoverageInEpochs: bigint
}

/**
 * Synthetic account state for hypothetical projections.
 *
 * `lockupLastSettledAt` and `currentEpoch` are pinned to 0 so SDK
 * settle-forward growth is zero. Caller must therefore supply
 * `lockupCurrent` already expressed at the projection point.
 */
export interface ProjectionRunwayInput {
  funds: bigint
  lockupCurrent: bigint
  lockupRate: bigint
}

function isAccountRunway(input: AccountRunwayInput | ProjectionRunwayInput): input is AccountRunwayInput {
  return 'runwayInEpochs' in input
}

function epochsToDaysHours(epochs: bigint): { days: number; hours: number } {
  if (epochs >= maxUint256) {
    return { days: Number.POSITIVE_INFINITY, hours: 0 }
  }
  const days = Number(epochs / TIME_CONSTANTS.EPOCHS_PER_DAY)
  const hourEpochs = epochs % TIME_CONSTANTS.EPOCHS_PER_DAY
  const hours = Number(hourEpochs / TIME_CONSTANTS.EPOCHS_PER_HOUR)
  return { days, hours }
}

/**
 * Convert SDK account summary or projection input into a display-ready runway summary.
 *
 * SDK `AccountSummary` inputs are trusted as-is (their `runwayInEpochs` /
 * `grossCoverageInEpochs` already come from `resolveAccountState` inside the
 * SDK). Projection inputs build a synthetic state and run it through
 * `resolveAccountState` so filecoin-pin and the SDK never disagree on the
 * meaning of "runway".
 */
export function deriveStorageRunway(input: AccountRunwayInput | ProjectionRunwayInput): StorageRunwaySummary {
  let runwayInEpochs: bigint
  let coverageInEpochs: bigint
  let ratePerEpoch: bigint
  let lockupUsed: bigint

  if (isAccountRunway(input)) {
    runwayInEpochs = input.runwayInEpochs
    coverageInEpochs = input.grossCoverageInEpochs
    ratePerEpoch = input.lockupRatePerEpoch
    lockupUsed = input.totalLockup
  } else {
    const resolved = resolveAccountState({
      funds: input.funds,
      lockupCurrent: input.lockupCurrent,
      lockupRate: input.lockupRate,
      lockupLastSettledAt: 0n,
      currentEpoch: 0n,
    })
    runwayInEpochs = resolved.runwayInEpochs
    coverageInEpochs = resolved.grossCoverageInEpochs
    ratePerEpoch = input.lockupRate
    lockupUsed = input.lockupCurrent
  }

  const perDay = ratePerEpoch * TIME_CONSTANTS.EPOCHS_PER_DAY

  if (ratePerEpoch === 0n) {
    return {
      state: 'no-spend',
      rateUsed: 0n,
      perDay: 0n,
      lockupUsed,
      runwayDays: 0,
      runwayHours: 0,
      coverageDays: 0,
      coverageHours: 0,
    }
  }

  const runway = epochsToDaysHours(runwayInEpochs)
  const coverage = epochsToDaysHours(coverageInEpochs)

  return {
    state: 'active',
    rateUsed: ratePerEpoch,
    perDay,
    lockupUsed,
    runwayDays: runway.days,
    runwayHours: runway.hours,
    coverageDays: coverage.days,
    coverageHours: coverage.hours,
  }
}

/**
 * Fetch storage runway for the connected account.
 *
 * Lazy-fetched from `synapse.payments.accountSummary({})` only on display
 * paths that show runway; not bundled into `getPaymentStatus` because most
 * payment commands do not need it (extra two RPC reads).
 */
export async function getStorageRunway(synapse: Synapse): Promise<StorageRunwaySummary> {
  const summary = await synapse.payments.accountSummary({})
  return deriveStorageRunway(summary)
}
