/**
 * Automatic payment setup flow
 *
 * This module provides an automated, non-interactive setup experience for
 * configuring payment approvals. It uses default values and command-line
 * options to complete the setup without user interaction.
 */

import { ethers } from 'ethers'
import pc from 'picocolors'
import {
  calculateDepositCapacity,
  checkAndSetAllowances,
  checkFILBalance,
  checkUSDFCBalance,
  depositUSDFC,
  getPaymentStatus,
  validatePaymentRequirements,
} from '../core/payments/index.js'
import { cleanupSynapseService, initializeSynapse } from '../core/synapse/index.js'
import { formatUSDFC } from '../core/utils/format.js'
import { getCLILogger, parseCLIAuth } from '../utils/cli-auth.js'
import { cancel, createSpinner, intro, outro } from '../utils/cli-helpers.js'
import { log } from '../utils/cli-logger.js'
import { displayAccountInfo, displayDepositWarning } from './setup.js'
import type { PaymentSetupOptions } from './types.js'

/**
 * Run automatic payment setup with defaults
 *
 * @param options - Options from command line
 */
export async function runAutoSetup(options: PaymentSetupOptions): Promise<void> {
  intro(pc.bold('Filecoin Onchain Cloud Payment Setup'))
  log.message(pc.gray('Running in auto mode...'))

  // Parse and validate deposit amount
  let targetDeposit: bigint
  try {
    targetDeposit = ethers.parseUnits(options.deposit, 18)
  } catch {
    console.error(pc.red(`Error: Invalid deposit amount '${options.deposit}'`))
    process.exit(1)
  }

  const spinner = createSpinner()
  spinner.start('Initializing connection...')

  try {
    // Parse and validate authentication
    const authConfig = parseCLIAuth({
      privateKey: options.privateKey,
      walletAddress: options.walletAddress,
      sessionKey: options.sessionKey,
      rpcUrl: options.rpcUrl,
    })

    const logger = getCLILogger()
    const synapse = await initializeSynapse(authConfig, logger)
    const network = synapse.getNetwork()
    const client = synapse.getClient()
    const address = await client.getAddress()

    spinner.stop(`${pc.green('✓')} Connected to ${pc.bold(network)}`)

    // Check balances
    spinner.start('Checking balances...')

    const filStatus = await checkFILBalance(synapse)
    const usdfcBalance = await checkUSDFCBalance(synapse)

    spinner.stop(`${pc.green('✓')} Balance check complete`)

    // Validate payment requirements
    const validation = validatePaymentRequirements(filStatus.hasSufficientGas, usdfcBalance, filStatus.isCalibnet)
    if (!validation.isValid) {
      log.line(`${pc.red('✗')} ${validation.errorMessage}`)
      if (validation.helpMessage) {
        log.line('')
        log.line(`  ${pc.cyan(validation.helpMessage)}`)
      }
      log.flush()
      cancel('Please fund your wallet and try again')
      process.exit(1)
    }

    // Now safe to get payment status since we know account exists
    const status = await getPaymentStatus(synapse)

    // Display account and balance info using shared function
    displayAccountInfo(
      address,
      network,
      filStatus.balance,
      filStatus.isCalibnet,
      filStatus.hasSufficientGas,
      usdfcBalance,
      status.depositedAmount
    )

    // Get storage pricing for capacity calculation
    const storageInfo = await synapse.storage.getStorageInfo()
    const pricePerTiBPerEpoch = storageInfo.pricing.noCDN.perTiBPerEpoch

    // Track if any changes were made
    let actionsTaken = false
    let actualDepositAmount = 0n

    // Auto-set max allowances for WarmStorage
    spinner.start('Configuring WarmStorage permissions...')
    const allowanceResult = await checkAndSetAllowances(synapse)
    if (allowanceResult.updated) {
      spinner.stop(`${pc.green('✓')} WarmStorage permissions configured`)
      log.line(pc.bold('Transaction:'))
      log.indent(pc.gray(allowanceResult.transactionHash || 'Unknown'))
      log.flush()
      actionsTaken = true
    } else {
      spinner.stop(`${pc.green('✓')} WarmStorage permissions already configured`)
    }

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
      actionsTaken = true

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

    // Calculate capacity for final summary
    const totalDeposit = status.depositedAmount + actualDepositAmount
    const capacity = calculateDepositCapacity(totalDeposit, pricePerTiBPerEpoch)

    // Final summary
    spinner.start('Completing setup...')
    spinner.stop('━━━ Configuration Summary ━━━')

    log.line(`Network: ${pc.bold(network)}`)
    log.line(`Deposit: ${formatUSDFC(totalDeposit)} USDFC`)

    if (capacity.gibPerMonth > 0) {
      const capacityStr =
        capacity.gibPerMonth >= 1024
          ? `${(capacity.gibPerMonth / 1024).toFixed(1)} TiB`
          : `${capacity.gibPerMonth.toFixed(1)} GiB`
      log.line(`Storage: ~${capacityStr} for 1 month`)
    }

    log.line(`Status: ${pc.green('Ready to upload')}`)
    log.flush()

    // Show deposit warning if needed
    displayDepositWarning(totalDeposit, status.currentAllowances.lockupUsed)

    // Show appropriate outro message based on whether actions were taken
    if (actionsTaken) {
      outro('Payment setup completed successfully')
    } else {
      outro('Payment setup already configured - ready to use')
    }
  } catch (error) {
    spinner.stop() // Stop spinner without message
    console.error(pc.red('✗ Setup failed'))
    console.error(pc.red('Error:'), error instanceof Error ? error.message : error)

    process.exitCode = 1
  } finally {
    await cleanupSynapseService()
    process.exit()
  }
}
