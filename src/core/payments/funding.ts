import type { Synapse } from '@filoz/synapse-sdk'
import { MIN_FIL_FOR_GAS } from './constants.js'
import {
  calculateStorageRunway,
  checkAndSetAllowances,
  computeAdjustmentForExactDays,
  computeAdjustmentForExactDaysWithPiece,
  computeAdjustmentForExactDeposit,
  depositUSDFC,
  getPaymentStatus,
  validatePaymentRequirements,
  withdrawUSDFC,
} from './index.js'
import type {
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
  available: bigint,
  perDay: bigint
): { seconds: bigint; timestampMs?: number | null } | null {
  if (available <= 0n || perDay <= 0n) {
    return null
  }

  const seconds = (available * 86_400n) / perDay
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
 * Internal helper to build funding insights from payment status
 */
function buildFilecoinPayFundingInsights(
  status: PaymentStatus,
  overrides?: { depositedBalance?: bigint; rateUsed?: bigint; lockupUsed?: bigint }
): FilecoinPayFundingInsights {
  const depositedBalance = overrides?.depositedBalance ?? status.filecoinPayBalance
  const rateUsed = overrides?.rateUsed ?? status.currentAllowances.rateUsed ?? 0n
  const lockupUsed = overrides?.lockupUsed ?? status.currentAllowances.lockupUsed ?? 0n

  const runway = calculateStorageRunway({
    filecoinPayBalance: depositedBalance,
    currentAllowances: {
      ...status.currentAllowances,
      rateUsed,
      lockupUsed,
    },
  })

  const availableDeposited = runway.available
  const filecoinPayDepletion = calculateDepletionTiming(availableDeposited, runway.perDay)
  const ownerDepletion = calculateDepletionTiming(availableDeposited + status.walletUsdfcBalance, runway.perDay)

  return {
    spendRatePerEpoch: rateUsed,
    spendRatePerDay: runway.perDay,
    depositedBalance,
    availableDeposited,
    walletUsdfcBalance: status.walletUsdfcBalance,
    runway,
    filecoinPayDepletionSeconds: filecoinPayDepletion?.seconds ?? null,
    filecoinPayDepletionTimestampMs: filecoinPayDepletion?.timestampMs ?? null,
    ownerDepletionSeconds: ownerDepletion?.seconds ?? null,
    ownerDepletionTimestampMs: ownerDepletion?.timestampMs ?? null,
  }
}

/**
 * Get funding insights for a payment status
 *
 * This function calculates runway projections, depletion times, and spend rates
 * based on current or projected balances and usage.
 *
 * @param status - Current payment status
 * @param overrides - Optional overrides for projected scenarios
 * @returns Funding insights including runway and depletion predictions
 */
export function getFilecoinPayFundingInsights(
  status: PaymentStatus,
  overrides?: { depositedBalance?: bigint; rateUsed?: bigint; lockupUsed?: bigint }
): FilecoinPayFundingInsights {
  return buildFilecoinPayFundingInsights(status, overrides)
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
      return 'Required funding'
  }
}

/**
 * Calculate a Filecoin Pay funding plan without making network calls
 *
 * This is a pure calculation function that determines what funding adjustments
 * are needed to reach a target. Use this when you already have PaymentStatus
 * and pricing information, or when you need synchronous calculation logic.
 *
 * For full workflow including network calls, allowance checks, and execution,
 * use planFilecoinPayFunding instead.
 *
 * @param options - Calculation options with payment status
 * @returns Funding plan with delta, action, and insights
 */
export function calculateFilecoinPayFundingPlan(options: FilecoinPayFundingPlanOptions): FilecoinPayFundingPlan {
  const {
    status,
    targetRunwayDays,
    targetDeposit,
    pieceSizeBytes,
    pricePerTiBPerEpoch,
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

  let delta = 0n
  let projectedDeposit = status.filecoinPayBalance
  let projectedRateUsed = status.currentAllowances.rateUsed ?? 0n
  let projectedLockupUsed = status.currentAllowances.lockupUsed ?? 0n
  let resolvedTargetDeposit: bigint | undefined
  let reasonCode: FundingReasonCode = 'none'
  const targetType = targetRunwayDays != null ? 'runway-days' : 'deposit'

  if (targetType === 'runway-days') {
    const days = targetRunwayDays ?? 0
    if (pieceSizeBytes != null) {
      if (pricePerTiBPerEpoch == null) {
        throw new Error('pricePerTiBPerEpoch is required when planning with pieceSizeBytes')
      }
      const adjustment = computeAdjustmentForExactDaysWithPiece(status, days, pieceSizeBytes, pricePerTiBPerEpoch)
      delta = adjustment.delta
      resolvedTargetDeposit = adjustment.targetDeposit
      projectedRateUsed = adjustment.newRateUsed
      projectedLockupUsed = adjustment.newLockupUsed

      // Determine reason: piece upload with or without runway
      if (days === 0) {
        reasonCode = delta > 0n ? 'piece-upload' : 'none'
      } else if (delta > 0n) {
        reasonCode = 'runway-with-piece'
      } else if (delta < 0n) {
        reasonCode = 'withdrawal-excess'
      }
    } else {
      const adjustment = computeAdjustmentForExactDays(status, days)
      delta = adjustment.delta
      projectedRateUsed = adjustment.rateUsed
      projectedLockupUsed = adjustment.lockupUsed
      resolvedTargetDeposit = status.filecoinPayBalance + delta

      // Runway adjustment without piece
      if (delta > 0n) {
        reasonCode = 'runway-insufficient'
      } else if (delta < 0n) {
        reasonCode = 'withdrawal-excess'
      }
    }
  } else {
    const adjustment = computeAdjustmentForExactDeposit(status, targetDeposit ?? 0n)
    delta = adjustment.delta
    resolvedTargetDeposit = adjustment.clampedTarget
    projectedLockupUsed = adjustment.lockupUsed

    // Target deposit adjustment
    if (delta > 0n) {
      reasonCode = 'target-deposit'
    } else if (delta < 0n) {
      reasonCode = 'withdrawal-excess'
    }
  }

  if (mode === 'minimum' && delta < 0n) {
    delta = 0n
    reasonCode = 'none' // Reset reason if we're not actually adjusting
  }

  if (!allowWithdraw && delta < 0n) {
    delta = 0n
    reasonCode = 'none' // Reset reason if we're not actually adjusting
  }

  const projectedDepositUnsafe = status.filecoinPayBalance + delta
  projectedDeposit = projectedDepositUnsafe > 0n ? projectedDepositUnsafe : 0n

  const walletShortfall =
    delta > 0n && delta > status.walletUsdfcBalance ? delta - status.walletUsdfcBalance : undefined

  const currentInsights = buildFilecoinPayFundingInsights(status)
  const projectedInsights = buildFilecoinPayFundingInsights(status, {
    depositedBalance: projectedDeposit,
    rateUsed: projectedRateUsed,
    lockupUsed: projectedLockupUsed,
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
    ...(walletShortfall != null ? { walletShortfall } : {}),
  }

  return plan
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
  targetRunwayDays?: number
  targetDeposit?: bigint
  pieceSizeBytes?: number
  pricePerTiBPerEpoch?: bigint
  mode?: FundingMode
  allowWithdraw?: boolean
  ensureAllowances?: boolean
}

/**
 * Plan Filecoin Pay funding adjustments with network calls
 *
 * This async function handles the full workflow:
 * - Fetches current payment status from chain
 * - Optionally ensures allowances are configured
 * - Validates payment requirements (FIL for gas, USDFC availability)
 * - Fetches pricing if needed
 * - Calculates funding plan using calculateFilecoinPayFundingPlan
 *
 * @param options - Planning options including synapse instance
 * @returns Plan with status and allowance information
 */
export async function planFilecoinPayFunding(options: PlanFilecoinPayFundingOptions): Promise<{
  plan: FilecoinPayFundingPlan
  status: PaymentStatus
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

  const status = await getPaymentStatus(synapse)

  const allowances = allowanceStatus ?? {
    updated: false,
    currentAllowances: status.currentAllowances,
  }

  const isCalibnet = status.network === 'calibration'
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

  // Delegate to pure calculation function
  const plan = calculateFilecoinPayFundingPlan({
    status,
    targetRunwayDays,
    targetDeposit,
    pieceSizeBytes,
    pricePerTiBPerEpoch: pricing,
    mode,
    allowWithdraw,
  })

  return {
    plan,
    status,
    allowances,
  }
}

export async function executeFilecoinPayFunding(
  synapse: Synapse,
  plan: FilecoinPayFundingPlan
): Promise<FilecoinPayFundingExecution> {
  if (plan.delta === 0n) {
    return {
      adjusted: false,
      delta: 0n,
      newDepositedAmount: plan.projected.depositedBalance,
      newRunwayDays: plan.projected.runway.days,
      newRunwayHours: plan.projected.runway.hours,
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

  const updatedStatus = await getPaymentStatus(synapse)
  const updatedInsights = buildFilecoinPayFundingInsights(updatedStatus)

  return {
    adjusted: true,
    delta: plan.delta,
    transactionHash,
    newDepositedAmount: updatedStatus.filecoinPayBalance,
    newRunwayDays: updatedInsights.runway.days,
    newRunwayHours: updatedInsights.runway.hours,
    plan,
    updatedInsights,
  }
}
