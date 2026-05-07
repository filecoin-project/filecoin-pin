import { USDFC_SYBIL_FEE } from '@filoz/synapse-core/utils'
import { calibration, type Synapse } from '@filoz/synapse-sdk'
import { MIN_FIL_FOR_GAS } from './constants.js'
import {
  checkAndSetAllowances,
  computeAdjustmentForExactDays,
  computeAdjustmentForExactDaysWithPiece,
  computeAdjustmentForExactDeposit,
  depositUSDFC,
  getPaymentStatus,
  validatePaymentRequirements,
  withdrawUSDFC,
} from './index.js'
import { deriveStorageRunway } from './runway.js'
import type {
  AccountSummary,
  FilecoinPayFundingExecution,
  FilecoinPayFundingInsights,
  FilecoinPayFundingPlan,
  FilecoinPayFundingPlanOptions,
  FundingMode,
  FundingReasonCode,
  PaymentStatus,
  ServiceApprovalStatus,
} from './types.js'

function calculateDepletionTiming(
  balance: bigint,
  perDay: bigint
): { seconds: bigint; timestampMs?: number | null } | null {
  if (balance <= 0n || perDay <= 0n) {
    return null
  }

  const seconds = (balance * 86_400n) / perDay
  if (seconds <= 0n) {
    return null
  }

  const maxSecondsForNumber = BigInt(Number.MAX_SAFE_INTEGER) / 1000n
  const timestampMs = seconds <= maxSecondsForNumber ? Date.now() + Number(seconds) * 1000 : null

  return {
    seconds,
    timestampMs,
  }
}

/**
 * Get funding insights for a payment status.
 *
 * Current state uses the SDK account summary directly. Projected state
 * (when `overrides` is provided) builds a synthetic SDK account state and
 * runs it through `resolveAccountState`, so projected runway/coverage match
 * SDK semantics rather than a parallel local interpretation.
 */
export function getFilecoinPayFundingInsights(
  status: PaymentStatus,
  accountSummary: AccountSummary,
  overrides?: { depositedBalance?: bigint; rateUsed?: bigint; lockupUsed?: bigint; walletUsdfcBalance?: bigint }
): FilecoinPayFundingInsights {
  const depositedBalance = overrides?.depositedBalance ?? status.filecoinPayBalance
  const rateUsed = overrides?.rateUsed ?? accountSummary.lockupRatePerEpoch
  const lockupUsed = overrides?.lockupUsed ?? accountSummary.totalLockup
  const walletUsdfcBalance = overrides?.walletUsdfcBalance ?? status.walletUsdfcBalance

  const runway =
    overrides == null
      ? deriveStorageRunway(accountSummary)
      : deriveStorageRunway({
          funds: depositedBalance,
          lockupCurrent: lockupUsed,
          lockupRate: rateUsed,
        })

  const availableDeposited = depositedBalance > lockupUsed ? depositedBalance - lockupUsed : 0n
  const filecoinPayDepletion = calculateDepletionTiming(depositedBalance, runway.perDay)
  const ownerDepletion = calculateDepletionTiming(depositedBalance + walletUsdfcBalance, runway.perDay)

  return {
    spendRatePerEpoch: rateUsed,
    spendRatePerDay: runway.perDay,
    depositedBalance,
    availableDeposited,
    walletUsdfcBalance,
    runway,
    filecoinPayDepletionSeconds: filecoinPayDepletion?.seconds ?? null,
    filecoinPayDepletionTimestampMs: filecoinPayDepletion?.timestampMs ?? null,
    ownerDepletionSeconds: ownerDepletion?.seconds ?? null,
    ownerDepletionTimestampMs: ownerDepletion?.timestampMs ?? null,
  }
}

/**
 * Format a funding reason code into a human-readable message
 *
 * @param reasonCode - The funding reason code
 * @param plan - Optional plan for additional context (e.g., days)
 * @returns Human-readable message explaining the funding reason
 */
export function formatFundingReason(reasonCode: FundingReasonCode, plan?: FilecoinPayFundingPlan): string {
  switch (reasonCode) {
    case 'none':
      return 'No funding adjustment needed'
    case 'piece-upload':
      return 'Required funding for file upload (lockup requirement)'
    case 'runway-insufficient':
      return plan?.targetRunwayDays != null
        ? `Required funding for ${plan.targetRunwayDays} days of storage`
        : 'Required funding to meet runway target'
    case 'runway-with-piece':
      return plan?.targetRunwayDays != null
        ? `Required funding for ${plan.targetRunwayDays} days of storage (including upcoming upload)`
        : 'Required funding for storage runway (including upcoming upload)'
    case 'target-deposit':
      return 'Required funding to reach target deposit amount'
    case 'withdrawal-excess':
      return 'Excess funds available for withdrawal'
    default:
      return 'Unknown funding reason'
  }
}

/**
 * Calculate a Filecoin Pay funding plan without making network calls.
 *
 * Pure calculation: caller supplies a fresh `PaymentStatus` and matching
 * `accountSummary`. For the full async workflow that fetches both upstream,
 * use `planFilecoinPayFunding`.
 *
 * @param options - Calculation options with payment status and account summary
 * @returns Funding plan with delta, action, and insights
 */
export function calculateFilecoinPayFundingPlan(options: FilecoinPayFundingPlanOptions): FilecoinPayFundingPlan {
  const {
    status,
    accountSummary,
    targetRunwayDays,
    targetDeposit,
    pieceSizeBytes,
    pricePerTiBPerEpoch,
    newDataSetCount = 0,
    mode = 'exact',
    allowWithdraw = true,
  } = options

  if (targetRunwayDays != null && targetDeposit != null) {
    throw new Error('Specify either targetRunwayDays or targetDeposit, not both')
  }

  if (targetRunwayDays == null && targetDeposit == null) {
    throw new Error('A funding target is required')
  }

  if (pieceSizeBytes != null && pricePerTiBPerEpoch == null) {
    throw new Error('pricePerTiBPerEpoch is required when pieceSizeBytes is provided')
  }

  if (!Number.isInteger(newDataSetCount) || newDataSetCount < 0) {
    throw new Error('newDataSetCount must be a non-negative integer')
  }

  let delta: bigint
  let projectedDeposit = status.filecoinPayBalance
  let projectedRateUsed = accountSummary.lockupRatePerEpoch
  let projectedLockupUsed: bigint
  let resolvedTargetDeposit: bigint | undefined
  let reasonCode: FundingReasonCode = 'none'
  let targetType: 'runway-days' | 'deposit'

  if (targetRunwayDays != null) {
    targetType = 'runway-days'
    if (pieceSizeBytes != null) {
      if (pricePerTiBPerEpoch == null) {
        throw new Error('pricePerTiBPerEpoch is required when planning with pieceSizeBytes')
      }
      const adjustment = computeAdjustmentForExactDaysWithPiece(
        accountSummary,
        status.filecoinPayBalance,
        targetRunwayDays,
        pieceSizeBytes,
        pricePerTiBPerEpoch
      )
      const dataSetCreationFees = BigInt(newDataSetCount) * USDFC_SYBIL_FEE
      delta = adjustment.delta + dataSetCreationFees
      resolvedTargetDeposit = adjustment.targetDeposit + dataSetCreationFees
      projectedRateUsed = adjustment.newRateUsed
      projectedLockupUsed = adjustment.newLockupUsed

      if (targetRunwayDays === 0) {
        // Special case: targetRunwayDays === 0 means "fund this upload only" (no runway target).
        // Even with 0 days, onboarding a new piece can still require additional deposit to satisfy
        // the piece's lockup requirement (and the small safety buffer).
        reasonCode = delta > 0n ? 'piece-upload' : 'none'
      } else if (delta > 0n) {
        reasonCode = 'runway-with-piece'
      } else if (delta < 0n) {
        reasonCode = 'withdrawal-excess'
      }
    } else {
      const adjustment = computeAdjustmentForExactDays(accountSummary, status.filecoinPayBalance, targetRunwayDays)
      delta = adjustment.delta
      projectedRateUsed = adjustment.rateUsed
      projectedLockupUsed = adjustment.lockupUsed
      resolvedTargetDeposit = status.filecoinPayBalance + delta

      if (delta > 0n) {
        reasonCode = 'runway-insufficient'
      } else if (delta < 0n) {
        reasonCode = 'withdrawal-excess'
      }
    }
  } else {
    targetType = 'deposit'
    const adjustment = computeAdjustmentForExactDeposit(accountSummary, status.filecoinPayBalance, targetDeposit ?? 0n)
    delta = adjustment.delta
    resolvedTargetDeposit = adjustment.clampedTarget
    projectedLockupUsed = adjustment.lockupUsed

    if (delta > 0n) {
      reasonCode = 'target-deposit'
    } else if (delta < 0n) {
      reasonCode = 'withdrawal-excess'
    }
  }

  if (mode === 'minimum' && delta < 0n) {
    delta = 0n
    reasonCode = 'none'
  }

  if (!allowWithdraw && delta < 0n) {
    delta = 0n
    reasonCode = 'none'
  }

  const projectedDepositUnsafe = status.filecoinPayBalance + delta
  projectedDeposit = projectedDepositUnsafe > 0n ? projectedDepositUnsafe : 0n

  const walletShortfall =
    delta > 0n && delta > status.walletUsdfcBalance ? delta - status.walletUsdfcBalance : undefined

  // Wallet USDFC actually consumed by a deposit (clamped to wallet balance) so projected
  // owner depletion reflects what the user would still hold after executing the plan.
  const projectedWalletUsdfcBalance = projectWalletAfterDelta(status.walletUsdfcBalance, delta)

  const currentInsights = getFilecoinPayFundingInsights(status, accountSummary)
  const projectedInsights = getFilecoinPayFundingInsights(status, accountSummary, {
    depositedBalance: projectedDeposit,
    rateUsed: projectedRateUsed,
    lockupUsed: projectedLockupUsed,
    walletUsdfcBalance: projectedWalletUsdfcBalance,
  })

  const plan: FilecoinPayFundingPlan = {
    targetType,
    delta,
    action: delta > 0n ? 'deposit' : delta < 0n ? 'withdraw' : 'none',
    reasonCode,
    mode,
    projectedDeposit,
    projectedRateUsed,
    projectedLockupUsed,
    current: currentInsights,
    projected: projectedInsights,
    ...(targetRunwayDays != null ? { targetRunwayDays } : {}),
    ...(resolvedTargetDeposit != null ? { targetDeposit: resolvedTargetDeposit } : {}),
    ...(pieceSizeBytes != null ? { pieceSizeBytes } : {}),
    ...(pricePerTiBPerEpoch != null ? { pricePerTiBPerEpoch } : {}),
    ...(newDataSetCount > 0 ? { newDataSetCount } : {}),
    ...(walletShortfall != null ? { walletShortfall } : {}),
  }

  return plan
}

function projectWalletAfterDelta(walletUsdfcBalance: bigint, delta: bigint): bigint {
  if (delta > 0n) {
    const consumed = delta > walletUsdfcBalance ? walletUsdfcBalance : delta
    return walletUsdfcBalance - consumed
  }
  if (delta < 0n) {
    return walletUsdfcBalance + -delta
  }
  return walletUsdfcBalance
}

/**
 * Options for planning Filecoin Pay funding with network calls
 *
 * Used by `planFilecoinPayFunding` - the async planning function.
 * Requires a `Synapse` instance and will fetch current status and pricing.
 *
 * Specify either `targetRunwayDays` OR `targetDeposit`, not both.
 */
export interface PlanFilecoinPayFundingOptions {
  synapse: Synapse
  targetRunwayDays?: number | undefined
  targetDeposit?: bigint | undefined
  pieceSizeBytes?: number | undefined
  pricePerTiBPerEpoch?: bigint | undefined
  newDataSetCount?: number | undefined
  mode?: FundingMode | undefined
  allowWithdraw?: boolean | undefined
  ensureAllowances?: boolean | undefined
}

/**
 * Plan Filecoin Pay funding adjustments with network calls
 *
 * Fetches `PaymentStatus` and `accountSummary` in parallel, then delegates
 * to `calculateFilecoinPayFundingPlan` for pure calculation.
 *
 * @param options - Planning options including synapse instance
 * @returns Plan with status and allowance information
 */
export async function planFilecoinPayFunding(options: PlanFilecoinPayFundingOptions): Promise<{
  plan: FilecoinPayFundingPlan
  status: PaymentStatus
  accountSummary: AccountSummary
  allowances: {
    updated: boolean
    transactionHash?: string
    currentAllowances: ServiceApprovalStatus
  }
}> {
  const {
    synapse,
    targetRunwayDays,
    targetDeposit,
    pieceSizeBytes,
    pricePerTiBPerEpoch,
    newDataSetCount = 0,
    mode = 'exact',
    allowWithdraw = true,
    ensureAllowances = false,
  } = options

  if (targetRunwayDays != null && targetDeposit != null) {
    throw new Error('Specify either targetRunwayDays or targetDeposit, not both')
  }

  if (targetRunwayDays == null && targetDeposit == null) {
    throw new Error('A funding target is required')
  }

  let allowanceStatus: {
    updated: boolean
    transactionHash?: string
    currentAllowances: ServiceApprovalStatus
  } | null = null

  if (ensureAllowances) {
    allowanceStatus = await checkAndSetAllowances(synapse)
  }

  const [status, accountSummary] = await Promise.all([getPaymentStatus(synapse), synapse.payments.accountSummary({})])

  const allowances = allowanceStatus ?? {
    updated: false,
    currentAllowances: status.currentAllowances,
  }

  const isCalibnet = status.chainId === calibration.id
  const hasSufficientGas = status.filBalance >= MIN_FIL_FOR_GAS
  const validation = validatePaymentRequirements(hasSufficientGas, status.walletUsdfcBalance, isCalibnet)
  if (!validation.isValid) {
    const help = validation.helpMessage ? ` ${validation.helpMessage}` : ''
    throw new Error(`${validation.errorMessage}${help}`)
  }

  let pricing = pricePerTiBPerEpoch
  if (pieceSizeBytes != null && pricing == null) {
    const storageInfo = await synapse.storage.getStorageInfo()
    pricing = storageInfo.pricing.noCDN.perTiBPerEpoch
  }

  const plan = calculateFilecoinPayFundingPlan({
    status,
    accountSummary,
    targetRunwayDays,
    targetDeposit,
    pieceSizeBytes,
    pricePerTiBPerEpoch: pricing,
    newDataSetCount,
    mode,
    allowWithdraw,
  })

  return {
    plan,
    status,
    accountSummary,
    allowances,
  }
}

/**
 * Execute a Filecoin Pay funding plan by depositing or withdrawing USDFC.
 *
 * - No-op when `plan.delta` is 0 (returns projected insights unchanged).
 * - Deposits when delta > 0, withdraws when delta < 0.
 * - Returns updated balances/runway after execution.
 *
 * @param synapse - Initialized Synapse instance
 * @param plan - Funding plan produced by calculate/plan helpers
 * @returns Execution result with transaction hash (if any) and updated insights
 */
export async function executeFilecoinPayFunding(
  synapse: Synapse,
  plan: FilecoinPayFundingPlan
): Promise<FilecoinPayFundingExecution> {
  if (plan.delta === 0n) {
    return {
      adjusted: false,
      delta: 0n,
      newDepositedAmount: plan.projected.depositedBalance,
      newRunwayDays: plan.projected.runway.runwayDays,
      newRunwayHours: plan.projected.runway.runwayHours,
      newCoverageDays: plan.projected.runway.coverageDays,
      newCoverageHours: plan.projected.runway.coverageHours,
      plan,
      updatedInsights: plan.projected,
    }
  }

  let transactionHash: string | undefined

  if (plan.delta > 0n) {
    const { depositTx } = await depositUSDFC(synapse, plan.delta)
    transactionHash = depositTx
  } else {
    transactionHash = await withdrawUSDFC(synapse, -plan.delta)
  }

  const [updatedStatus, updatedSummary] = await Promise.all([
    getPaymentStatus(synapse),
    synapse.payments.accountSummary({}),
  ])
  const updatedInsights = getFilecoinPayFundingInsights(updatedStatus, updatedSummary)

  return {
    adjusted: true,
    delta: plan.delta,
    transactionHash,
    newDepositedAmount: updatedStatus.filecoinPayBalance,
    newRunwayDays: updatedInsights.runway.runwayDays,
    newRunwayHours: updatedInsights.runway.runwayHours,
    newCoverageDays: updatedInsights.runway.coverageDays,
    newCoverageHours: updatedInsights.runway.coverageHours,
    plan,
    updatedInsights,
  }
}
