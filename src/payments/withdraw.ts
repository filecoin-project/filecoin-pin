/**
 * Withdraw command for Filecoin Pay
 */

import pc from 'picocolors'
import { parseUnits } from 'viem'
import { CliFatal, isCliFatal } from '../common/cli-errors.js'
import { checkFILBalance, getPaymentStatus, validateGasRequirement, withdrawUSDFC } from '../core/payments/index.js'
import { initializeSynapse } from '../core/synapse/index.js'
import { formatUSDFC } from '../core/utils/format.js'
import { type CLIAuthOptions, getCLILogger, parseCLIAuth } from '../utils/cli-auth.js'
import { cancel, createSpinner, intro, outro } from '../utils/cli-helpers.js'
import { log } from '../utils/cli-logger.js'

export interface WithdrawOptions extends CLIAuthOptions {
  amount: string
}

export async function runWithdraw(options: WithdrawOptions): Promise<void> {
  intro(pc.bold('Filecoin Onchain Cloud Withdraw'))
  const spinner = createSpinner()

  let amount: bigint
  try {
    amount = parseUnits(String(options.amount), 18)
  } catch {
    log.line(pc.red(`Error: Invalid amount '${options.amount}'`))
    log.flush()
    throw new CliFatal(`Invalid amount '${options.amount}'`)
  }
  if (amount <= 0n) {
    log.line(pc.red('Error: Amount must be greater than 0'))
    log.flush()
    throw new CliFatal('Amount must be greater than 0')
  }

  spinner.start('Connecting...')
  try {
    // Parse and validate authentication
    const authConfig = await parseCLIAuth(options)

    const logger = getCLILogger()
    const synapse = await initializeSynapse(authConfig, logger)
    const filStatus = await checkFILBalance(synapse)
    const gasCheck = validateGasRequirement(filStatus.balance, filStatus.isCalibnet)
    if (!gasCheck.isValid) {
      spinner.stop()
      const errorMsg = gasCheck.errorMessage ?? 'Insufficient FIL for gas fees'
      log.line(`${pc.red('✗')} ${errorMsg}`)
      log.line(`  ${pc.cyan(gasCheck.helpMessage ?? 'Acquire FIL for gas from an exchange')}`)
      log.flush()
      cancel('Withdraw aborted')
      throw new CliFatal(errorMsg)
    }

    spinner.stop(`${pc.green('✓')} Connected`)

    spinner.start(`Withdrawing ${formatUSDFC(amount)} USDFC...`)
    const txHash = await withdrawUSDFC(synapse, amount)
    spinner.stop(`${pc.green('✓')} Withdraw submitted`)

    log.line(pc.bold('Transaction'))
    log.indent(pc.gray(txHash))
    log.flush()

    // Show updated deposit
    const status = await getPaymentStatus(synapse)
    log.line('')
    log.line(pc.bold('Updated Balance'))
    log.indent(`Deposited: ${formatUSDFC(status.filecoinPayBalance)} USDFC`)
    log.flush()

    outro('Withdraw completed')
  } catch (error) {
    if (isCliFatal(error)) {
      spinner.stop()
      throw error
    }
    const msg = error instanceof Error ? error.message : String(error)
    spinner.stop(`${pc.red('✗')} Withdraw failed: ${msg}`)
    cancel('Withdraw failed')
    throw new CliFatal(msg, { cause: error instanceof Error ? error : undefined })
  }
}
