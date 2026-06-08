/**
 * Synapse SDK Payment Operations
 *
 * This module demonstrates comprehensive payment operations using the Synapse SDK,
 * providing patterns for interacting with the Filecoin Onchain Cloud payment
 * system (Filecoin Pay).
 *
 * Key concepts demonstrated:
 * - Native FIL balance checking for gas fees
 * - ERC20 token (USDFC) balance management
 * - Two-step deposit process (approve + deposit)
 * - Service approval configuration for storage operators
 * - Storage capacity calculations from pricing
 *
 * @module synapse/payments
 */

import { DEFAULT_BUFFER_EPOCHS } from '@filoz/synapse-core/utils'
import {
  calculateAdditionalLockupRequired,
  calculateBufferAmount,
  calculateRunwayAmount,
  getServicePrice,
} from '@filoz/synapse-core/warm-storage'
import { calibration, SIZE_CONSTANTS, type Synapse, TIME_CONSTANTS, TOKENS } from '@filoz/synapse-sdk'
import { formatUnits, type Hash } from 'viem'
import { getClientAddress, isSessionKeyMode } from '../synapse/index.js'
import { formatFIL } from '../utils/format.js'
import { assertPriceNonZero } from '../utils/validate-pricing.js'
import {
  DEFAULT_LOCKUP_DAYS,
  MAX_LOCKUP_ALLOWANCE,
  MAX_RATE_ALLOWANCE,
  MIN_FIL_FOR_GAS,
  STORAGE_SCALE_MAX,
  STORAGE_SCALE_MAX_BI,
  USDFC_DECIMALS,
} from './constants.js'
import type {
  AccountSummary,
  PaymentCapacityCheck,
  PaymentStatus,
  PaymentValidationResult,
  ServiceApprovalStatus,
  StorageAllowances,
} from './types.js'
import { padSizeToPDPLeaves } from './utils.js'

// Re-export SDK helpers used by downstream consumers (e.g. upload-action)
export { getServicePrice } from '@filoz/synapse-core/warm-storage'
// Re-export all constants
export * from './constants.js'
export * from './funding.js'
export * from './runway.js'
export * from './top-up.js'
export * from './types.js'

/**
 * Compute adaptive integer scaling for a TiB value so that
 * Math.floor(storageTiB * scale) stays within Number.MAX_SAFE_INTEGER.
 * This allows us to handle numbers as small as 1/10_000_000 TiB and as large as Number.MAX_SAFE_INTEGER TiB (> 1 YiB)
 */
export function getStorageScale(storageTiB: number): number {
  if (storageTiB <= 0) return 1
  const maxScaleBySafe = Math.floor(Number.MAX_SAFE_INTEGER / storageTiB)
  return Math.max(1, Math.min(STORAGE_SCALE_MAX, maxScaleBySafe))
}

/**
 * Check FIL balance for gas fees
 *
 * Example usage:
 * ```typescript
 * const synapse = await Synapse.create({ privateKey, rpcURL })
 * const filStatus = await checkFILBalance(synapse)
 *
 * if (filStatus.balance === 0n) {
 *   console.log('Account does not exist on-chain or has no FIL')
 * } else if (!filStatus.hasSufficientGas) {
 *   console.log('Insufficient FIL for gas fees')
 * }
 * ```
 *
 * @param synapse - Initialized Synapse instance
 * @returns Balance information and network type
 */
export async function checkFILBalance(synapse: Synapse): Promise<{
  balance: bigint
  isCalibnet: boolean
  hasSufficientGas: boolean
}> {
  const isCalibnet = synapse.chain.id === calibration.id

  try {
    const balance = await synapse.payments.walletBalance({ token: TOKENS.FIL })
    const hasSufficientGas = balance >= MIN_FIL_FOR_GAS

    return {
      balance,
      isCalibnet,
      hasSufficientGas,
    }
  } catch (_error) {
    // Account doesn't exist or network error
    return {
      balance: 0n,
      isCalibnet,
      hasSufficientGas: false,
    }
  }
}

/**
 * Check USDFC token balance in wallet
 *
 * Example usage:
 * ```typescript
 * const synapse = await Synapse.create({ privateKey, rpcURL })
 * const walletUsdfcBalance = await checkUSDFCBalance(synapse)
 *
 * if (walletUsdfcBalance === 0n) {
 *   console.log('No USDFC tokens found')
 * } else {
 *   const formatted = formatUnits(walletUsdfcBalance, USDFC_DECIMALS)
 *   console.log(`USDFC Balance: ${formatted}`)
 * }
 * ```
 *
 * @param synapse - Initialized Synapse instance
 * @returns bigint USDFC balance in wallet (0 if account doesn't exist or has no balance)
 */
export async function checkUSDFCBalance(synapse: Synapse): Promise<bigint> {
  try {
    // Get wallet balance (not deposited balance)
    const balance = await synapse.payments.walletBalance({ token: TOKENS.USDFC })
    return balance
  } catch (_error) {
    // Account doesn't exist, has no FIL for gas, or contract call failed
    // Treat as having 0 USDFC
    return 0n
  }
}

/**
 * Get gross deposited USDFC balance in the Payments contract.
 *
 * Returns `accountInfo.funds`: the total amount deposited, including funds
 * currently reserved by rails as lockup. This is NOT the net available balance
 * (use `accountSummary.availableFunds` for funds free above lockup).
 *
 * @param synapse - Initialized Synapse instance
 * @returns Gross deposited USDFC balance in its smallest unit
 */
export async function getDepositedBalance(synapse: Synapse): Promise<bigint> {
  const accountInfo = await synapse.payments.accountInfo({ token: TOKENS.USDFC })
  return accountInfo.funds
}

/**
 * Get current payment status including all balances and approvals
 *
 * Example usage:
 * ```typescript
 * const status = await getPaymentStatus(synapse)
 * console.log(`Address: ${status.address}`)
 * console.log(`FIL Balance: ${formatUnits(status.filBalance, 18)}`)
 * console.log(`USDFC Balance: ${formatUnits(status.walletUsdfcBalance, 18)}`)
 * console.log(`Deposited: ${formatUnits(status.filecoinPayBalance, 18)}`)
 * ```
 *
 * @param synapse - Initialized Synapse instance
 * @returns Complete payment status
 */
export async function getPaymentStatus(synapse: Synapse): Promise<PaymentStatus> {
  const network = synapse.chain.name
  const fwssAddress = synapse.chain.contracts.fwss.address
  const address = getClientAddress(synapse)

  // Run all async operations in parallel for efficiency
  const [filStatus, walletUsdfcBalance, filecoinPayBalance, currentAllowances] = await Promise.all([
    checkFILBalance(synapse),
    checkUSDFCBalance(synapse),
    getDepositedBalance(synapse),
    synapse.payments.serviceApproval({ service: fwssAddress }),
  ])

  return {
    network,
    chainId: synapse.chain.id,
    address,
    filBalance: filStatus.balance,
    walletUsdfcBalance,
    filecoinPayBalance,
    currentAllowances,
  }
}

export function getUsdfcAcquisitionHelpMessage(isCalibnet: boolean): string {
  if (isCalibnet) {
    return 'Get test USDFC from: https://docs.secured.finance/usdfc-stablecoin/getting-started/getting-test-usdfc-on-testnet'
  }

  return [
    'Bridge USDFC to Filecoin mainnet: https://app.usdfc.net/#/bridge',
    'Or swap FIL -> USDFC on Sushi: https://www.sushi.com/filecoin/swap?token0=NATIVE&token1=0x80b98d3aa09ffff255c3ba4a241111ff1262f045',
    'Minting guide: https://docs.secured.finance/usdfc-stablecoin/getting-started/minting-usdfc-step-by-step',
  ].join('\n  ')
}

/**
 * Validate that the wallet holds enough FIL to pay gas for transactions
 *
 * The failure message includes the current balance, the required minimum,
 * and the shortfall so users know exactly how much FIL to add.
 *
 * @param filBalance - Wallet FIL balance in attoFIL
 * @param isCalibnet - Whether the network is Calibration testnet
 */
export function validateGasRequirement(filBalance: bigint, isCalibnet: boolean): PaymentValidationResult {
  if (filBalance < MIN_FIL_FOR_GAS) {
    const result: PaymentValidationResult = {
      isValid: false,
      errorMessage:
        `Insufficient FIL for gas fees (balance: ${formatFIL(filBalance, isCalibnet)}, ` +
        `minimum: ${formatFIL(MIN_FIL_FOR_GAS, isCalibnet)}, ` +
        `add at least: ${formatFIL(MIN_FIL_FOR_GAS - filBalance, isCalibnet)})`,
    }
    if (isCalibnet) {
      result.helpMessage = 'Get test FIL from: https://faucet.calibnet.chainsafe-fil.io/'
    }
    return result
  }

  return { isValid: true }
}

/**
 * Validate that the wallet can fund payment transactions: FIL for gas plus
 * USDFC to deposit
 *
 * Only call this when the current operation will actually send transactions
 * that spend wallet USDFC. For operations that spend gas alone (e.g. an
 * allowance update), use {@link validateGasRequirement} so accounts that
 * hold all their USDFC as deposits are not rejected.
 *
 * @param filBalance - Wallet FIL balance in attoFIL
 * @param walletUsdfcBalance - Wallet USDFC balance (18 decimals)
 * @param isCalibnet - Whether the network is Calibration testnet
 */
export function validatePaymentRequirements(
  filBalance: bigint,
  walletUsdfcBalance: bigint,
  isCalibnet: boolean
): PaymentValidationResult {
  const gasCheck = validateGasRequirement(filBalance, isCalibnet)
  if (!gasCheck.isValid) {
    return gasCheck
  }

  if (walletUsdfcBalance === 0n) {
    return {
      isValid: false,
      errorMessage: 'No USDFC tokens found',
      helpMessage: getUsdfcAcquisitionHelpMessage(isCalibnet),
    }
  }

  return { isValid: true }
}

/**
 * Deposit USDFC into the Payments contract
 *
 * This demonstrates the single-step process required for depositing ERC20 tokens:
 * 1. If approval is insufficient, use permit to approve and deposit in one transaction
 * 2. If approval is sufficient, directly call deposit
 *
 * Example usage:
 * ```typescript
 * const amountToDeposit = parseUnits('100', 18) // 100 USDFC
 * const { depositTx } = await depositUSDFC(synapse, amountToDeposit)
 * console.log(`Deposit transaction: ${depositTx}`)
 * ```
 *
 * @param synapse - Initialized Synapse instance
 * @param amount - Amount to deposit in USDFC (with decimals)
 * @returns Transaction hashes for approval and deposit
 */
export async function depositUSDFC(
  synapse: Synapse,
  amount: bigint
): Promise<{
  depositTx: string
}> {
  const needsAllowanceUpdate = (await checkAllowances(synapse)).needsUpdate
  const amountMoreThanCurrentAllowance =
    (await synapse.payments.allowance({ spender: synapse.chain.contracts.filecoinPay.address })) < amount

  let txHash: Hash

  if (amountMoreThanCurrentAllowance || needsAllowanceUpdate) {
    txHash = await synapse.payments.depositWithPermitAndApproveOperator({
      amount,
      operator: synapse.chain.contracts.fwss.address,
      rateAllowance: MAX_RATE_ALLOWANCE,
      lockupAllowance: MAX_LOCKUP_ALLOWANCE,
      maxLockupPeriod: BigInt(DEFAULT_LOCKUP_DAYS) * TIME_CONSTANTS.EPOCHS_PER_DAY,
    })
  } else {
    txHash = await synapse.payments.deposit({ amount })
  }

  await synapse.client.waitForTransactionReceipt({ hash: txHash })

  return { depositTx: txHash }
}

/**
 * Withdraw USDFC from the Payments contract back to the wallet
 *
 * Example usage:
 * ```typescript
 * const amountToWithdraw = parseUnits('10', 18) // 10 USDFC
 * const txHash = await withdrawUSDFC(synapse, amountToWithdraw)
 * console.log(`Withdraw transaction: ${txHash}`)
 * ```
 *
 * @param synapse - Initialized Synapse instance
 * @param amount - Amount to withdraw in USDFC (with decimals)
 * @returns Transaction hash for the withdrawal
 */
export async function withdrawUSDFC(synapse: Synapse, amount: bigint): Promise<string> {
  const txHash = await synapse.payments.withdraw({ amount })
  await synapse.client.waitForTransactionReceipt({ hash: txHash })
  return txHash
}

/**
 * Set service approvals for WarmStorage operator
 *
 * This authorizes the WarmStorage contract to create payment rails on behalf
 * of the user. The approval consists of three parameters:
 * - Rate allowance: Maximum payment rate per epoch (30 seconds)
 * - Lockup allowance: Maximum funds that can be locked at once
 * - Max lockup period: How far in advance funds can be locked (in epochs)
 *
 * Example usage:
 * ```typescript
 * // Allow up to 10 USDFC per epoch rate, 1000 USDFC total lockup
 * const rate = parseUnits('10', 18)
 * const lockup = parseUnits('1000', 18)
 * const txHash = await setServiceApprovals(synapse, rate, lockup)
 * console.log(`Approval transaction: ${txHash}`)
 * ```
 *
 * @param synapse - Initialized Synapse instance
 * @param rateAllowance - Maximum rate per epoch in USDFC
 * @param lockupAllowance - Maximum lockup amount in USDFC
 * @returns Transaction hash
 */
export async function setServiceApprovals(
  synapse: Synapse,
  rateAllowance: bigint,
  lockupAllowance: bigint
): Promise<string> {
  const fwssAddress = synapse.chain.contracts.fwss.address

  // Max lockup period is always 30 days worth of epochs for WarmStorage
  const maxLockupPeriod = BigInt(DEFAULT_LOCKUP_DAYS) * TIME_CONSTANTS.EPOCHS_PER_DAY

  // Set the service approval
  const txHash = await synapse.payments.approveService({
    service: fwssAddress,
    rateAllowance,
    lockupAllowance,
    maxLockupPeriod,
  })

  await synapse.client.waitForTransactionReceipt({ hash: txHash })
  return txHash
}

/**
 * Check if WarmStorage allowances are at maximum
 *
 * This function checks whether the current allowances for WarmStorage
 * are already set to maximum values (effectively infinite).
 *
 * @param synapse - Initialized Synapse instance
 * @returns Current allowances and whether they need updating
 */
export async function checkAllowances(synapse: Synapse): Promise<{
  needsUpdate: boolean
  currentAllowances: ServiceApprovalStatus
}> {
  const fwssAddress = synapse.chain.contracts.fwss.address
  const currentAllowances = await synapse.payments.serviceApproval({ service: fwssAddress })

  // Mirror sdk's `isFwssMaxApproved` (lockupAllowance can decrement from CDN
  // one-time deductions, so compare against maxUint256/2n rather than equality).
  const isMaxApproved =
    currentAllowances.isApproved &&
    currentAllowances.rateAllowance === MAX_RATE_ALLOWANCE &&
    currentAllowances.lockupAllowance >= MAX_LOCKUP_ALLOWANCE / 2n &&
    currentAllowances.maxLockupPeriod >= BigInt(DEFAULT_LOCKUP_DAYS) * TIME_CONSTANTS.EPOCHS_PER_DAY

  return {
    needsUpdate: !isMaxApproved,
    currentAllowances,
  }
}

/**
 * Result of setting maximum allowances for WarmStorage
 */
export interface SetMaxAllowancesResult {
  /** Transaction hash of the allowance update */
  transactionHash: string
  /** Updated allowance status after the transaction */
  currentAllowances: ServiceApprovalStatus
}

/**
 * Set WarmStorage allowances to maximum
 *
 * This function sets the allowances for WarmStorage to maximum values,
 * effectively treating it as a fully trusted service.
 *
 * @param synapse - Initialized Synapse instance
 * @returns Transaction hash and updated allowances
 */
export async function setMaxAllowances(synapse: Synapse): Promise<SetMaxAllowancesResult> {
  const fwssAddress = synapse.chain.contracts.fwss.address

  // Set to maximum allowances
  const txHash = await setServiceApprovals(synapse, MAX_RATE_ALLOWANCE, MAX_LOCKUP_ALLOWANCE)
  const currentAllowances = await synapse.payments.serviceApproval({ service: fwssAddress })

  return {
    transactionHash: txHash,
    currentAllowances,
  }
}

/**
 * Check and automatically set WarmStorage allowances to maximum if needed
 *
 * This function treats WarmStorage as a fully trusted service and ensures
 * that rate and lockup allowances are always set to maximum values.
 * This simplifies the user experience by removing the need to understand
 * and configure complex allowance settings by assuming that WarmStorage
 * can be fully trusted to manage payments on the user's behalf.
 *
 * The function will:
 * 1. Check current allowances for WarmStorage
 * 2. If either is not at maximum, update them to MAX_UINT256
 * 3. Return information about what was done
 *
 * **Session Key Authentication**: When using session key authentication,
 * this function will not attempt to update allowances since payment
 * operations require the owner wallet to sign. The function will return
 * `updated: false` and current allowances, which may not be at maximum.
 *
 * Example usage:
 * ```typescript
 * // Call before any operation that requires payments
 * const result = await checkAndSetAllowances(synapse)
 * if (result.updated) {
 *   console.log(`Allowances updated: ${result.transactionHash}`)
 * }
 * ```
 *
 * @param synapse - Initialized Synapse instance
 * @returns Result indicating if allowances were updated and transaction hash if applicable
 */
export async function checkAndSetAllowances(synapse: Synapse): Promise<{
  updated: boolean
  transactionHash?: string
  currentAllowances: ServiceApprovalStatus
}> {
  // Skip automatic updates in session key mode
  const sessionKeyMode = isSessionKeyMode(synapse)

  const checkResult = await checkAllowances(synapse)

  if (checkResult.needsUpdate && !sessionKeyMode) {
    const setResult = await setMaxAllowances(synapse)
    return {
      updated: true,
      transactionHash: setResult.transactionHash,
      currentAllowances: setResult.currentAllowances,
    }
  }

  return {
    updated: false,
    currentAllowances: checkResult.currentAllowances,
  }
}

/**
 * Calculate storage allowances from TiB per month
 *
 * This utility converts human-friendly storage units (TiB/month) into the
 * epoch-based rates required by the payment system. It uses the actual
 * pricing from the storage service to calculate accurate allowances.
 *
 * Example usage:
 * ```typescript
 * const storageInfo = await synapse.storage.getStorageInfo()
 * const pricing = storageInfo.pricing.noCDN.perTiBPerEpoch
 *
 * // Calculate allowances for 10 TiB/month
 * const allowances = calculateStorageAllowances(10, pricing)
 * console.log(`Rate needed: ${formatUnits(allowances.rateAllowance, 18)} USDFC/epoch`)
 * ```
 *
 * @param storageTiB - Desired storage capacity in TiB/month
 * @param pricePerTiBPerEpoch - Current pricing from storage service
 * @returns Calculated allowances for the specified capacity
 */
export function calculateStorageAllowances(storageTiB: number, pricePerTiBPerEpoch: bigint): StorageAllowances {
  // Use adaptive scaling to avoid Number overflow/precision issues for very large values
  // and to preserve precision for small fractional values.
  const scale = getStorageScale(storageTiB)
  const scaledStorage = Math.floor(storageTiB * scale)
  // Calculate rate allowance (per epoch payment)
  const rateAllowance = (pricePerTiBPerEpoch * BigInt(scaledStorage)) / BigInt(scale)

  // Calculate lockup allowance
  const epochsInLockupDays = BigInt(DEFAULT_LOCKUP_DAYS) * TIME_CONSTANTS.EPOCHS_PER_DAY
  const lockupAllowance = rateAllowance * epochsInLockupDays

  return {
    rateAllowance,
    lockupAllowance,
    storageCapacityTiB: storageTiB,
  }
}

/**
 * Calculate actual storage capacity from current allowances
 *
 * This is the inverse of calculateStorageAllowances - it determines how much
 * storage capacity the current allowances support.
 *
 * @param rateAllowance - Current rate allowance in its smallest unit
 * @param pricePerTiBPerEpoch - Current pricing from storage service
 * @returns Storage capacity in TiB that can be supported
 */
export function calculateActualCapacity(rateAllowance: bigint, pricePerTiBPerEpoch: bigint): number {
  assertPriceNonZero(pricePerTiBPerEpoch)

  // Calculate TiB capacity from rate allowance
  const scaledQuotient = (rateAllowance * STORAGE_SCALE_MAX_BI) / pricePerTiBPerEpoch
  if (scaledQuotient > 0n) {
    return Number(scaledQuotient) / STORAGE_SCALE_MAX
  }

  // fallback for very small values that underflow to 0 after integer division
  const rateFloat = Number(formatUnits(rateAllowance, USDFC_DECIMALS))
  const priceFloat = Number(formatUnits(pricePerTiBPerEpoch, USDFC_DECIMALS))
  if (!Number.isFinite(rateFloat) || !Number.isFinite(priceFloat) || priceFloat === 0) {
    return 0
  }
  return rateFloat / priceFloat
}

/**
 * Calculate storage capacity from USDFC amount
 *
 * Determines how much storage can be purchased with a given USDFC amount,
 * accounting for the 30-day lockup period.
 *
 * @param usdfcAmount - Amount of USDFC in its smallest unit
 * @param pricePerTiBPerEpoch - Current pricing from storage service
 * @returns Storage capacity in TiB/month
 */
export function calculateStorageFromUSDFC(usdfcAmount: bigint, pricePerTiBPerEpoch: bigint): number {
  assertPriceNonZero(pricePerTiBPerEpoch)

  // Calculate how much this covers for lockup
  const epochsInLockupDays = BigInt(DEFAULT_LOCKUP_DAYS) * TIME_CONSTANTS.EPOCHS_PER_DAY
  const ratePerEpoch = usdfcAmount / epochsInLockupDays

  return calculateActualCapacity(ratePerEpoch, pricePerTiBPerEpoch)
}

/**
 * Compute the deposit-only top-up needed to reach `days` of net runway above the
 * current lockup. Never withdraws; thin clamp over `computeAdjustmentForExactDays`.
 *
 * @param accountSummary - SDK account summary (rate + lockup + debt)
 * @param filecoinPayBalance - Current deposited balance
 * @param days - Net runway days the deposit should cover
 */
export function computeTopUpForDuration(
  accountSummary: AccountSummary,
  filecoinPayBalance: bigint,
  days: number
): {
  topUp: bigint
  rateUsed: bigint
  perDay: bigint
  lockupUsed: bigint
} {
  const rateUsed = accountSummary.lockupRatePerEpoch
  const perDay = rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY
  const lockupUsed = accountSummary.totalLockup

  if (days <= 0 || rateUsed === 0n) {
    return { topUp: 0n, rateUsed, perDay, lockupUsed }
  }

  const { delta } = computeAdjustmentForExactDays(accountSummary, filecoinPayBalance, days)
  return { topUp: delta > 0n ? delta : 0n, rateUsed, perDay, lockupUsed }
}

/**
 * Compute the exact deposit adjustment for a target net runway in days.
 *
 * Target semantics: `days` = time until the next top-up is required at the
 * current spend rate (matches the "Top-up needed in" display metric).
 *
 * Returns a signed delta so callers can withdraw excess. Synapse SDK's
 * `calculateBufferAmount` would return 0n in the no-deposit branch, which
 * collapses the withdraw target onto bare lockup+runway. Forcing
 * `rawDepositNeeded > 0n` for the buffer call keeps the safety margin
 * symmetric across deposit and withdraw.
 *
 * @param accountSummary - SDK account summary (rate + lockup + debt)
 * @param filecoinPayBalance - Current deposited balance
 * @param days - Desired net runway in days
 */
export function computeAdjustmentForExactDays(
  accountSummary: AccountSummary,
  filecoinPayBalance: bigint,
  days: number
): {
  delta: bigint // >0 deposit, <0 withdraw, 0 none
  targetDeposit: bigint
  rateUsed: bigint
  perDay: bigint
  lockupUsed: bigint
} {
  if (days < 0) {
    throw new Error('days must be non-negative')
  }

  const rateUsed = accountSummary.lockupRatePerEpoch
  const lockupUsed = accountSummary.totalLockup
  const perDay = rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY

  if (rateUsed === 0n) {
    return {
      delta: 0n,
      targetDeposit: filecoinPayBalance,
      rateUsed,
      perDay,
      lockupUsed,
    }
  }

  const extraRunwayEpochs = BigInt(Math.floor(days)) * TIME_CONSTANTS.EPOCHS_PER_DAY
  const runway = calculateRunwayAmount({ netRateAfterUpload: rateUsed, extraRunwayEpochs })
  const rawDepositNeeded = runway + accountSummary.debt - accountSummary.availableFunds
  const buffer = calculateBufferAmount({
    rawDepositNeeded: rawDepositNeeded > 0n ? rawDepositNeeded : 1n,
    netRateAfterUpload: rateUsed,
    runwayInEpochs: accountSummary.runwayInEpochs,
    availableFunds: accountSummary.availableFunds,
    bufferEpochs: DEFAULT_BUFFER_EPOCHS,
  })

  const targetDeposit = lockupUsed + runway + buffer + accountSummary.debt
  const delta = targetDeposit - filecoinPayBalance

  return { delta, targetDeposit, rateUsed, perDay, lockupUsed }
}

/**
 * Compute the exact adjustment (deposit or withdraw) to reach a target absolute deposit.
 *
 * Clamps to not withdraw below the currently locked amount.
 */
export function computeAdjustmentForExactDeposit(
  accountSummary: AccountSummary,
  filecoinPayBalance: bigint,
  targetDeposit: bigint
): {
  delta: bigint // >0 deposit, <0 withdraw, 0 none
  clampedTarget: bigint
  lockupUsed: bigint
} {
  if (targetDeposit < 0n) throw new Error('target deposit cannot be negative')
  const lockupUsed = accountSummary.totalLockup
  const clampedTarget = targetDeposit < lockupUsed ? lockupUsed : targetDeposit
  const delta = clampedTarget - filecoinPayBalance
  return { delta, clampedTarget, lockupUsed }
}

/**
 * Compute adjustment to reach target net runway AFTER adding a new piece.
 *
 * Sybil fees are excluded here (`isNewDataSet: false`) because
 * `calculateFilecoinPayFundingPlan` adds `newDataSetCount * USDFC_SYBIL_FEE`
 * separately to cover multi-context uploads. CDN lockup is skipped because
 * filecoin-pin uploads use `noCDN` pricing.
 *
 * @param accountSummary - SDK account summary (current rate + lockup + debt)
 * @param filecoinPayBalance - Current deposited balance
 * @param days - Desired net runway in days after adding the piece
 * @param pieceSizeBytes - Piece file size in bytes
 * @param pricePerTiBPerEpoch - Current pricing from storage service
 */
export function computeAdjustmentForExactDaysWithPiece(
  accountSummary: AccountSummary,
  filecoinPayBalance: bigint,
  days: number,
  pieceSizeBytes: number,
  pricePerTiBPerEpoch: bigint,
  minimumPricePerMonth: bigint
): {
  delta: bigint // >0 deposit, <0 withdraw, 0 none
  targetDeposit: bigint
  currentDeposit: bigint
  newLockupUsed: bigint
  newRateUsed: bigint
} {
  if (days < 0) {
    throw new Error('days must be non-negative')
  }

  const paddedSizeBytes = padSizeToPDPLeaves(pieceSizeBytes)
  const pricePerTiBPerMonth = pricePerTiBPerEpoch * TIME_CONSTANTS.EPOCHS_PER_MONTH
  const lockup = calculateAdditionalLockupRequired({
    dataSize: BigInt(paddedSizeBytes),
    currentDataSetSize: 0n,
    pricePerTiBPerMonth,
    minimumPricePerMonth,
    isNewDataSet: false,
    withCDN: false,
  })

  const newRateUsed = accountSummary.lockupRatePerEpoch + lockup.rateDeltaPerEpoch
  const newLockupUsed = accountSummary.totalLockup + lockup.total

  if (newRateUsed === 0n) {
    const targetDeposit = newLockupUsed
    return {
      delta: targetDeposit - filecoinPayBalance,
      targetDeposit,
      currentDeposit: filecoinPayBalance,
      newLockupUsed,
      newRateUsed,
    }
  }

  const extraRunwayEpochs = BigInt(Math.floor(days)) * TIME_CONSTANTS.EPOCHS_PER_DAY
  const runway = calculateRunwayAmount({ netRateAfterUpload: newRateUsed, extraRunwayEpochs })
  const rawDepositNeeded = lockup.total + runway + accountSummary.debt - accountSummary.availableFunds
  const buffer = calculateBufferAmount({
    rawDepositNeeded: rawDepositNeeded > 0n ? rawDepositNeeded : 1n,
    netRateAfterUpload: newRateUsed,
    runwayInEpochs: accountSummary.runwayInEpochs,
    availableFunds: accountSummary.availableFunds,
    bufferEpochs: DEFAULT_BUFFER_EPOCHS,
  })

  const targetDeposit = newLockupUsed + runway + buffer + accountSummary.debt

  return {
    delta: targetDeposit - filecoinPayBalance,
    targetDeposit,
    currentDeposit: filecoinPayBalance,
    newLockupUsed,
    newRateUsed,
  }
}

/**
 * Calculate storage capacity from deposit amount
 *
 * This function calculates how much storage capacity a deposit can support,
 * treating WarmStorage as fully trusted with max allowances, i.e. not
 * accounting for allowance limits. If usage limits need to be accounted for
 * then the capacity can be capped by either deposit or allowances.
 * This function accounts for the 30-day lockup requirement.
 *
 * @param depositAmount - Amount deposited in USDFC
 * @param pricePerTiBPerEpoch - Current pricing from storage service
 * @returns Storage capacity information
 */
export function calculateDepositCapacity(
  depositAmount: bigint,
  pricePerTiBPerEpoch: bigint
): {
  tibPerMonth: number
  gibPerMonth: number
  monthlyPayment: bigint
  requiredLockup: bigint
  totalRequired: bigint
  isDepositSufficient: boolean
} {
  if (pricePerTiBPerEpoch === 0n) {
    return {
      tibPerMonth: 0,
      gibPerMonth: 0,
      monthlyPayment: 0n,
      requiredLockup: 0n,
      totalRequired: 0n,
      isDepositSufficient: true,
    }
  }

  const epochsInLockupDays = BigInt(DEFAULT_LOCKUP_DAYS) * TIME_CONSTANTS.EPOCHS_PER_DAY
  const epochsPerMonth = TIME_CONSTANTS.EPOCHS_PER_MONTH

  const maxRatePerEpoch = depositAmount / epochsInLockupDays
  const tibPerMonth = calculateActualCapacity(maxRatePerEpoch, pricePerTiBPerEpoch)
  const gibPerMonth = tibPerMonth * 1024

  const monthlyPayment = maxRatePerEpoch * epochsPerMonth
  const requiredLockup = maxRatePerEpoch * epochsInLockupDays

  return {
    tibPerMonth,
    gibPerMonth,
    monthlyPayment,
    requiredLockup,
    totalRequired: requiredLockup,
    isDepositSufficient: depositAmount >= requiredLockup,
  }
}

/**
 * Calculate required allowances from piece size
 *
 * Simple wrapper that converts piece size to storage allowances.
 *
 * @param pieceSizeBytes - Size of the piece (CAR, File, etc.) file in bytes
 * @param pricePerTiBPerEpoch - Current pricing from storage service
 * @returns Required allowances for the piece
 */
export function calculateRequiredAllowances(pieceSizeBytes: number, pricePerTiBPerEpoch: bigint): StorageAllowances {
  const paddedSizeBytes = padSizeToPDPLeaves(pieceSizeBytes)
  const storageTiB = paddedSizeBytes / Number(SIZE_CONSTANTS.TiB)
  return calculateStorageAllowances(storageTiB, pricePerTiBPerEpoch)
}

/**
 * Calculate piece upload deposit requirements
 *
 * @param status - Current payment status
 * @param pieceSizeBytes - Size of the piece (CAR, File, etc.) file in bytes
 * @param pricePerTiBPerEpoch - Current pricing from storage service
 * @returns Piece upload deposit requirements
 */
export function calculatePieceUploadRequirements(
  status: PaymentStatus,
  pieceSizeBytes: number,
  pricePerTiBPerEpoch: bigint,
  minimumPricePerMonth: bigint
): {
  required: StorageAllowances
  totalDepositNeeded: bigint
  insufficientDeposit: bigint
  canUpload: boolean
} {
  const paddedSizeBytes = padSizeToPDPLeaves(pieceSizeBytes)
  const pricePerTiBPerMonth = pricePerTiBPerEpoch * TIME_CONSTANTS.EPOCHS_PER_MONTH
  const lockup = calculateAdditionalLockupRequired({
    dataSize: BigInt(paddedSizeBytes),
    currentDataSetSize: 0n,
    pricePerTiBPerMonth,
    minimumPricePerMonth,
    isNewDataSet: false,
    withCDN: false,
  })
  const required: StorageAllowances = {
    rateAllowance: lockup.rateDeltaPerEpoch,
    lockupAllowance: lockup.rateLockupDelta,
    storageCapacityTiB: paddedSizeBytes / Number(SIZE_CONSTANTS.TiB),
  }
  const totalDepositNeeded = required.lockupAllowance

  // Check if current deposit can cover the new file's lockup requirement
  const insufficientDeposit =
    status.filecoinPayBalance < totalDepositNeeded ? totalDepositNeeded - status.filecoinPayBalance : 0n

  return {
    required,
    totalDepositNeeded,
    insufficientDeposit,
    canUpload: insufficientDeposit === 0n,
  }
}

/**
 * Validate payment capacity for a specific piece size
 *
 * This function checks if the deposit is sufficient for the piece upload. It
 * does not account for allowances since WarmStorage is assumed to be given
 * full trust with max allowances.
 *
 * **Note**: This function will attempt to automatically set max allowances
 * unless using session key authentication, in which case allowances must
 * be configured separately by the owner wallet.
 *
 * Example usage:
 * ```typescript
 * const fileSize = 10 * 1024 * 1024 * 1024 // 10 GiB
 * const capacity = await validatePaymentCapacity(synapse, fileSize)
 *
 * if (!capacity.canUpload) {
 *   console.error('Cannot upload file with current payment setup')
 *   capacity.suggestions.forEach(s => console.log(`  - ${s}`))
 * }
 * ```
 *
 * @param synapse - Initialized Synapse instance
 * @param pieceSizeBytes - Size of the piece (CAR, File, etc.) file in bytes
 * @returns Capacity check result
 */
export async function validatePaymentCapacity(synapse: Synapse, pieceSizeBytes: number): Promise<PaymentCapacityCheck> {
  // Ensure allowances are at max (automatically skips if in session key mode)
  await checkAndSetAllowances(synapse)

  const [status, storageInfo, servicePrice] = await Promise.all([
    getPaymentStatus(synapse),
    synapse.storage.getStorageInfo(),
    getServicePrice(synapse.client),
  ])

  const pricePerTiBPerEpoch = storageInfo.pricing.noCDN.perTiBPerEpoch
  const storageTiB = pieceSizeBytes / Number(SIZE_CONSTANTS.TiB)

  const uploadRequirements = calculatePieceUploadRequirements(
    status,
    pieceSizeBytes,
    pricePerTiBPerEpoch,
    servicePrice.minimumPricePerMonth
  )

  const result: PaymentCapacityCheck = {
    canUpload: uploadRequirements.canUpload,
    storageTiB,
    required: uploadRequirements.required,
    issues: {},
    suggestions: [],
  }

  // Only check deposit
  if (uploadRequirements.insufficientDeposit > 0n) {
    result.canUpload = false
    result.issues.insufficientDeposit = uploadRequirements.insufficientDeposit
    const depositNeeded = formatUnits(uploadRequirements.insufficientDeposit, 18)
    result.suggestions.push(`Deposit at least ${depositNeeded} USDFC`)
  }

  const totalLockupAfter = status.currentAllowances.lockupUsage + uploadRequirements.required.lockupAllowance
  if (totalLockupAfter > status.filecoinPayBalance && result.canUpload) {
    const additionalDeposit = formatUnits(totalLockupAfter - status.filecoinPayBalance, 18)
    result.suggestions.push(`Consider depositing ${additionalDeposit} more USDFC for safety margin`)
  }

  return result
}
