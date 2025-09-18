/**
 * Automatic payment setup flow
 *
 * This module provides an automated, non-interactive setup experience for
 * configuring payment approvals. It uses default values and command-line
 * options to complete the setup without user interaction.
 */

import { RPC_URLS, Synapse, TIME_CONSTANTS } from '@filoz/synapse-sdk'
import { ethers } from 'ethers'
import pc from 'picocolors'
import { createSpinner, intro } from '../utils/cli-helpers.js'
import { log } from '../utils/cli-logger.js'
import {
  calculateStorageAllowances,
  calculateStorageFromUSDFC,
  checkFILBalance,
  checkInsufficientFunds,
  checkUSDFCBalance,
  depositUSDFC,
  displayAccountInfo,
  displayDepositWarning,
  displayPaymentSummary,
  displayServicePermissions,
  formatUSDFC,
  getPaymentStatus,
  parseStorageAllowance,
  setServiceApprovals,
} from './setup.js'
import type { PaymentSetupOptions, StorageAllowances } from './types.js'

/**
 * Run automatic payment setup with defaults
 *
 * @param options - Options from command line
 */
export async function runAutoSetup(options: PaymentSetupOptions): Promise<void> {
  intro(pc.bold('Filecoin Onchain Cloud Payment Setup'))
  log.message(pc.gray('Running in auto mode...'))

  // Parse and validate all arguments upfront
  // 1. Private key
  const privateKey = options.privateKey || process.env.PRIVATE_KEY
  if (!privateKey) {
    console.error(pc.red('Error: Private key required via --private-key or PRIVATE_KEY env'))
    process.exit(1)
  }

  // Validate private key format early
  try {
    new ethers.Wallet(privateKey)
  } catch {
    console.error(pc.red('Error: Invalid private key format'))
    process.exit(1)
  }

  // 2. RPC URL
  const rpcUrl = options.rpcUrl || RPC_URLS.calibration.websocket

  // 3. Deposit amount
  let targetDeposit: bigint
  try {
    targetDeposit = ethers.parseUnits(options.deposit, 18)
  } catch {
    console.error(pc.red(`Error: Invalid deposit amount '${options.deposit}'`))
    process.exit(1)
  }

  // 4. Parse storage allowance early to validate format
  if (!options.rateAllowance) {
    console.error(pc.red('Error: Storage allowance is required'))
    process.exit(1)
  }

  let parsedTiB: number | null
  let rawUsdfcPerEpoch: string | null = null
  try {
    parsedTiB = parseStorageAllowance(options.rateAllowance)
    if (parsedTiB === null) {
      // parseStorageAllowance already validated it's a valid USDFC amount
      // (it would have thrown otherwise), so we can safely save it
      rawUsdfcPerEpoch = options.rateAllowance
    }
  } catch (error) {
    console.error(pc.red(`Error: Invalid storage allowance '${options.rateAllowance}'`))
    console.error(pc.red(error instanceof Error ? error.message : String(error)))
    process.exit(1)
  }

  const spinner = createSpinner()
  spinner.start('Initializing connection...')

  // Store provider reference for cleanup if it's a WebSocket provider
  let provider: any = null

  try {
    // Initialize Synapse
    const synapse = await Synapse.create({
      privateKey,
      rpcURL: rpcUrl,
    })
    const network = synapse.getNetwork()
    const signer = synapse.getSigner()
    const address = await signer.getAddress()

    // Store provider reference for cleanup if it's a WebSocket provider
    if (rpcUrl.match(/^wss?:\/\//)) {
      provider = synapse.getProvider()
    }

    spinner.stop(`${pc.green('✓')} Connected to ${pc.bold(network)}`)

    // Check balances
    spinner.start('Checking balances...')

    const { balance: filBalance, isCalibnet, hasSufficientGas } = await checkFILBalance(synapse)
    const usdfcBalance = await checkUSDFCBalance(synapse)
    const status = await getPaymentStatus(synapse)

    spinner.stop(`${pc.green('✓')} Balance check complete`)

    // Display account and balance info using shared function
    displayAccountInfo(address, network, filBalance, isCalibnet, hasSufficientGas, usdfcBalance, status.depositedAmount)

    // Check for insufficient funds
    checkInsufficientFunds(hasSufficientGas, usdfcBalance, isCalibnet, true)

    // Calculate storage allowances now that we have synapse
    let allowances: StorageAllowances
    if (parsedTiB !== null) {
      // User specified TiB/month, calculate allowances
      allowances = await calculateStorageAllowances(synapse, parsedTiB)
    } else if (rawUsdfcPerEpoch !== null) {
      // User specified USDFC per epoch directly
      allowances = await calculateStorageFromUSDFC(synapse, rawUsdfcPerEpoch)
    } else {
      // This shouldn't happen due to earlier validation
      throw new Error('Invalid storage allowance state')
    }

    // Handle deposits
    let actualDepositAmount = 0n

    if (status.depositedAmount < targetDeposit) {
      const depositAmount = targetDeposit - status.depositedAmount
      actualDepositAmount = depositAmount

      if (depositAmount > usdfcBalance) {
        console.error(
          pc.red(
            `✗ Insufficient USDFC for deposit (need ${formatUSDFC(depositAmount)} USDFC, have ${formatUSDFC(usdfcBalance)} USDFC)`
          )
        )
        process.exit(1)
      }

      spinner.start(`Depositing ${formatUSDFC(depositAmount)} USDFC...`)
      const { approvalTx, depositTx } = await depositUSDFC(synapse, depositAmount)
      spinner.stop(`${pc.green('✓')} Deposited ${formatUSDFC(depositAmount)} USDFC`)

      log.line(pc.bold('Transaction details:'))
      if (approvalTx) {
        log.indent(pc.gray(`Approval: ${approvalTx}`))
      }
      log.indent(pc.gray(`Deposit: ${depositTx}`))
      log.flush()
    } else {
      // Use a dummy spinner to get consistent formatting
      spinner.start('Checking deposit...')
      spinner.stop(`${pc.green('✓')} Deposit already sufficient (${formatUSDFC(status.depositedAmount)} USDFC)`)
    }

    // Get storage pricing for capacity calculation
    const storageInfo = await synapse.storage.getStorageInfo()
    const pricePerTiBPerEpoch = storageInfo.pricing.noCDN.perTiBPerEpoch

    // Set storage allowances
    spinner.start(`Checking WarmStorage service allowances (${options.rateAllowance})...`)

    // Check if we need to update allowances
    const currentAllowances = status.currentAllowances
    let needsUpdate = false

    if (currentAllowances.rateAllowance < allowances.ratePerEpoch) {
      needsUpdate = true
    }

    if (currentAllowances.lockupAllowance < allowances.lockupAmount) {
      needsUpdate = true
    }

    // Calculate total deposit for capacity display
    const totalDeposit = status.depositedAmount + actualDepositAmount

    if (needsUpdate) {
      spinner.message('Setting WarmStorage service approvals...')
      const approvalTx = await setServiceApprovals(synapse, allowances.ratePerEpoch, allowances.lockupAmount)
      spinner.stop(`${pc.green('✓')} WarmStorage service approvals updated`)

      log.line(pc.bold('Transaction:'))
      log.indent(pc.gray(approvalTx))
      log.flush()

      // Display new permissions with capacity info
      const monthlyRate = allowances.ratePerEpoch * TIME_CONSTANTS.EPOCHS_PER_MONTH
      displayServicePermissions(
        'New WarmStorage Service Limits:',
        monthlyRate,
        allowances.lockupAmount,
        totalDeposit,
        pricePerTiBPerEpoch
      )
    } else {
      spinner.stop(`${pc.green('✓')} WarmStorage service permissions already sufficient`)

      // Display current permissions with capacity info
      const monthlyRate = currentAllowances.rateAllowance * TIME_CONSTANTS.EPOCHS_PER_MONTH
      displayServicePermissions(
        'Your Current WarmStorage Service Limits:',
        monthlyRate,
        currentAllowances.lockupAllowance,
        totalDeposit,
        pricePerTiBPerEpoch
      )
    }

    // Get final values
    let finalRateAllowance: bigint
    let finalLockupAllowance: bigint

    if (needsUpdate) {
      finalRateAllowance = allowances.ratePerEpoch
      finalLockupAllowance = allowances.lockupAmount
    } else {
      finalRateAllowance = currentAllowances.rateAllowance
      finalLockupAllowance = currentAllowances.lockupAllowance
    }

    // Final summary
    spinner.start('Completing setup...')
    spinner.stop('━━━ Setup Complete ━━━')

    displayPaymentSummary(
      network,
      filBalance,
      isCalibnet,
      usdfcBalance,
      totalDeposit,
      finalRateAllowance,
      finalLockupAllowance,
      pricePerTiBPerEpoch
    )

    // Show deposit warning if needed
    displayDepositWarning(totalDeposit, status.currentAllowances.lockupUsed)

    // Clean up WebSocket providers to allow process termination
    if (provider && typeof provider.destroy === 'function') {
      try {
        await provider.destroy()
      } catch {
        // Ignore cleanup errors
      }
    }
  } catch (error) {
    spinner.stop() // Stop spinner without message
    console.error(pc.red('✗ Setup failed'))
    console.error(pc.red('Error:'), error instanceof Error ? error.message : error)

    // Clean up even on error
    if (provider && typeof provider.destroy === 'function') {
      try {
        await provider.destroy()
      } catch {
        // Ignore cleanup errors
      }
    }

    process.exit(1)
  }
}
