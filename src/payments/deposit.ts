/**
 * Deposit command for Filecoin Pay
 *
 * Adds a specific USDFC amount to the Filecoin Pay balance. One-way: it never
 * withdraws. To target an exact runway or total (which may deposit or withdraw),
 * use `payments fund`.
 */

import pc from 'picocolors'
import { parseUnits } from 'viem'
import { CliFatal, isCliFatal } from '../common/cli-errors.js'
import {
  checkFILBalance,
  checkUSDFCBalance,
  depositUSDFC,
  toStorageRunwaySummary,
  validateGasRequirement,
} from '../core/payments/index.js'
import { initializeSynapse } from '../core/synapse/index.js'
import { formatUSDFC } from '../core/utils/format.js'
import { formatRunwaySummary } from '../core/utils/index.js'
import { type CLIAuthOptions, getCLILogger, parseCLIAuth } from '../utils/cli-auth.js'
import { cancel, createSpinner, intro, outro } from '../utils/cli-helpers.js'
import { log } from '../utils/cli-logger.js'

export interface DepositOptions extends CLIAuthOptions {
  amount?: string | undefined
}

/**
 * Run the deposit flow
 */
export async function runDeposit(options: DepositOptions): Promise<void> {
  intro(pc.bold('Filecoin Onchain Cloud Deposit'))

  const spinner = createSpinner()

  if (options.amount == null) {
    log.line(pc.red('Error: --amount <USDFC> is required'))
    log.flush()
    throw new CliFatal('--amount <USDFC> is required')
  }

  // Connect
  spinner.start('Connecting...')
  try {
    // Parse and validate authentication
    const authConfig = await parseCLIAuth(options)

    const logger = getCLILogger()
    const synapse = await initializeSynapse(authConfig, logger)

    const [filStatus, walletUsdfcBalance] = await Promise.all([checkFILBalance(synapse), checkUSDFCBalance(synapse)])

    spinner.stop(`${pc.green('✓')} Connected`)

    // Validate balances
    const gasCheck = validateGasRequirement(filStatus.balance, filStatus.isCalibnet)
    if (!gasCheck.isValid) {
      const errorMsg = gasCheck.errorMessage ?? 'Insufficient FIL for gas fees'
      log.line(`${pc.red('✗')} ${errorMsg}`)
      log.line(`  ${pc.cyan(gasCheck.helpMessage ?? 'Acquire FIL for gas from an exchange')}`)
      log.flush()
      cancel('Deposit aborted')
      throw new CliFatal(errorMsg)
    }

    let depositAmount: bigint
    try {
      depositAmount = parseUnits(String(options.amount), 18)
    } catch {
      throw new Error(`Invalid amount '${options.amount}'`)
    }

    if (depositAmount <= 0n) {
      throw new Error('Amount must be greater than 0')
    }

    // Ensure wallet has enough USDFC
    if (depositAmount > walletUsdfcBalance) {
      throw new Error(
        `Insufficient USDFC (need ${formatUSDFC(depositAmount)} USDFC, have ${formatUSDFC(walletUsdfcBalance)} USDFC)`
      )
    }

    spinner.start(`Depositing ${formatUSDFC(depositAmount)} USDFC...`)
    const { depositTx } = await depositUSDFC(synapse, depositAmount)
    spinner.stop(`${pc.green('✓')} Deposit complete`)

    log.line(pc.bold('Transaction details:'))
    log.indent(pc.gray(`Deposit: ${depositTx}`))
    log.flush()

    const updatedSummary = await synapse.payments.accountSummary({})
    const runway = toStorageRunwaySummary(updatedSummary)
    const runwayDisplay = formatRunwaySummary(runway)

    log.line('')
    log.line(pc.bold('Deposit Summary'))
    log.indent(`Total deposit: ${formatUSDFC(updatedSummary.funds)} USDFC`)
    if (runway.state === 'active') {
      log.indent(`Current spend: ${formatUSDFC(runway.perDay)} USDFC/day`)
      log.indent(`Storage covered: ~${runwayDisplay.coverage} total`)
      log.indent(`Top-up needed in: ~${runwayDisplay.runway}`)
    } else {
      log.indent(pc.gray(runwayDisplay.coverage))
    }
    log.flush()

    outro('Deposit completed')
  } catch (error) {
    if (isCliFatal(error)) {
      spinner.stop()
      throw error
    }
    const msg = error instanceof Error ? error.message : String(error)
    spinner.stop(`${pc.red('✗')} Deposit failed: ${msg}`)
    cancel('Deposit failed')
    throw new CliFatal(msg, { cause: error instanceof Error ? error : undefined })
  }
}
