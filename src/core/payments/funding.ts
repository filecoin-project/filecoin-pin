import { calculateUploadFees, type getPriceList } from '@filoz/synapse-core/warm-storage'
import { calibration, type Synapse } from '@filoz/synapse-sdk'
import { USDFC_DECIMALS } from './constants.js'
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
import { toStorageRunwaySummary } from './runway.js'
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
 *
 * @param status - Current payment status
 * @param accountSummary - SDK account summary (rate + lockup + runway)
 * @param overrides - Optional overrides for projected scenarios
 * @returns Funding insights including runway and depletion predictions
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
      ? toStorageRunwaySummary(accountSummary)
      : toStorageRunwaySummary({
          funds: depositedBalance,
          lockupCurrent: lockupUsed,
          lockupRate: rateUsed,
        })

  const availableDeposited = runway.availableFunds
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
    priceList,
    newDataSetCount = 0,
    withCDN = false,
    mode = 'exact',
    allowWithdraw = true,
  } = options

  if (targetRunwayDays != null && targetDeposit != null) {
    throw new Error('Specify either targetRunwayDays or targetDeposit, not both')
  }

  if (targetRunwayDays == null && targetDeposit == null) {
    throw new Error('A funding target is required')
  }

  if (pieceSizeBytes != null && priceList == null) {
    throw new Error('priceList is required when pieceSizeBytes is provided')
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
      if (priceList == null) {
        throw new Error('priceList is required when planning with pieceSizeBytes')
      }
      const adjustment = computeAdjustmentForExactDaysWithPiece(
        accountSummary,
        status.filecoinPayBalance,
        targetRunwayDays,
        pieceSizeBytes,
        priceList
      )
      const uploadFees = calculateUploadFees({ priceList, isNewDataSet: true })
      const perNewDataSetCosts =
        uploadFees.total +
        priceList.lockups.lifecycleReserveTarget +
        (withCDN ? priceList.lockups.cdnLockupAmount + priceList.lockups.cacheMissLockupAmount : 0n)
      const newDataSetCosts = BigInt(newDataSetCount) * perNewDataSetCosts
      delta = adjustment.delta + newDataSetCosts
      resolvedTargetDeposit = adjustment.targetDeposit + newDataSetCosts
      projectedRateUsed = adjustment.newRateUsed
      projectedLockupUsed = adjustment.newLockupUsed

      // Determine reason: piece upload with or without runway
      if (targetRunwayDays === 0) {
        /**
         * Special case: targetRunwayDays === 0 means "fund this upload only" (no runway target).
         * Even with 0 days, onboarding a new piece can still require additional deposit to satisfy
         * the piece's lockup requirement (and the small safety buffer). If delta <= 0, no adjustment needed.
         */
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

      // Runway adjustment without piece
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
    ...(newDataSetCount > 0 ? { newDataSetCount } : {}),
    ...(walletShortfall != null ? { walletShortfall } : {}),
  }

  return plan
}

/** One USDFC in base units, kept as runway after the initial data sets are created. */
const ONE_USDFC = 10n ** BigInt(USDFC_DECIMALS)

/**
 * Work out how much `payments setup --auto` should deposit.
 *
 * Setting up the first data sets needs some funds to be available, meaning free
 * rather than already locked by active rails. Per data set, that requirement is
 * the create-data-set fee, the minimum monthly (per-data-set) price, and the
 * fixed CDN + cache-miss lockups the default (FilCDN) upload path needs, plus
 * one USDFC of runway. All of these are sourced from the on-chain price list.
 *
 * `availableFunds` is what the account already has free (the SDK reports it net
 * of lockup and debt). The deposit only needs to make up the difference, so the
 * target balance is the current balance plus that shortfall.
 *
 * @returns `requiredAvailableFunds` (how much must be free) and `targetBalance`
 *   (the Filecoin Pay balance to deposit up to).
 */
export function computeAutoSetupTargetBalance(params: {
  filecoinPayBalance: bigint
  availableFunds: bigint
  copies: number
  priceList: getPriceList.OutputType
}): { requiredAvailableFunds: bigint; targetBalance: bigint } {
  if (!Number.isInteger(params.copies) || params.copies < 0) {
    throw new Error('copies must be a non-negative integer')
  }
  const { rates, lockups } = params.priceList
  const uploadFees = calculateUploadFees({ priceList: params.priceList, isNewDataSet: true })
  const perDataSet =
    uploadFees.total +
    rates.datasetFeePerMonth +
    lockups.lifecycleReserveTarget +
    lockups.cdnLockupAmount +
    lockups.cacheMissLockupAmount
  const requiredAvailableFunds = BigInt(params.copies) * perDataSet + ONE_USDFC
  const shortfall = requiredAvailableFunds > params.availableFunds ? requiredAvailableFunds - params.availableFunds : 0n
  return { requiredAvailableFunds, targetBalance: params.filecoinPayBalance + shortfall }
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
  priceList?: getPriceList.OutputType | undefined
  newDataSetCount?: number | undefined
  withCDN?: boolean | undefined
  mode?: FundingMode | undefined
  allowWithdraw?: boolean | undefined
  ensureAllowances?: boolean | undefined
}

/**
 * Plan Filecoin Pay funding adjustments with network calls.
 *
 * This async function handles the full workflow:
 * - Fetches current payment status and SDK account summary in parallel
 * - Optionally ensures allowances are configured
 * - Validates payment requirements (FIL for gas, USDFC availability)
 * - Fetches pricing if needed
 * - Calculates funding plan via `calculateFilecoinPayFundingPlan`
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
    priceList: priceListOpt,
    newDataSetCount = 0,
    withCDN = false,
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
  const validation = validatePaymentRequirements(status.filBalance, status.walletUsdfcBalance, isCalibnet)
  if (!validation.isValid) {
    const help = validation.helpMessage ? ` ${validation.helpMessage}` : ''
    throw new Error(`${validation.errorMessage}${help}`)
  }

  let priceList = priceListOpt
  if (pieceSizeBytes != null && priceList == null) {
    const storageInfo = await synapse.storage.getStorageInfo()
    priceList = storageInfo.pricing.priceList
  }

  const plan = calculateFilecoinPayFundingPlan({
    status,
    accountSummary,
    targetRunwayDays,
    targetDeposit,
    pieceSizeBytes,
    priceList,
    newDataSetCount,
    withCDN,
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
