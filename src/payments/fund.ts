/**
 * payments fund command
 *
 * Adjusts funds to exactly match a target runway (days) or a target deposited amount.
 */

import { confirm, isCancel } from '@clack/prompts'
import { RPC_URLS, Synapse, TIME_CONSTANTS } from '@filoz/synapse-sdk'
import { ethers } from 'ethers'
import pc from 'picocolors'
import { computeAdjustmentForExactDays, computeAdjustmentForExactDeposit } from '../synapse/payments.js'
import { cleanupProvider } from '../synapse/service.js'
import { cancel, createSpinner, intro, outro } from '../utils/cli-helpers.js'
import { isTTY, log } from '../utils/cli-logger.js'
import {
  checkFILBalance,
  checkUSDFCBalance,
  depositUSDFC,
  formatUSDFC,
  getPaymentStatus,
  withdrawUSDFC,
} from './setup.js'

export interface FundOptions {
  privateKey?: string
  rpcUrl?: string
  exactDays?: number
  exactAmount?: string
}

// Helper: confirm/warn or bail when target implies < 10-day runway
async function ensureBelowTenDaysAllowed(opts: {
  isCI: boolean
  isInteractive: boolean
  spinner: any
  warningLine1: string
  warningLine2: string
}): Promise<void> {
  const { isCI, isInteractive, spinner, warningLine1, warningLine2 } = opts
  if (isCI || !isInteractive) {
    spinner.stop()
    console.error(pc.red(warningLine1))
    console.error(pc.red(warningLine2))
    cancel('Fund adjustment aborted')
    throw new Error('Unsafe target below 10-day baseline')
  }

  log.line(pc.yellow('⚠ Warning'))
  log.indent(pc.yellow(warningLine1))
  log.indent(pc.yellow(warningLine2))
  log.flush()

  const proceed = await confirm({
    message: 'Proceed with reducing runway below 10 days?',
    initialValue: false,
  })
  if (isCancel(proceed)) {
    cancel('Fund adjustment cancelled')
    throw new Error('Cancelled by user')
  }
}

// Helper: perform deposit or withdraw according to delta
async function performAdjustment(params: {
  synapse: Synapse
  spinner: any
  delta: bigint
  depositMsg: string
  withdrawMsg: string
}): Promise<void> {
  const { synapse, spinner, delta, depositMsg, withdrawMsg } = params
  if (delta > 0n) {
    const needed = delta
    const usdfcWallet = await checkUSDFCBalance(synapse)
    if (needed > usdfcWallet) {
      console.error(
        pc.red(
          `✗ Insufficient USDFC in wallet (need ${formatUSDFC(needed)} USDFC, have ${formatUSDFC(usdfcWallet)} USDFC)`
        )
      )
      throw new Error('Insufficient USDFC in wallet')
    }
    spinner.start(depositMsg)
    const { approvalTx, depositTx } = await depositUSDFC(synapse, needed)
    spinner.stop(`${pc.green('✓')} Deposit complete`)
    log.line(pc.bold('Transaction details:'))
    if (approvalTx) log.indent(pc.gray(`Approval: ${approvalTx}`))
    log.indent(pc.gray(`Deposit: ${depositTx}`))
    log.flush()
  } else if (delta < 0n) {
    const withdrawAmount = -delta
    spinner.start(withdrawMsg)
    const txHash = await withdrawUSDFC(synapse, withdrawAmount)
    spinner.stop(`${pc.green('✓')} Withdraw complete`)
    log.line(pc.bold('Transaction'))
    log.indent(pc.gray(txHash))
    log.flush()
  }
}

// Helper: summary after adjustment
async function printUpdatedSummary(synapse: Synapse): Promise<void> {
  const updated = await getPaymentStatus(synapse)
  const newAvailable = updated.depositedAmount - (updated.currentAllowances.lockupUsed ?? 0n)
  const newPerDay = (updated.currentAllowances.rateUsed ?? 0n) * TIME_CONSTANTS.EPOCHS_PER_DAY
  const newRunway = newPerDay > 0n ? Number(newAvailable / newPerDay) : 0
  const newRunwayHours = newPerDay > 0n ? Number(((newAvailable % newPerDay) * 24n) / newPerDay) : 0
  log.section('Updated', [
    `Deposited: ${formatUSDFC(updated.depositedAmount)} USDFC`,
    `Runway: ~${newRunway} day(s)${newRunwayHours > 0 ? ` ${newRunwayHours} hour(s)` : ''}`,
  ])
}

export async function runFund(options: FundOptions): Promise<void> {
  intro(pc.bold('Filecoin Onchain Cloud Fund Adjustment'))
  const spinner = createSpinner()

  // Validate inputs
  const privateKey = options.privateKey || process.env.PRIVATE_KEY
  if (!privateKey) {
    console.error(pc.red('Error: Private key required via --private-key or PRIVATE_KEY env'))
    throw new Error('Missing private key')
  }
  try {
    new ethers.Wallet(privateKey)
  } catch {
    console.error(pc.red('Error: Invalid private key format'))
    throw new Error('Invalid private key format')
  }

  const hasExactDays = options.exactDays != null
  const hasExactAmount = options.exactAmount != null
  if ((hasExactDays && hasExactAmount) || (!hasExactDays && !hasExactAmount)) {
    console.error(pc.red('Error: Specify exactly one of --exact-days <N> or --exact-amount <USDFC>'))
    throw new Error('Invalid fund options')
  }

  const rpcUrl = options.rpcUrl || process.env.RPC_URL || RPC_URLS.calibration.websocket

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
      cancel('Fund adjustment aborted')
      throw new Error('Insufficient FIL for gas fees')
    }

    const status = await getPaymentStatus(synapse)
    // Finish connection phase spinner before proceeding
    spinner.stop(`${pc.green('✓')} Connected`)

    const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true'
    const interactive = isTTY()

    // Unified planning: derive delta and target context for both modes
    const rateUsed = status.currentAllowances.rateUsed ?? 0n
    const lockupUsed = status.currentAllowances.lockupUsed ?? 0n

    let delta: bigint
    let targetDays: number | null = null
    let clampedTarget: bigint | null = null
    let runwayCheckDays: number | null = null
    let alreadyMessage: string
    let depositMsg: string
    let withdrawMsg: string

    if (hasExactDays) {
      targetDays = Number(options.exactDays)
      if (!Number.isFinite(targetDays) || targetDays < 0) {
        console.error(pc.red('Error: --exact-days must be a non-negative number'))
        throw new Error('Invalid --exact-days')
      }

      const adj = computeAdjustmentForExactDays(status, targetDays)
      if (adj.rateUsed === 0n) {
        log.line(`${pc.red('✗')} No active spend detected (rateUsed = 0). Cannot compute runway.`)
        log.line('Use --exact-amount to set a target deposit instead.')
        log.flush()
        cancel('Fund adjustment aborted')
        throw new Error('No active spend')
      }

      delta = adj.delta
      runwayCheckDays = targetDays
      alreadyMessage = `Already at target of ~${targetDays} day(s). No changes needed.`
      depositMsg = `Depositing ${formatUSDFC(delta)} USDFC to reach ~${targetDays} day(s) runway...`
      withdrawMsg = `Withdrawing ${formatUSDFC(-delta)} USDFC to reach ~${targetDays} day(s) runway...`
    } else {
      let targetDeposit: bigint
      try {
        targetDeposit = ethers.parseUnits(String(options.exactAmount), 18)
      } catch {
        console.error(pc.red(`Error: Invalid --exact-amount '${options.exactAmount}'`))
        throw new Error('Invalid --exact-amount')
      }

      const adj = computeAdjustmentForExactDeposit(status, targetDeposit)
      delta = adj.delta
      clampedTarget = adj.clampedTarget

      if (targetDeposit < lockupUsed) {
        log.line(pc.yellow('⚠ Target amount is below locked funds. Clamping to locked amount.'))
        log.indent(`Locked: ${formatUSDFC(lockupUsed)} USDFC`)
        log.flush()
      }

      if (rateUsed > 0n) {
        const perDay = rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY
        const availableAfter = clampedTarget > lockupUsed ? clampedTarget - lockupUsed : 0n
        runwayCheckDays = Number(availableAfter / perDay)
      }

      const targetLabel = clampedTarget != null ? formatUSDFC(clampedTarget) : String(options.exactAmount)
      alreadyMessage = `Already at target deposit of ${targetLabel} USDFC. No changes needed.`
      depositMsg = `Depositing ${formatUSDFC(delta)} USDFC to reach ${targetLabel} USDFC total...`
      withdrawMsg = `Withdrawing ${formatUSDFC(-delta)} USDFC to reach ${targetLabel} USDFC total...`
    }

    if (runwayCheckDays != null && runwayCheckDays < 10) {
      const line1 = hasExactDays
        ? 'Requested runway below 10-day safety baseline.'
        : 'Target deposit implies less than 10 days of runway at current spend.'
      const line2 = hasExactDays
        ? 'WarmStorage reserves 10 days of costs; a shorter runway risks termination.'
        : 'Increase target or accept risk: shorter runway may cause termination.'
      await ensureBelowTenDaysAllowed({
        isCI,
        isInteractive: interactive,
        spinner,
        warningLine1: line1,
        warningLine2: line2,
      })
    }

    if (delta === 0n) {
      outro(alreadyMessage)
      return
    }

    await performAdjustment({ synapse, spinner, delta, depositMsg, withdrawMsg })

    await printUpdatedSummary(synapse)
    outro('Fund adjustment completed')
  } catch (error) {
    spinner.stop()
    console.error(pc.red('✗ Fund adjustment failed'))
    console.error(pc.red('Error:'), error instanceof Error ? error.message : error)
    process.exitCode = 1
  } finally {
    await cleanupProvider(provider)
  }
}
