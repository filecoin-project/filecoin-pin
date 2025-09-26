/**
 * Deposit/top-up command for Filecoin Pay
 *
 * Provides two modes:
 * - Explicit amount: --amount <USDFC>
 * - By duration: --days <N> (fund enough to keep current usage alive for N days)
 */

import { RPC_URLS, Synapse, TIME_CONSTANTS } from '@filoz/synapse-sdk'
import { ethers } from 'ethers'
import pc from 'picocolors'
import { computeTopUpForDuration } from '../synapse/payments.js'
import { cleanupProvider } from '../synapse/service.js'
import { cancel, createSpinner, intro, outro } from '../utils/cli-helpers.js'
import { log } from '../utils/cli-logger.js'
import { checkFILBalance, checkUSDFCBalance, depositUSDFC, formatUSDFC, getPaymentStatus } from './setup.js'

export interface DepositOptions {
  privateKey?: string
  rpcUrl?: string
  amount?: string
  days?: number
}

/**
 * Run the deposit/top-up flow
 */
export async function runDeposit(options: DepositOptions): Promise<void> {
  intro(pc.bold('Filecoin Onchain Cloud Deposit'))

  const spinner = createSpinner()

  // Validate inputs
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

  const hasAmount = options.amount != null
  const hasDays = options.days != null

  if ((hasAmount && hasDays) || (!hasAmount && !hasDays)) {
    console.error(pc.red('Error: Specify exactly one of --amount <USDFC> or --days <N>'))
    process.exit(1)
  }

  // Connect
  spinner.start('Connecting...')
  let provider: any = null
  try {
    const synapse = await Synapse.create({ privateKey, rpcURL: rpcUrl })

    if (rpcUrl.match(/^wss?:\/\//)) {
      provider = synapse.getProvider()
    }

    const [filStatus, usdfcBalance, status] = await Promise.all([
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
      await cleanupProvider(provider)
      cancel('Deposit aborted')
      process.exit(1)
    }

    let depositAmount: bigint = 0n

    if (hasAmount) {
      try {
        depositAmount = ethers.parseUnits(String(options.amount), 18)
      } catch {
        console.error(pc.red(`Error: Invalid amount '${options.amount}'`))
        process.exit(1)
      }

      if (depositAmount <= 0n) {
        console.error(pc.red('Error: Amount must be greater than 0'))
        process.exit(1)
      }
    } else if (hasDays) {
      const days = Number(options.days)
      if (!Number.isFinite(days) || days <= 0) {
        console.error(pc.red('Error: --days must be a positive number'))
        process.exit(1)
      }

      const { topUp, rateUsed, perDay } = computeTopUpForDuration(status, days)

      if (rateUsed === 0n) {
        spinner.stop()
        log.line(`${pc.yellow('⚠')} No active storage payments detected (rateUsed = 0)`)
        log.line('Use --amount to deposit a specific USDFC value instead.')
        log.flush()
        await cleanupProvider(provider)
        cancel('Nothing to fund by duration')
        process.exit(1)
      }

      depositAmount = topUp

      if (depositAmount === 0n) {
        spinner.stop()
        log.line(`${pc.green('✓')} Already funded for at least ${days} day(s) at current spend rate`)
        log.indent(`Current daily spend: ${formatUSDFC(perDay)} USDFC/day`)
        log.flush()
        await cleanupProvider(provider)
        outro('No deposit needed')
        return
      }
    }

    // Ensure wallet has enough USDFC
    if (depositAmount > usdfcBalance) {
      console.error(
        pc.red(
          `✗ Insufficient USDFC (need ${formatUSDFC(depositAmount)} USDFC, have ${formatUSDFC(usdfcBalance)} USDFC)`
        )
      )
      process.exit(1)
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
    const lockupUsed = updated.currentAllowances.lockupUsed ?? 0n
    const rateUsed = updated.currentAllowances.rateUsed ?? 0n
    const available = updated.depositedAmount > lockupUsed ? updated.depositedAmount - lockupUsed : 0n
    const dailySpend = rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY
    const runwayDays = rateUsed > 0n ? Number(available / dailySpend) : 0

    log.line('')
    log.line(pc.bold('Deposit Summary'))
    log.indent(`Total deposit: ${formatUSDFC(updated.depositedAmount)} USDFC`)
    if (rateUsed > 0n) {
      log.indent(`Current spend: ${formatUSDFC(dailySpend)} USDFC/day`)
      log.indent(`Runway: ~${runwayDays} days at current spend`)
    }
    log.flush()

    await cleanupProvider(provider)
    outro('Deposit completed')
  } catch (error) {
    spinner.stop()
    console.error(pc.red('✗ Deposit failed'))
    console.error(pc.red('Error:'), error instanceof Error ? error.message : error)
    process.exitCode = 1
  } finally {
    await cleanupProvider(provider)
  }
}
