/**
 * payments fund command
 *
 * Adjusts funds to exactly match a target runway (days) or a target deposited amount.
 */

import { confirm } from '@clack/prompts'
import { RPC_URLS, Synapse, TIME_CONSTANTS } from '@filoz/synapse-sdk'
import { ethers } from 'ethers'
import pc from 'picocolors'
import { MIN_RUNWAY_DAYS } from '../common/constants.js'
import {
  calculateStorageRunway,
  checkAndSetAllowances,
  checkFILBalance,
  checkUSDFCBalance,
  computeAdjustmentForExactDays,
  computeAdjustmentForExactDaysWithFile,
  computeAdjustmentForExactDeposit,
  depositUSDFC,
  getPaymentStatus,
  validatePaymentRequirements,
  withdrawUSDFC,
} from '../core/payments/index.js'
import { cleanupProvider } from '../core/synapse/index.js'
import { formatUSDFC } from '../core/utils/format.js'
import { formatRunwaySummary } from '../core/utils/index.js'
import type { Spinner } from '../utils/cli-helpers.js'
import { cancel, createSpinner, intro, isInteractive, outro } from '../utils/cli-helpers.js'
import { isTTY, log } from '../utils/cli-logger.js'
import type { AutoFundOptions, FundingAdjustmentResult, FundOptions } from './types.js'

// Helper: confirm/warn or bail when target implies < 10-day runway
async function ensureBelowTenDaysAllowed(opts: {
  spinner: Spinner
  warningLine1: string
  warningLine2: string
}): Promise<void> {
  const { spinner, warningLine1, warningLine2 } = opts
  if (!isInteractive()) {
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
  if (!proceed) {
    throw new Error('Fund adjustment cancelled by user')
  }
}

// Helper: perform deposit or withdraw according to delta
async function performAdjustment(params: {
  synapse: Synapse
  spinner: Spinner
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
    if (isTTY()) {
      // we will deposit `needed` USDFC, display confirmation to user unless not TTY or --auto flag was passed
      const proceed = await confirm({
        message: `Deposit ${formatUSDFC(needed)} USDFC?`,
        initialValue: false,
      })
      if (!proceed) {
        throw new Error('Deposit cancelled by user')
      }
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
    if (isTTY()) {
      // we will withdraw `withdrawAmount` USDFC, display confirmation to user unless not TTY or --auto flag was passed
      const proceed = await confirm({
        message: `Withdraw ${formatUSDFC(withdrawAmount)} USDFC?`,
        initialValue: false,
      })
      if (!proceed) {
        throw new Error('Withdraw cancelled by user')
      }
    }
    spinner.start(withdrawMsg)
    const txHash = await withdrawUSDFC(synapse, withdrawAmount)
    spinner.stop(`${pc.green('✓')} Withdraw complete`)
    log.line(pc.bold('Transaction'))
    log.indent(pc.gray(txHash))
    log.flush()
  }
}

// Helper: summary after adjustment
async function printSummary(synapse: Synapse, title = 'Updated'): Promise<void> {
  const updated = await getPaymentStatus(synapse)
  const runway = calculateStorageRunway(updated)
  const runwayDisplay = formatRunwaySummary(runway)
  log.section(title, [
    `Deposited: ${formatUSDFC(updated.depositedAmount)} USDFC`,
    runway.state === 'active' ? `Runway: ~${runwayDisplay}` : `Runway: ${runwayDisplay}`,
  ])
}

/**
 * Automatically adjust funding to meet target runway or deposit amount.
 * This is a non-interactive version suitable for programmatic use.
 *
 * @param options - Auto-funding options
 * @returns Funding adjustment result
 * @throws Error if adjustment fails or target is unsafe
 */
export async function autoFund(options: AutoFundOptions): Promise<FundingAdjustmentResult> {
  const { synapse, fileSize, spinner } = options

  spinner?.message('Checking wallet readiness...')

  const [filStatus, usdfcBalance] = await Promise.all([checkFILBalance(synapse), checkUSDFCBalance(synapse)])

  const validation = validatePaymentRequirements(filStatus.hasSufficientGas, usdfcBalance, filStatus.isCalibnet)
  if (!validation.isValid) {
    const help = validation.helpMessage ? ` ${validation.helpMessage}` : ''
    throw new Error(`${validation.errorMessage}${help}`)
  }

  spinner?.message('Ensuring WarmStorage permissions...')
  const allowanceResult = await checkAndSetAllowances(synapse)
  spinner?.message(
    allowanceResult.updated ? 'WarmStorage permissions configured' : 'WarmStorage permissions already configured'
  )

  spinner?.message('Calculating funding requirements...')

  // Get current payment status and pricing after ensuring permissions
  const [status, storageInfo] = await Promise.all([getPaymentStatus(synapse), synapse.storage.getStorageInfo()])
  const pricePerTiBPerEpoch = storageInfo.pricing.noCDN.perTiBPerEpoch

  // Calculate funding needed to maintain MIN_RUNWAY_DAYS after uploading this file
  // This accounts for both the file's lockup AND its impact on ongoing costs
  const adj = computeAdjustmentForExactDaysWithFile(status, MIN_RUNWAY_DAYS, fileSize, pricePerTiBPerEpoch)
  const delta = adj.delta

  // Auto-fund only deposits, never withdraws
  if (delta <= 0n) {
    spinner?.message('No additional funding required')
    // Funding already sufficient
    const updated = await getPaymentStatus(synapse)
    const newAvailable = updated.depositedAmount - (updated.currentAllowances.lockupUsed ?? 0n)
    const newPerDay = (updated.currentAllowances.rateUsed ?? 0n) * TIME_CONSTANTS.EPOCHS_PER_DAY
    const newRunway = newPerDay > 0n ? Number(newAvailable / newPerDay) : 0
    const newRunwayHours = newPerDay > 0n ? Number(((newAvailable % newPerDay) * 24n) / newPerDay) : 0

    return {
      adjusted: false,
      delta: 0n,
      newDepositedAmount: updated.depositedAmount,
      newRunwayDays: newRunway,
      newRunwayHours: newRunwayHours,
    }
  }

  // Perform deposit
  if (delta > usdfcBalance) {
    throw new Error(
      `Insufficient USDFC in wallet (need ${formatUSDFC(delta)} USDFC, have ${formatUSDFC(usdfcBalance)} USDFC)`
    )
  }

  const depositMsg = `Depositing ${formatUSDFC(delta)} USDFC to ensure ${MIN_RUNWAY_DAYS} day(s) runway...`
  spinner?.message(depositMsg)
  const depositResult = await depositUSDFC(synapse, delta)
  const approvalTx = depositResult.approvalTx
  const transactionHash = depositResult.depositTx
  spinner?.message(`${pc.green('✓')} Deposit complete`)

  // Get updated status
  const updated = await getPaymentStatus(synapse)
  const newAvailable = updated.depositedAmount - (updated.currentAllowances.lockupUsed ?? 0n)
  const newPerDay = (updated.currentAllowances.rateUsed ?? 0n) * TIME_CONSTANTS.EPOCHS_PER_DAY
  const newRunway = newPerDay > 0n ? Number(newAvailable / newPerDay) : 0
  const newRunwayHours = newPerDay > 0n ? Number(((newAvailable % newPerDay) * 24n) / newPerDay) : 0

  return {
    adjusted: true,
    delta,
    approvalTx,
    transactionHash,
    newDepositedAmount: updated.depositedAmount,
    newRunwayDays: newRunway,
    newRunwayHours: newRunwayHours,
  }
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

  const hasDays = options.days != null
  const hasAmount = options.amount != null
  if ((hasDays && hasAmount) || (!hasDays && !hasAmount)) {
    console.error(pc.red('Error: Specify exactly one of --days <N> or --amount <USDFC>'))
    throw new Error('Invalid fund options')
  }
  if (options.mode != null && !['exact', 'minimum'].includes(options.mode)) {
    console.error(pc.red('Error: Invalid mode'))
    throw new Error(`Invalid mode (must be "exact" or "minimum"), received: '${options.mode}'`)
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

    // Unified planning: derive delta and target context for both modes
    const rateUsed = status.currentAllowances.rateUsed ?? 0n
    const lockupUsed = status.currentAllowances.lockupUsed ?? 0n

    // user provided days or 0 if not provided
    const targetDays: number = hasDays ? Number(options.days) : 0
    // user provided amount or 0n if not provided
    let targetDeposit: bigint = 0n
    try {
      targetDeposit = options.amount != null ? ethers.parseUnits(String(options.amount), 18) : 0n
    } catch {
      console.error(pc.red(`Error: Invalid --amount '${options.amount}'`))
      throw new Error('Invalid --amount')
    }
    let delta: bigint
    let clampedTarget: bigint | null = null
    let runwayCheckDays: number | null = null
    let alreadyMessage: string
    let depositMsg: string
    let withdrawMsg: string

    if (hasDays) {
      if (!Number.isFinite(targetDays) || targetDays < 0) {
        console.error(pc.red('Error: --days must be a non-negative number'))
        throw new Error('Invalid --days')
      }

      const adj = computeAdjustmentForExactDays(status, targetDays)
      if (adj.rateUsed === 0n) {
        log.line(`${pc.red('✗')} No active spend detected (rateUsed = 0). Cannot compute runway.`)
        log.line('Use --amount to set a target deposit instead.')
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
      const adj = computeAdjustmentForExactDeposit(status, targetDeposit)
      delta = adj.delta
      clampedTarget = adj.clampedTarget

      if (targetDeposit < lockupUsed && options.mode !== 'minimum') {
        log.line(pc.yellow('⚠ Target amount is below locked funds. Clamping to locked amount.'))
        log.indent(`Locked: ${formatUSDFC(lockupUsed)} USDFC`)
        log.flush()
      }

      if (rateUsed > 0n) {
        const perDay = rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY
        const availableAfter = clampedTarget > lockupUsed ? clampedTarget - lockupUsed : 0n
        runwayCheckDays = Number(availableAfter / perDay)
      }

      const targetLabel = clampedTarget != null ? formatUSDFC(clampedTarget) : String(options.amount)
      alreadyMessage = `Already at target deposit of ${targetLabel} USDFC. No changes needed.`
      depositMsg = `Depositing ${formatUSDFC(delta)} USDFC to reach ${targetLabel} USDFC total...`
      withdrawMsg = `Withdrawing ${formatUSDFC(-delta)} USDFC to reach ${targetLabel} USDFC total...`
    }

    if (options.mode === 'minimum') {
      if (delta > 0n) {
        if (hasAmount) {
          depositMsg = `Depositing ${formatUSDFC(delta)} USDFC to reach minimum of ${formatUSDFC(
            targetDeposit
          )} USDFC total...`
        } else if (targetDays > 0) {
          depositMsg = `Depositing ${formatUSDFC(delta)} USDFC to reach minimum of ${targetDays} day(s) runway...`
        }
      } else {
        if (delta < 0n) {
          if (hasAmount) {
            alreadyMessage = `Already above minimum deposit of ${formatUSDFC(targetDeposit)} USDFC. No changes needed.`
          } else if (targetDays > 0) {
            alreadyMessage = `Already above minimum of ${targetDays} day(s) runway. No changes needed.`
          }
        }
        delta = 0n
      }
    } else if (runwayCheckDays != null && runwayCheckDays < 10) {
      const line1 = hasDays
        ? 'Requested runway below 10-day safety baseline.'
        : 'Target deposit implies less than 10 days of runway at current spend.'
      const line2 = hasDays
        ? 'WarmStorage reserves 10 days of costs; a shorter runway risks termination.'
        : 'Increase target or accept risk: shorter runway may cause termination.'
      await ensureBelowTenDaysAllowed({
        spinner,
        warningLine1: line1,
        warningLine2: line2,
      })
    }

    if (delta === 0n) {
      await printSummary(synapse, 'No Changes Needed')
      outro(alreadyMessage)
      return
    }

    await performAdjustment({ synapse, spinner, delta, depositMsg, withdrawMsg })

    await printSummary(synapse)
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
