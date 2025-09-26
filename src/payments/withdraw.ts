/**
 * Withdraw command for Filecoin Pay
 */

import { RPC_URLS, Synapse } from '@filoz/synapse-sdk'
import { ethers } from 'ethers'
import pc from 'picocolors'
import { cleanupProvider } from '../synapse/service.js'
import { cancel, createSpinner, intro, outro } from '../utils/cli-helpers.js'
import { log } from '../utils/cli-logger.js'
import { checkFILBalance, formatUSDFC, getPaymentStatus, withdrawUSDFC } from './setup.js'

export interface WithdrawOptions {
  privateKey?: string
  rpcUrl?: string
  amount: string
}

export async function runWithdraw(options: WithdrawOptions): Promise<void> {
  intro(pc.bold('Filecoin Onchain Cloud Withdraw'))
  const spinner = createSpinner()

  const privateKey = options.privateKey || process.env.PRIVATE_KEY
  if (!privateKey) {
    console.error(pc.red('Error: Private key required via --private-key or PRIVATE_KEY env'))
    process.exit(1)
  }

  try {
    new ethers.Wallet(privateKey)
  } catch {
    console.error(pc.red('Error: Invalid private key format'))
    process.exit(1)
  }

  const rpcUrl = options.rpcUrl || process.env.RPC_URL || RPC_URLS.calibration.websocket

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
  let provider: any = null
  try {
    const synapse = await Synapse.create({ privateKey, rpcURL: rpcUrl })
    if (rpcUrl.match(/^wss?:\/\//)) {
      provider = synapse.getProvider()
    }

    const filStatus = await checkFILBalance(synapse)
    if (!filStatus.hasSufficientGas) {
      spinner.stop()
      log.line(`${pc.red('✗')} Insufficient FIL for gas fees`)
      const help = filStatus.isCalibnet
        ? 'Get test FIL from: https://faucet.calibnet.chainsafe-fil.io/'
        : 'Acquire FIL for gas from an exchange'
      log.line(`  ${pc.cyan(help)}`)
      log.flush()
      await cleanupProvider(provider)
      cancel('Withdraw aborted')
      process.exit(1)
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
    log.indent(`Deposited: ${formatUSDFC(status.depositedAmount)} USDFC`)
    log.flush()

    await cleanupProvider(provider)
    outro('Withdraw completed')
  } catch (error) {
    spinner.stop()
    console.error(pc.red('✗ Withdraw failed'))
    console.error(pc.red('Error:'), error instanceof Error ? error.message : error)
    process.exitCode = 1
  } finally {
    await cleanupProvider(provider)
  }
}
