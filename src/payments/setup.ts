/**
 * Payment setup utilities and display functions
 *
 * This module provides UI utilities and display functions for payment setup,
 * building on the core payment operations from synapse/payments.
 */

import { TIME_CONSTANTS } from '@filoz/synapse-sdk'
import { ethers } from 'ethers'
import pc from 'picocolors'
import {
  calculateActualCapacity,
  calculateStorageAllowances,
  calculateStorageFromUSDFC,
  checkFILBalance,
  checkUSDFCBalance,
  depositUSDFC,
  getPaymentStatus,
  setServiceApprovals,
} from '../synapse/payments.js'
import { log } from '../utils/cli-logger.js'

// Re-export core payment functions for backward compatibility
export {
  calculateActualCapacity,
  calculateStorageAllowances,
  calculateStorageFromUSDFC,
  checkFILBalance,
  checkUSDFCBalance,
  depositUSDFC,
  getPaymentStatus,
  setServiceApprovals,
}

// Display constants
const USDFC_DECIMALS = 18
const DEFAULT_LOCKUP_DAYS = 10

/**
 * Parse storage allowance string
 *
 * Parses different storage allowance formats:
 * - "1TiB/month" or "500GiB/month" - Human-friendly storage units
 * - "0.0000565" - Direct USDFC per epoch (returns null, needs price lookup)
 *
 * @param input - Storage allowance string
 * @returns Parsed TiB per month or null if it's a direct USDFC amount
 */
export function parseStorageAllowance(input: string): number | null {
  // Check if input is a storage unit (e.g., "1TiB/month", "500GiB/month")
  const storageMatch = input.match(/^(\d+(?:\.\d+)?)\s*(TiB|GiB|MiB)\/month$/i)

  if (storageMatch?.[1] && storageMatch[2]) {
    const amount = parseFloat(storageMatch[1])
    const unit = storageMatch[2].toUpperCase()

    // Convert to TiB
    let tibPerMonth: number
    switch (unit) {
      case 'TIB':
        tibPerMonth = amount
        break
      case 'GIB':
        tibPerMonth = amount / 1024
        break
      case 'MIB':
        tibPerMonth = amount / (1024 * 1024)
        break
      default:
        throw new Error(`Unknown storage unit: ${unit}`)
    }

    return tibPerMonth
  }

  // Validate that it's a valid number for USDFC per epoch
  try {
    ethers.parseUnits(input, USDFC_DECIMALS)
    return null // Valid USDFC amount, but need pricing to convert to TiB
  } catch {
    throw new Error(
      `Invalid storage allowance format: ${input}. Use "1TiB/month", "500GiB/month", or a decimal number for USDFC per epoch (e.g., "0.0000565")`
    )
  }
}

/**
 * Format USDFC amount for display
 *
 * @param amount - Amount in wei (18 decimals)
 * @param decimals - Number of decimal places to show
 * @returns Formatted string
 */
export function formatUSDFC(amount: bigint, decimals = 4): string {
  const formatted = ethers.formatUnits(amount, USDFC_DECIMALS)
  const num = parseFloat(formatted)

  // If the number rounds to 0 with the requested decimals, show more
  if (num > 0 && num < 10 ** -decimals) {
    // Find how many decimals we need to show a non-zero value
    let testDecimals = decimals
    while (testDecimals < 10 && parseFloat(num.toFixed(testDecimals)) === 0) {
      testDecimals++
    }
    return num.toFixed(testDecimals)
  }

  return num.toFixed(decimals)
}

/**
 * Display the payment status summary
 *
 * Shows three sections: Wallet, Filecoin Pay Deposit, and WarmStorage Service Permissions
 *
 * @param network - Network name
 * @param filBalance - FIL balance in wei
 * @param isCalibnet - Whether this is calibnet testnet
 * @param usdfcBalance - USDFC balance in wei
 * @param depositedAmount - Amount deposited in Filecoin Pay
 * @param rateAllowance - Maximum rate per epoch
 * @param lockupAllowance - Maximum lockup amount
 * @param pricePerTiBPerEpoch - Current storage price
 */
export function displayPaymentSummary(
  network: string,
  filBalance: bigint,
  isCalibnet: boolean,
  usdfcBalance: bigint,
  depositedAmount: bigint,
  rateAllowance: bigint,
  lockupAllowance: bigint,
  pricePerTiBPerEpoch: bigint
): void {
  // Start the summary section (Setup Complete is shown by spinner in auto mode)
  log.line(`Network: ${pc.bold(network)}`)
  log.line('')
  // Section 1: Wallet
  log.line(pc.bold('Wallet'))
  log.indent(formatFIL(filBalance, isCalibnet))
  log.indent(`${formatUSDFC(usdfcBalance)} USDFC`)
  log.line('')
  // Section 2: Filecoin Pay deposit
  log.line(pc.bold('Filecoin Pay Deposit'))
  log.indent(`${formatUSDFC(depositedAmount)} USDFC`)
  log.indent(pc.gray('(spendable on any service)'))

  // Section 3: WarmStorage service permissions
  log.line('')
  if (rateAllowance > 0n) {
    const monthlyRate = rateAllowance * TIME_CONSTANTS.EPOCHS_PER_MONTH
    displayServicePermissions(
      'Your WarmStorage Service Limits',
      monthlyRate,
      lockupAllowance,
      depositedAmount,
      pricePerTiBPerEpoch,
      false
    )
  } else {
    log.line(pc.bold('Your WarmStorage Service Limits'))
    log.indent(pc.gray('No limits set'))
  }
  log.flush() // Flush everything at the end
}

/**
 * Display account and balance information
 *
 * @param address - Wallet address
 * @param network - Network name (mainnet/calibration)
 * @param filBalance - FIL balance in wei
 * @param isCalibnet - Whether on calibration testnet
 * @param hasSufficientGas - Whether wallet has enough FIL for gas
 * @param usdfcBalance - USDFC balance in wei
 * @param depositedAmount - Amount deposited to Filecoin Pay
 */
export function displayAccountInfo(
  address: string,
  network: string,
  filBalance: bigint,
  isCalibnet: boolean,
  _hasSufficientGas: boolean,
  usdfcBalance: bigint,
  depositedAmount: bigint
): void {
  log.line(pc.bold('Account:'))
  log.indent(pc.gray(`Wallet: ${address}`))
  log.indent(pc.gray(`Network: ${network}`))
  log.line(pc.bold('Balances:'))
  log.indent(pc.gray(`FIL: ${formatFIL(filBalance, isCalibnet)}`))
  log.indent(pc.gray(`USDFC wallet: ${formatUSDFC(usdfcBalance)} USDFC`))
  log.indent(pc.gray(`USDFC deposited: ${formatUSDFC(depositedAmount)} USDFC`))
  log.flush()
}

/**
 * Check and handle insufficient funds
 *
 * @param hasSufficientGas - Whether wallet has enough FIL for gas
 * @param usdfcBalance - USDFC balance in wei
 * @param isCalibnet - Whether on calibration testnet
 * @param exitOnError - Whether to exit the process on error (for auto mode)
 * @returns true if funds are sufficient, false if not
 */
export function checkInsufficientFunds(
  hasSufficientGas: boolean,
  usdfcBalance: bigint,
  isCalibnet: boolean,
  exitOnError: boolean = false
): boolean {
  if (!hasSufficientGas) {
    console.error(pc.red('✗ Insufficient FIL for gas fees'))
    if (isCalibnet) {
      log.message(pc.yellow('Get test FIL from: https://faucet.calibnet.chainsafe-fil.io/'))
    }
    if (exitOnError) {
      process.exit(1)
    }
    return false
  }

  if (usdfcBalance === 0n) {
    console.error(pc.red('✗ No USDFC tokens found'))
    if (isCalibnet) {
      log.message(
        pc.yellow(
          'Get test USDFC from: https://docs.secured.finance/usdfc-stablecoin/getting-started/getting-test-usdfc-on-testnet'
        )
      )
    } else {
      log.message(
        pc.yellow(
          'Mint USDFC with FIL: https://docs.secured.finance/usdfc-stablecoin/getting-started/minting-usdfc-step-by-step'
        )
      )
    }
    if (exitOnError) {
      process.exit(1)
    }
    return false
  }

  return true
}

/**
 * Display deposit warning if balance is too low for active storage
 *
 * Warns when the available deposit (total deposit minus locked amount)
 * is insufficient to maintain active storage operations.
 *
 * @param depositedAmount - Current deposit balance
 * @param lockupUsed - Amount currently locked for active storage
 */
export function displayDepositWarning(depositedAmount: bigint, lockupUsed: bigint): void {
  if (lockupUsed > 0n) {
    // Calculate available deposit after accounting for locked funds
    const availableDeposit = depositedAmount - lockupUsed

    // Warn if available deposit is too low (less than 10% of lockup as safety margin)
    const safetyMargin = lockupUsed / 10n // 10% safety margin

    if (availableDeposit < safetyMargin) {
      const needed = lockupUsed + safetyMargin - depositedAmount
      log.newline()
      log.message(pc.yellow(`⚠ Warning: Low deposit balance`))
      log.indent(pc.yellow(`Your deposit: ${formatUSDFC(depositedAmount)} USDFC`))
      log.indent(pc.yellow(`Amount locked: ${formatUSDFC(lockupUsed)} USDFC`))
      log.indent(pc.yellow(`Available: ${formatUSDFC(availableDeposit > 0n ? availableDeposit : 0n)} USDFC`))
      log.indent(pc.yellow(`Deposit at least ${formatUSDFC(needed)} more USDFC to maintain safety margin`))
      log.indent(pc.gray(`Without sufficient deposit, storage may be terminated`))
    }
  }
}

/**
 * Format storage capacity with smart unit selection
 *
 * @param gib - Capacity in GiB
 * @returns Formatted string with appropriate unit
 */
function formatStorageCapacity(gib: number): string {
  if (gib >= 1024) {
    const tib = gib / 1024
    // Use 1 decimal place if under 100 TiB
    if (tib < 100) {
      return `${tib.toFixed(1)} TiB/month`
    }
    return `${Math.round(tib).toLocaleString()} TiB/month`
  }
  // Use 1 decimal place if under 100 GiB
  if (gib < 100) {
    return `${gib.toFixed(1)} GiB/month`
  }
  return `${Math.round(gib).toLocaleString()} GiB/month`
}

/**
 * Helper to calculate storage capacity in GiB from allowances
 */
function calculateStorageCapacity(rateAllowance: bigint, lockupAllowance: bigint, pricePerTiBPerEpoch: bigint): number {
  const tibFromRate = Number((rateAllowance * 10000n) / pricePerTiBPerEpoch) / 10000
  const defaultLockupEpochs = BigInt(DEFAULT_LOCKUP_DAYS) * TIME_CONSTANTS.EPOCHS_PER_DAY
  const maxRateFromLockup = lockupAllowance / defaultLockupEpochs
  const tibFromLockup = Number((maxRateFromLockup * 10000n) / pricePerTiBPerEpoch) / 10000
  const tibPerMonth = Math.min(tibFromRate, tibFromLockup * 3)
  const gibPerMonth = tibPerMonth * 1024
  return gibPerMonth
}

/**
 * Calculate actual capacity with deposit limitations
 */
function calculateActualCapacityWithDeposit(
  depositedAmount: bigint,
  rateAllowance: bigint,
  lockupAllowance: bigint,
  pricePerTiBPerEpoch: bigint
): {
  actualGiB: number
  potentialGiB: number
  isDepositLimited: boolean
  additionalDepositNeeded: bigint
} {
  const potentialGiB = calculateStorageCapacity(rateAllowance, lockupAllowance, pricePerTiBPerEpoch)
  const requiredLockup = lockupAllowance
  const monthlyPayment = rateAllowance * TIME_CONSTANTS.EPOCHS_PER_MONTH
  const requiredDeposit = requiredLockup + monthlyPayment

  let actualGiB: number
  let isDepositLimited = false
  let additionalDepositNeeded = 0n

  if (depositedAmount >= requiredDeposit) {
    actualGiB = potentialGiB
  } else {
    isDepositLimited = true
    additionalDepositNeeded = requiredDeposit - depositedAmount
    const scaleFactor = Number((depositedAmount * 1000n) / requiredDeposit) / 1000
    actualGiB = potentialGiB * scaleFactor
  }

  return {
    actualGiB: Math.floor(actualGiB),
    potentialGiB: Math.floor(potentialGiB),
    isDepositLimited,
    additionalDepositNeeded,
  }
}

/**
 * Display capacity information based on deposit and limits
 *
 * @param capacity - Calculated capacity information
 */
export function displayCapacity(capacity: ReturnType<typeof calculateActualCapacityWithDeposit>): void {
  if (capacity.isDepositLimited) {
    log.indent(`→ Current capacity: ~${formatStorageCapacity(capacity.actualGiB)} ${pc.yellow('(deposit-limited)')}`)
    log.indent(
      `→ Potential: ~${formatStorageCapacity(capacity.potentialGiB)} (deposit ${formatUSDFC(capacity.additionalDepositNeeded)} more)`
    )
  } else {
    log.indent(`→ Estimated capacity: ~${formatStorageCapacity(capacity.actualGiB)}`)
    log.indent(pc.gray('  (excludes data set creation fee and optional CDN add-on rates)'))
  }
}

/**
 * Display current pricing information
 *
 * @param pricePerGiBPerMonth - Price per GiB per month
 * @param pricePerTiBPerMonth - Price per TiB per month
 */
export function displayPricing(pricePerGiBPerMonth: bigint, pricePerTiBPerMonth: bigint): void {
  log.line(pc.bold('Current Pricing:'))
  log.indent(`1 GiB/month: ${formatUSDFC(pricePerGiBPerMonth)} USDFC`)
  log.indent(`1 TiB/month: ${formatUSDFC(pricePerTiBPerMonth)} USDFC`)
  log.indent(pc.gray('(for each upload, WarmStorage service will reserve 10 days of costs as security)'))
  log.flush()
}

/**
 * Display WarmStorage service permissions with capacity information
 *
 * @param title - Section title to display
 * @param monthlyRate - Rate allowance in USDFC per month
 * @param lockupAmount - Lockup allowance amount
 * @param depositAmount - Total deposited amount
 * @param pricePerTiBPerEpoch - Current pricing per TiB per epoch
 */
export function displayServicePermissions(
  title: string,
  monthlyRate: bigint,
  lockupAmount: bigint,
  depositAmount: bigint,
  pricePerTiBPerEpoch: bigint,
  shouldFlush: boolean = true
): void {
  // Calculate capacity
  const ratePerEpoch = monthlyRate / TIME_CONSTANTS.EPOCHS_PER_MONTH
  const capacity = calculateActualCapacityWithDeposit(depositAmount, ratePerEpoch, lockupAmount, pricePerTiBPerEpoch)

  log.line(pc.bold(title))
  log.indent(`Max payment: ${formatUSDFC(monthlyRate)} USDFC/month`)
  log.indent(`Max reserve: ${formatUSDFC(lockupAmount)} USDFC (10-day lockup)`)

  displayCapacity(capacity)

  if (shouldFlush) {
    log.flush()
  }
}

/**
 * Format FIL amount for display
 *
 * @param amount - Amount in attoFIL
 * @param isTestnet - Whether this is tFIL (testnet)
 * @returns Formatted string with unit
 */
export function formatFIL(amount: bigint, isTestnet: boolean): string {
  const formatted = ethers.formatEther(amount)
  const num = parseFloat(formatted)
  const unit = isTestnet ? 'tFIL' : 'FIL'
  return `${num.toFixed(4)} ${unit}`
}
