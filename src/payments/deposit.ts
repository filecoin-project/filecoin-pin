/**
 * Deposit/top-up command for Filecoin Pay
 *
 * Provides two modes:
 * - Explicit amount: --amount <USDFC>
 * - By duration: --days <N> (fund enough to keep current usage alive for N days)
 */

import { ethers } from 'ethers'
import pc from 'picocolors'
import {
  calculateStorageRunway,
  checkFILBalance,
  checkUSDFCBalance,
  computeTopUpForDuration,
  depositUSDFC,
  getPaymentStatus,
} from '../core/payments/index.js'
import { cleanupSynapseService, initializeSynapse } from '../core/synapse/index.js'
import { formatUSDFC } from '../core/utils/format.js'
import { formatRunwaySummary } from '../core/utils/index.js'
import { type CLIAuthOptions, getCLILogger, parseCLIAuth } from '../utils/cli-auth.js'
import { cancel, createSpinner, intro, outro } from '../utils/cli-helpers.js'
import { log } from '../utils/cli-logger.js'

export interface DepositOptions extends CLIAuthOptions {
  amount?: string | undefined
  days?: number | undefined
}

/**
 * Run the deposit/top-up flow
 */
export async function runDeposit(options: DepositOptions): Promise<void> {
  intro(pc.bold('Filecoin Onchain Cloud Deposit'))

  const spinner = createSpinner()

  // Validate inputs
  const hasAmount = options.amount != null
  const hasDays = options.days != null

  if ((hasAmount && hasDays) || (!hasAmount && !hasDays)) {
    console.error(pc.red('Error: Specify exactly one of --amount <USDFC> or --days <N>'))
    process.exit(1)
  }

  // Connect
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

    const [filStatus, walletUsdfcBalance, status] = await Promise.all([
      checkFILBalance(synapse),
      checkUSDFCBalance(synapse),
      getPaymentStatus(synapse),
    ])

    spinner.stop(`${pc.green('✓')} Connected`)

    // Validate balances
    if (!filStatus.hasSufficientGas) {
      log.line(`${pc.red('✗')} Insufficient FIL for gas fees`)
      const help = filStatus.isCalibnet
        ? 'Get test FIL from: https://faucet.calibnet.chainsafe-fil.io/'
        : 'Acquire FIL for gas from an exchange'
      log.line(`  ${pc.cyan(help)}`)
      log.flush()
      cancel('Deposit aborted')
      throw new Error('Insufficient FIL for gas fees')
    }

    let depositAmount: bigint = 0n

    if (hasAmount) {
      try {
        depositAmount = ethers.parseUnits(String(options.amount), 18)
      } catch {
        throw new Error(`Invalid amount '${options.amount}'`)
      }

      if (depositAmount <= 0n) {
        throw new Error('Amount must be greater than 0')
      }
    } else if (hasDays) {
      const days = Number(options.days)
      if (!Number.isFinite(days) || days <= 0) {
        throw new Error('--days must be a positive number')
      }

      const { topUp, rateUsed, perDay } = computeTopUpForDuration(status, days)

      if (rateUsed === 0n) {
        spinner.stop()
        log.line(`${pc.yellow('⚠')} No active storage payments detected (rateUsed = 0)`)
        log.line('Use --amount to deposit a specific USDFC value instead.')
        log.flush()
        cancel('Nothing to fund by duration')
        throw new Error('No active spend detected')
      }

      depositAmount = topUp

      if (depositAmount === 0n) {
        spinner.stop()
        log.line(`${pc.green('✓')} Already funded for at least ${days} day(s) at current spend rate`)
        log.indent(`Current daily spend: ${formatUSDFC(perDay)} USDFC/day`)
        log.flush()
        outro('No deposit needed')
        return
      }
    }

    // Ensure wallet has enough USDFC
    if (depositAmount > walletUsdfcBalance) {
      console.error(
        pc.red(
          `✗ Insufficient USDFC (need ${formatUSDFC(depositAmount)} USDFC, have ${formatUSDFC(walletUsdfcBalance)} USDFC)`
        )
      )
      throw new Error('Insufficient USDFC')
    }

    spinner.start(`Depositing ${formatUSDFC(depositAmount)} USDFC...`)
    const { approvalTx, depositTx } = await depositUSDFC(synapse, depositAmount)
    spinner.stop(`${pc.green('✓')} Deposit complete`)

    log.line(pc.bold('Transaction details:'))
    if (approvalTx) {
      log.indent(pc.gray(`Approval: ${approvalTx}`))
    }
    log.indent(pc.gray(`Deposit: ${depositTx}`))
    log.flush()

    // Brief post-deposit summary
    const updated = await getPaymentStatus(synapse)
    const runway = calculateStorageRunway(updated)
    const runwayDisplay = formatRunwaySummary(runway)

    log.line('')
    log.line(pc.bold('Deposit Summary'))
    log.indent(`Total deposit: ${formatUSDFC(updated.filecoinPayBalance)} USDFC`)
    if (runway.state === 'active') {
      const dailySpend = runway.perDay
      log.indent(`Current spend: ${formatUSDFC(dailySpend)} USDFC/day`)
      log.indent(`Runway: ~${runwayDisplay} at current spend`)
    } else {
      log.indent(pc.gray(runwayDisplay))
    }
    log.flush()

    outro('Deposit completed')
  } catch (error) {
    spinner.stop()
    console.error(pc.red('✗ Deposit failed'))
    console.error(pc.red('Error:'), error instanceof Error ? error.message : error)
    process.exitCode = 1
  } finally {
    await cleanupSynapseService()
  }
}
