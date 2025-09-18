/**
 * Core payment setup logic for Filecoin Onchain Cloud
 *
 * This module provides example implementations showing how to:
 * - Check balances for FIL and USDFC tokens
 * - Deposit USDFC into the Payments contract
 * - Set service approvals for the WarmStorage operator
 * - Calculate storage allowances from human-friendly units
 *
 * All functions use Synapse SDK to interact with the blockchain,
 * demonstrating best practices for payment rail setup in the
 * Filecoin Onchain Cloud ecosystem.
 */

import { type Synapse, TIME_CONSTANTS, TOKENS } from '@filoz/synapse-sdk'
import { ethers } from 'ethers'
import pc from 'picocolors'
import type { PaymentStatus, StorageAllowances } from './types.js'

// Constants
const USDFC_DECIMALS = 18
const MIN_FIL_FOR_GAS = ethers.parseEther('0.1') // Minimum FIL needed for gas
const DEFAULT_LOCKUP_DAYS = 10 // WarmStorage requires 10 days lockup

/**
 * Check FIL balance for gas fees
 *
 * Demonstrates how to check native token balance and determine
 * if the user has enough FIL for transaction gas fees.
 *
 * @param synapse - Initialized Synapse instance
 * @returns Balance information and network type
 */
export async function checkFILBalance(synapse: Synapse): Promise<{
  balance: bigint
  isCalibnet: boolean
  hasSufficientGas: boolean
}> {
  const provider = synapse.getProvider()
  const signer = synapse.getSigner()
  const address = await signer.getAddress()

  // Get balance
  const balance = await provider.getBalance(address)

  // Determine network
  const network = synapse.getNetwork()
  const isCalibnet = network === 'calibration'

  // Check if balance is sufficient for gas
  const hasSufficientGas = balance >= MIN_FIL_FOR_GAS

  return {
    balance,
    isCalibnet,
    hasSufficientGas,
  }
}

/**
 * Check USDFC token balance
 *
 * Demonstrates how to check ERC20 token balance using Synapse's
 * PaymentsService, which handles the token contract interaction.
 *
 * @param synapse - Initialized Synapse instance
 * @returns USDFC balance in wei (18 decimals)
 */
export async function checkUSDFCBalance(synapse: Synapse): Promise<bigint> {
  // Get wallet balance (not deposited balance)
  const balance = await synapse.payments.walletBalance(TOKENS.USDFC)
  return balance
}

/**
 * Get current payment status
 *
 * Demonstrates how to gather comprehensive payment information
 * including deposits, allowances, and balances.
 *
 * @param synapse - Initialized Synapse instance
 * @returns Complete payment status
 */
export async function getPaymentStatus(synapse: Synapse): Promise<PaymentStatus> {
  const signer = synapse.getSigner()
  const network = synapse.getNetwork()
  const warmStorageAddress = synapse.getWarmStorageAddress()

  // Run all async operations in parallel
  const [address, { balance: filBalance }, usdfcBalance, depositedAmount, currentAllowances] = await Promise.all([
    signer.getAddress(),
    checkFILBalance(synapse),
    checkUSDFCBalance(synapse),
    synapse.payments.balance(TOKENS.USDFC),
    synapse.payments.serviceApproval(warmStorageAddress, TOKENS.USDFC),
  ])

  return {
    network,
    address,
    filBalance,
    usdfcBalance,
    depositedAmount,
    currentAllowances,
  }
}

/**
 * Deposit USDFC into the Payments contract
 *
 * Demonstrates the two-step process for depositing tokens:
 * 1. Approve the Payments contract to spend USDFC (ERC20 approval)
 * 2. Call deposit to move funds into the Payments contract
 *
 * TODO: replace a single EIP-2612 / ERC-3009 method
 *
 * @param synapse - Initialized Synapse instance
 * @param amount - Amount to deposit in USDFC (with decimals)
 * @returns Transaction hashes for approval and deposit
 */
export async function depositUSDFC(
  synapse: Synapse,
  amount: bigint
): Promise<{
  approvalTx?: string
  depositTx: string
}> {
  const paymentsAddress = synapse.getPaymentsAddress()

  // Step 1: Check current allowance
  const currentAllowance = await synapse.payments.allowance(paymentsAddress, TOKENS.USDFC)

  let approvalTx: string | undefined

  // Step 2: Approve if needed
  if (currentAllowance < amount) {
    const approveTx = await synapse.payments.approve(paymentsAddress, amount, TOKENS.USDFC)
    await approveTx.wait()
    approvalTx = approveTx.hash
  }

  // Step 3: Make the deposit
  const depositTransaction = await synapse.payments.deposit(amount, TOKENS.USDFC)
  await depositTransaction.wait()

  const result: { approvalTx?: string; depositTx: string } = {
    depositTx: depositTransaction.hash,
  }

  if (approvalTx) {
    result.approvalTx = approvalTx
  }

  return result
}

/**
 * Set service approvals for WarmStorage
 *
 * Demonstrates how to approve the WarmStorage contract as an operator
 * that can create payment rails on behalf of the user. This involves setting:
 * - Rate allowance: Maximum payment rate per epoch
 * - Lockup allowance: Maximum funds that can be locked
 * - Max lockup period: How far in advance funds can be locked
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
  const warmStorageAddress = synapse.getWarmStorageAddress()

  // Max lockup period is always 10 days worth of epochs for WarmStorage
  const maxLockupPeriod = BigInt(DEFAULT_LOCKUP_DAYS) * TIME_CONSTANTS.EPOCHS_PER_DAY

  // Set the service approval
  const tx = await synapse.payments.approveService(
    warmStorageAddress,
    rateAllowance,
    lockupAllowance,
    maxLockupPeriod,
    TOKENS.USDFC
  )

  await tx.wait()
  return tx.hash
}

/**
 * Calculate storage allowances from TiB per month
 *
 * Demonstrates how to convert human-friendly storage units (TiB/month)
 * into the epoch-based rates required by the payment system. Uses actual
 * pricing from the storage service.
 *
 * @param synapse - Initialized Synapse instance
 * @param tibPerMonth - Storage amount in TiB per month
 * @returns Rate per epoch and required lockup amount
 */
export async function calculateStorageAllowances(synapse: Synapse, tibPerMonth: number): Promise<StorageAllowances> {
  // Get current storage pricing
  const storageInfo = await synapse.storage.getStorageInfo()

  // Use non-CDN pricing (simpler, no CDN overhead)
  const pricePerTiBPerEpoch = storageInfo.pricing.noCDN.perTiBPerEpoch

  // Calculate rate allowance (price for desired storage per epoch)
  // Handle fractional TiB by converting to milliTiB for precision
  const milliTiBPerMonth = Math.round(tibPerMonth * 1000)
  const ratePerEpoch = (pricePerTiBPerEpoch * BigInt(milliTiBPerMonth)) / 1000n

  // Lockup is always 10 days worth of payments for WarmStorage
  const lockupAmount = ratePerEpoch * TIME_CONSTANTS.EPOCHS_PER_DAY * BigInt(DEFAULT_LOCKUP_DAYS)

  return {
    ratePerEpoch,
    lockupAmount,
    tibPerMonth,
  }
}

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
 * Calculate storage allowances from direct USDFC per epoch
 *
 * Converts a USDFC per epoch rate to storage allowances with TiB calculation
 *
 * @param synapse - Synapse instance for price lookups
 * @param usdfcPerEpoch - USDFC per epoch string
 * @returns Storage allowances
 */
export async function calculateStorageFromUSDFC(synapse: Synapse, usdfcPerEpoch: string): Promise<StorageAllowances> {
  const ratePerEpoch = ethers.parseUnits(usdfcPerEpoch, USDFC_DECIMALS)
  const lockupAmount = ratePerEpoch * TIME_CONSTANTS.EPOCHS_PER_DAY * BigInt(DEFAULT_LOCKUP_DAYS)

  // Calculate approximate TiB/month for display
  const storageInfo = await synapse.storage.getStorageInfo()
  const pricePerTiBPerEpoch = storageInfo.pricing.noCDN.perTiBPerEpoch
  const tibPerMonth = Number((ratePerEpoch * 10000n) / pricePerTiBPerEpoch) / 10000

  return {
    ratePerEpoch,
    lockupAmount,
    tibPerMonth,
  }
}

/**
 * Calculate actual storage capacity considering both rate and lockup limits
 *
 * The actual capacity is constrained by both:
 * 1. The rate allowance (how much per epoch the user allows)
 * 2. The lockup allowance (10-day reserve that limits total spending)
 *
 * If the lockup is less than 10 days worth of the rate allowance,
 * it becomes the bottleneck.
 *
 * @param rateAllowance - Maximum USDFC per epoch
 * @param lockupAllowance - Maximum USDFC that can be locked up (10 days)
 * @param pricePerTiBPerEpoch - Current storage price
 * @returns Storage capacity in GB per month
 */
export function calculateStorageCapacity(
  rateAllowance: bigint,
  lockupAllowance: bigint,
  pricePerTiBPerEpoch: bigint
): number {
  // Calculate capacity based on rate allowance
  const tibFromRate = Number((rateAllowance * 10000n) / pricePerTiBPerEpoch) / 10000

  // Calculate capacity based on lockup (10 days worth)
  const defaultLockupEpochs = BigInt(DEFAULT_LOCKUP_DAYS) * TIME_CONSTANTS.EPOCHS_PER_DAY
  const maxRateFromLockup = lockupAllowance / defaultLockupEpochs
  const tibFromLockup = Number((maxRateFromLockup * 10000n) / pricePerTiBPerEpoch) / 10000

  // Actual capacity is the minimum of the two
  // Lockup is for 10 days, so multiply by 3 for 30-day month
  const tibPerMonth = Math.min(tibFromRate, tibFromLockup * 3)
  const gbPerMonth = tibPerMonth * 1024

  return gbPerMonth
}

/**
 * Calculate actual vs potential storage capacity based on deposit
 *
 * Determines what storage the user can actually use based on their deposit,
 * versus what they could potentially use with their approved limits.
 *
 * @param depositedAmount - Current deposit in the payments contract
 * @param rateAllowance - Approved rate per epoch
 * @param lockupAllowance - Approved lockup amount
 * @param pricePerTiBPerEpoch - Current storage price
 * @returns Actual and potential capacities with limitation info
 */
export function calculateActualCapacity(
  depositedAmount: bigint,
  rateAllowance: bigint,
  lockupAllowance: bigint,
  pricePerTiBPerEpoch: bigint
): {
  actualGB: number
  potentialGB: number
  isDepositLimited: boolean
  additionalDepositNeeded: bigint
} {
  // Calculate potential capacity based on approved allowances
  const potentialGB = calculateStorageCapacity(rateAllowance, lockupAllowance, pricePerTiBPerEpoch)

  // For storage, we need:
  // 1. Lockup (10 days of payments as security deposit)
  // 2. Available balance for ongoing payments
  // The deposit must cover both, so we split it proportionally

  // Calculate required deposit for the allowances
  // Need lockup + at least 30 days of payments for smooth operation
  const requiredLockup = lockupAllowance
  const monthlyPayment = rateAllowance * TIME_CONSTANTS.EPOCHS_PER_MONTH
  const requiredDeposit = requiredLockup + monthlyPayment

  let actualGB: number
  let isDepositLimited = false
  let additionalDepositNeeded = 0n

  if (depositedAmount >= requiredDeposit) {
    // Deposit is sufficient for full capacity
    actualGB = potentialGB
  } else {
    // Deposit is limiting factor - scale down proportionally
    isDepositLimited = true
    additionalDepositNeeded = requiredDeposit - depositedAmount

    // Calculate what we can actually support with current deposit
    // Reserve 10/11ths for lockup, 1/11th for monthly payment
    // (10 days lockup + 1 month payment = 40 days total)
    const scaleFactor = Number((depositedAmount * 1000n) / requiredDeposit) / 1000
    actualGB = potentialGB * scaleFactor
  }

  return {
    actualGB: Math.floor(actualGB), // Round down to be conservative
    potentialGB: Math.floor(potentialGB),
    isDepositLimited,
    additionalDepositNeeded,
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
 * Create an Ethereum provider based on RPC URL protocol
 *
 * @param rpcUrl - The RPC endpoint URL
 * @returns WebSocketProvider for ws/wss URLs, JsonRpcProvider otherwise
 */
export function createProvider(rpcUrl: string): ethers.WebSocketProvider | ethers.JsonRpcProvider {
  return rpcUrl.match(/^wss?:\/\//) ? new ethers.WebSocketProvider(rpcUrl) : new ethers.JsonRpcProvider(rpcUrl)
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
  console.log(`\n━━━ Setup Complete ━━━`)
  console.log(`Network: ${pc.bold(network)}`)

  // Section 1: Wallet
  console.log(`\n${pc.bold('Wallet')}`)
  console.log(`  ${formatFIL(filBalance, isCalibnet)}`)
  console.log(`  ${formatUSDFC(usdfcBalance)} USDFC`)

  // Section 2: Filecoin Pay deposit
  console.log(`\n${pc.bold('Filecoin Pay Deposit')}`)
  console.log(`  ${formatUSDFC(depositedAmount)} USDFC`)
  console.log(pc.gray('  (spendable on any service)'))

  // Section 3: WarmStorage service permissions
  if (rateAllowance > 0n) {
    const monthlyRate = rateAllowance * TIME_CONSTANTS.EPOCHS_PER_MONTH
    console.log(`\n${pc.bold('Your WarmStorage Service Limits')}`)
    console.log(`  Max payment: ${formatUSDFC(monthlyRate)} USDFC/month`)
    console.log(`  Max reserve: ${formatUSDFC(lockupAllowance)} USDFC (10-day lockup)`)

    // Calculate and display capacity
    const capacity = calculateActualCapacity(depositedAmount, rateAllowance, lockupAllowance, pricePerTiBPerEpoch)
    displayCapacity(capacity)
  } else {
    console.log(`\n${pc.bold('Your WarmStorage Service Limits')}`)
    console.log(pc.gray('  No limits set'))
  }
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
      console.log(`\n${pc.yellow(`⚠ Warning: Low deposit balance`)}`)
      console.log(pc.yellow(`  Your deposit: ${formatUSDFC(depositedAmount)} USDFC`))
      console.log(pc.yellow(`  Amount locked: ${formatUSDFC(lockupUsed)} USDFC`))
      console.log(pc.yellow(`  Available: ${formatUSDFC(availableDeposit > 0n ? availableDeposit : 0n)} USDFC`))
      console.log(pc.yellow(`  Deposit at least ${formatUSDFC(needed)} more USDFC to maintain safety margin`))
      console.log(pc.gray(`  Without sufficient deposit, storage may be terminated`))
    }
  }
}

/**
 * Display capacity information based on deposit and limits
 *
 * @param capacity - Calculated capacity information
 */
export function displayCapacity(capacity: ReturnType<typeof calculateActualCapacity>): void {
  if (capacity.isDepositLimited) {
    console.log(
      `  → Current capacity: ~${capacity.actualGB.toLocaleString()} GB/month ${pc.yellow('(deposit-limited)')}`
    )
    console.log(
      `  → Potential: ~${capacity.potentialGB.toLocaleString()} GB/month (deposit ${formatUSDFC(capacity.additionalDepositNeeded)} more)`
    )
  } else {
    console.log(`  → Estimated capacity: ~${capacity.actualGB.toLocaleString()} GB/month`)
    console.log(pc.gray('    (excludes data set creation fee and optional CDN add-on rates)'))
  }
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
  pricePerTiBPerEpoch: bigint
): void {
  // Calculate capacity
  const ratePerEpoch = monthlyRate / TIME_CONSTANTS.EPOCHS_PER_MONTH
  const capacity = calculateActualCapacity(depositAmount, ratePerEpoch, lockupAmount, pricePerTiBPerEpoch)

  console.log(`\n${pc.bold(title)}`)
  console.log(`  Max payment: ${formatUSDFC(monthlyRate)} USDFC/month`)
  console.log(`  Max reserve: ${formatUSDFC(lockupAmount)} USDFC (10-day lockup)`)

  displayCapacity(capacity)
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
