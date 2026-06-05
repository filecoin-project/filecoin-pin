/**
 * Automatic payment setup flow
 *
 * This module provides an automated, non-interactive setup experience for
 * configuring payment approvals. It uses default values and command-line
 * options to complete the setup without user interaction.
 */

import pc from 'picocolors'
import { parseUnits } from 'viem'
import { CliFatal, isCliFatal } from '../common/cli-errors.js'
import {
  calculateDepositCapacity,
  checkAndSetAllowances,
  checkFILBalance,
  checkUSDFCBalance,
  computeAutoSetupTargetBalance,
  depositUSDFC,
  getPaymentStatus,
  getServicePrice,
  validatePaymentRequirements,
} from '../core/payments/index.js'
import { DEFAULT_COPIES } from '../core/synapse/constants.js'
import { getClientAddress, initializeSynapse } from '../core/synapse/index.js'
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

  // Parse an explicit --deposit override before the outer try below, throwing
  // CliFatal so the CLI wrapper exits without re-printing. When omitted, the
  // target balance is derived from live on-chain pricing after connecting (see
  // below).
  let targetFilecoinPayBalance: bigint | undefined
  if (options.deposit != null) {
    try {
      targetFilecoinPayBalance = parseUnits(options.deposit, 18)
    } catch {
      log.line(pc.red(`Error: Invalid deposit amount '${options.deposit}'`))
      log.flush()
      throw new CliFatal(`Invalid deposit amount '${options.deposit}'`)
    }
  }

  const spinner = createSpinner()
  spinner.start('Initializing connection...')

  try {
    // Parse and validate authentication
    const authConfig = await parseCLIAuth(options)

    const logger = getCLILogger()
    const synapse = await initializeSynapse(authConfig, logger)
    const network = synapse.chain.name
    const address = getClientAddress(synapse)

    spinner.stop(`${pc.green('✓')} Connected to ${pc.bold(network)}`)

    // Check balances
    spinner.start('Checking balances...')

    const filStatus = await checkFILBalance(synapse)
    const walletUsdfcBalance = await checkUSDFCBalance(synapse)

    spinner.stop(`${pc.green('✓')} Balance check complete`)

    // Validate payment requirements
    const validation = validatePaymentRequirements(filStatus.hasSufficientGas, walletUsdfcBalance, filStatus.isCalibnet)
    if (!validation.isValid) {
      const errorMsg = validation.errorMessage ?? 'Payment validation failed'
      log.line(`${pc.red('✗')} ${errorMsg}`)
      if (validation.helpMessage) {
        log.line('')
        log.line(`  ${pc.cyan(validation.helpMessage)}`)
      }
      log.flush()
      cancel('Please fund your wallet and try again')
      throw new CliFatal(errorMsg)
    }

    // Now safe to get payment status since we know account exists
    const [status, accountSummary] = await Promise.all([getPaymentStatus(synapse), synapse.payments.accountSummary()])

    // Display account and balance info using shared function
    displayAccountInfo(
      address,
      network,
      filStatus.balance,
      filStatus.isCalibnet,
      filStatus.hasSufficientGas,
      walletUsdfcBalance,
      status.filecoinPayBalance
    )

    // Get storage pricing for capacity calculation
    const storageInfo = await synapse.storage.getStorageInfo()
    const pricePerTiBPerEpoch = storageInfo.pricing.noCDN.perTiBPerEpoch

    // With no --deposit given, ask current on-chain pricing how much must be
    // available to set up DEFAULT_COPIES data sets (including the CDN lockup the
    // default FilCDN upload path needs), then deposit enough to cover it.
    if (targetFilecoinPayBalance == null) {
      const servicePrice = await getServicePrice(synapse.client)
      const { targetBalance } = computeAutoSetupTargetBalance({
        filecoinPayBalance: status.filecoinPayBalance,
        availableFunds: accountSummary.availableFunds,
        copies: DEFAULT_COPIES,
        minimumPricePerMonth: servicePrice.minimumPricePerMonth,
      })
      targetFilecoinPayBalance = targetBalance
      log.line(
        pc.gray(
          `Using default deposit target ${formatUSDFC(targetFilecoinPayBalance)} USDFC ` +
            `(covers ${DEFAULT_COPIES} CDN data sets + 1 USDFC runway)`
        )
      )
      log.flush()
    }

    // Track if any changes were made
    let actionsTaken = false
    let actualFilecoinPayTopUp = 0n

    if (status.filecoinPayBalance < targetFilecoinPayBalance) {
      const neededFilecoinPayTopUp = targetFilecoinPayBalance - status.filecoinPayBalance
      actualFilecoinPayTopUp = neededFilecoinPayTopUp

      if (neededFilecoinPayTopUp > walletUsdfcBalance) {
        throw new Error(
          `Insufficient USDFC for deposit (need ${formatUSDFC(neededFilecoinPayTopUp)} USDFC, have ${formatUSDFC(walletUsdfcBalance)} USDFC)`
        )
      }

      spinner.start(`Depositing ${formatUSDFC(neededFilecoinPayTopUp)} USDFC...`)
      const { depositTx } = await depositUSDFC(synapse, neededFilecoinPayTopUp)
      spinner.stop(`${pc.green('✓')} Deposited ${formatUSDFC(neededFilecoinPayTopUp)} USDFC`)
      actionsTaken = true

      log.line(pc.bold('Transaction details:'))
      log.indent(pc.gray(`Deposit: ${depositTx}`))
      log.flush()
    } else {
      // Use a dummy spinner to get consistent formatting
      spinner.start('Checking deposit...')
      const { updated, transactionHash } = await checkAndSetAllowances(synapse)
      if (updated) {
        spinner.stop(`${pc.green('✓')} Updated payment allowances, tx: ${transactionHash}`)
      } else {
        spinner.stop(`${pc.green('✓')} Deposit already sufficient (${formatUSDFC(status.filecoinPayBalance)} USDFC)`)
      }
    }

    // Calculate capacity for final summary
    const totalDeposit = status.filecoinPayBalance + actualFilecoinPayTopUp
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
    displayDepositWarning(totalDeposit, status.currentAllowances.lockupUsage)

    // Show appropriate outro message based on whether actions were taken
    if (actionsTaken) {
      outro('Payment setup completed successfully')
    } else {
      outro('Payment setup already configured - ready to use')
    }
  } catch (error) {
    if (isCliFatal(error)) {
      spinner.stop()
      throw error
    }
    const msg = error instanceof Error ? error.message : String(error)
    spinner.stop(`${pc.red('✗')} Setup failed: ${msg}`)
    cancel('Setup failed')
    throw new CliFatal(msg, { cause: error instanceof Error ? error : undefined })
  }
}
