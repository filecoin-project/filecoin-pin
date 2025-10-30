/**
 * Withdraw command for Filecoin Pay
 */

import { ethers } from 'ethers'
import pc from 'picocolors'
import { checkFILBalance, getPaymentStatus, withdrawUSDFC } from '../core/payments/index.js'
import { cleanupSynapseService, initializeSynapse } from '../core/synapse/index.js'
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
    amount = ethers.parseUnits(String(options.amount), 18)
  } catch {
    console.error(pc.red(`Error: Invalid amount '${options.amount}'`))
    process.exit(1)
  }
  if (amount <= 0n) {
    console.error(pc.red('Error: Amount must be greater than 0'))
    process.exit(1)
  }

  spinner.start('Connecting...')
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

    const filStatus = await checkFILBalance(synapse)
    if (!filStatus.hasSufficientGas) {
      spinner.stop()
      log.line(`${pc.red('✗')} Insufficient FIL for gas fees`)
      const help = filStatus.isCalibnet
        ? 'Get test FIL from: https://faucet.calibnet.chainsafe-fil.io/'
        : 'Acquire FIL for gas from an exchange'
      log.line(`  ${pc.cyan(help)}`)
      log.flush()
      cancel('Withdraw aborted')
      throw new Error('Insufficient FIL for gas fees')
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
    spinner.stop()
    console.error(pc.red('✗ Withdraw failed'))
    console.error(pc.red('Error:'), error instanceof Error ? error.message : error)
    process.exitCode = 1
  } finally {
    await cleanupSynapseService()
  }
}
