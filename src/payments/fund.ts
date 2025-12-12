/**
 * payments fund command
 *
 * Adjusts funds to exactly match a target runway (days) or a target deposited amount.
 */

import { confirm } from '@clack/prompts'
import type { Synapse } from '@filoz/synapse-sdk'
import { ethers } from 'ethers'
import pc from 'picocolors'
import { MIN_RUNWAY_DAYS, TELEMETRY_CLI_APP_NAME } from '../common/constants.js'
import {
  calculateStorageRunway,
  checkUSDFCBalance,
  DEFAULT_LOCKUP_DAYS,
  depositUSDFC,
  executeFilecoinPayFunding,
  getPaymentStatus,
  planFilecoinPayFunding,
  withdrawUSDFC,
} from '../core/payments/index.js'
import { cleanupSynapseService, initializeSynapse } from '../core/synapse/index.js'
import { formatUSDFC } from '../core/utils/format.js'
import { formatRunwaySummary } from '../core/utils/index.js'
import { getCLILogger, parseCLIAuth } from '../utils/cli-auth.js'
import type { Spinner } from '../utils/cli-helpers.js'
import { cancel, createSpinner, intro, isInteractive, outro } from '../utils/cli-helpers.js'
import { isTTY, log } from '../utils/cli-logger.js'
import type { AutoFundOptions, FundingAdjustmentResult, FundOptions } from './types.js'

// Helper: confirm/warn or bail when target implies < lockup-days runway
async function ensureBelowThirtyDaysAllowed(opts: {
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
    throw new Error(`Unsafe target below ${DEFAULT_LOCKUP_DAYS}-day baseline`)
  }

  log.line(pc.yellow('⚠ Warning'))
  log.indent(pc.yellow(warningLine1))
  log.indent(pc.yellow(warningLine2))
  log.flush()

  const proceed = await confirm({
    message: 'Proceed with reducing runway below 30 days?',
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
    const { depositTx } = await depositUSDFC(synapse, needed)
    spinner.stop(`${pc.green('✓')} Deposit complete`)
    log.line(pc.bold('Transaction details:'))
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
    `Deposited: ${formatUSDFC(updated.filecoinPayBalance)} USDFC`,
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

  const planResult = await planFilecoinPayFunding({
    synapse,
    targetRunwayDays: MIN_RUNWAY_DAYS,
    pieceSizeBytes: fileSize,
    ensureAllowances: true,
    allowWithdraw: false,
  })
  const { plan, status, allowances } = planResult

  spinner?.message(
    allowances.updated ? 'WarmStorage permissions configured' : 'WarmStorage permissions already configured'
  )
  spinner?.message('Calculating funding requirements...')

  // Auto-fund only deposits, never withdraws
  if (plan.delta <= 0n) {
    spinner?.message('No additional funding required')
    return {
      adjusted: false,
      delta: 0n,
      newDepositedAmount: plan.projected.depositedBalance,
      newRunwayDays: plan.projected.runway.days,
      newRunwayHours: plan.projected.runway.hours,
    }
  }

  if (plan.walletShortfall != null && plan.walletShortfall > 0n) {
    throw new Error(
      `Insufficient USDFC in wallet (need ${formatUSDFC(plan.delta)} USDFC, have ${formatUSDFC(status.walletUsdfcBalance)} USDFC)`
    )
  }

  const depositMsg = `Depositing ${formatUSDFC(plan.delta)} USDFC to ensure ${MIN_RUNWAY_DAYS} day(s) runway...`
  spinner?.message(depositMsg)
  const execution = await executeFilecoinPayFunding(synapse, plan)
  spinner?.message(`${pc.green('✓')} Deposit complete`)

  return {
    adjusted: execution.adjusted,
    delta: plan.delta,
    transactionHash: execution.transactionHash,
    newDepositedAmount: execution.newDepositedAmount,
    newRunwayDays: execution.newRunwayDays,
    newRunwayHours: execution.newRunwayHours,
  }
}

export async function runFund(options: FundOptions): Promise<void> {
  intro(pc.bold('Filecoin Onchain Cloud Fund Adjustment'))
  const spinner = createSpinner()

  // Validate inputs
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

  spinner.start('Connecting...')
  try {
    // Parse and validate authentication
    const authConfig = parseCLIAuth(options)

    const logger = getCLILogger()
    const synapse = await initializeSynapse(
      { ...authConfig, telemetry: { sentrySetTags: { appName: TELEMETRY_CLI_APP_NAME } } },
      logger
    )

    spinner.stop(`${pc.green('✓')} Connected`)

    const targetDays: number = hasDays ? Number(options.days) : 0
    if (hasDays && (!Number.isFinite(targetDays) || targetDays < 0)) {
      console.error(pc.red('Error: --days must be a non-negative number'))
      throw new Error('Invalid --days')
    }

    let targetDeposit: bigint = 0n
    try {
      targetDeposit = options.amount != null ? ethers.parseUnits(String(options.amount), 18) : 0n
    } catch {
      console.error(pc.red(`Error: Invalid --amount '${options.amount}'`))
      throw new Error('Invalid --amount')
    }

    spinner.start('Calculating funding plan...')
    const planResult = await planFilecoinPayFunding({
      synapse,
      targetRunwayDays: hasDays ? targetDays : undefined,
      targetDeposit: hasAmount ? targetDeposit : undefined,
      mode: options.mode ?? 'exact',
      allowWithdraw: options.mode !== 'minimum',
    })
    const { plan } = planResult
    spinner.stop(`${pc.green('✓')} Funding plan prepared`)

    if (plan.targetType === 'runway-days' && plan.current.runway.rateUsed === 0n) {
      log.line(`${pc.red('✗')} No active spend detected (rateUsed = 0). Cannot compute runway.`)
      log.line('Use --amount to set a target deposit instead.')
      log.flush()
      cancel('Fund adjustment aborted')
      throw new Error('No active spend')
    }

    let projectedRunwayTarget: number | null = null
    if (plan.projected.runway.state === 'active') {
      projectedRunwayTarget =
        plan.targetType === 'runway-days' ? (plan.targetRunwayDays ?? 0) : plan.projected.runway.days
    }

    if (plan.mode !== 'minimum' && projectedRunwayTarget != null && projectedRunwayTarget < DEFAULT_LOCKUP_DAYS) {
      const line1 =
        plan.targetType === 'runway-days'
          ? 'Requested runway below 30-day safety baseline.'
          : 'Target deposit implies less than 30 days of runway at current spend.'
      const line2 =
        plan.targetType === 'runway-days'
          ? 'WarmStorage reserves 30 days of costs; a shorter runway risks termination.'
          : 'Increase target or accept risk: shorter runway may cause termination.'
      await ensureBelowThirtyDaysAllowed({
        spinner,
        warningLine1: line1,
        warningLine2: line2,
      })
    }

    const targetDepositLabel = formatUSDFC(plan.targetDeposit ?? targetDeposit)

    let alreadyMessage: string
    if (plan.targetType === 'runway-days') {
      const runwayLabel = plan.targetRunwayDays ?? 0
      alreadyMessage =
        plan.mode === 'minimum'
          ? `Already above minimum of ${runwayLabel} day(s) runway. No changes needed.`
          : `Already at target of ~${runwayLabel} day(s). No changes needed.`
    } else {
      alreadyMessage =
        plan.mode === 'minimum'
          ? `Already above minimum deposit of ${targetDepositLabel} USDFC. No changes needed.`
          : `Already at target deposit of ${targetDepositLabel} USDFC. No changes needed.`
    }

    let depositMsg: string
    let withdrawMsg: string
    if (plan.targetType === 'runway-days') {
      const runwayLabel = plan.targetRunwayDays ?? 0
      depositMsg = `Depositing ${formatUSDFC(plan.delta)} USDFC to reach ~${runwayLabel} day(s) runway...`
      withdrawMsg = `Withdrawing ${formatUSDFC(-plan.delta)} USDFC to reach ~${runwayLabel} day(s) runway...`
    } else {
      depositMsg = `Depositing ${formatUSDFC(plan.delta)} USDFC to reach ${targetDepositLabel} USDFC total...`
      withdrawMsg = `Withdrawing ${formatUSDFC(-plan.delta)} USDFC to reach ${targetDepositLabel} USDFC total...`
    }

    if (plan.mode === 'minimum' && plan.delta > 0n) {
      if (hasAmount) {
        depositMsg = `Depositing ${formatUSDFC(plan.delta)} USDFC to reach minimum of ${targetDepositLabel} USDFC total...`
      } else if (targetDays > 0) {
        depositMsg = `Depositing ${formatUSDFC(plan.delta)} USDFC to reach minimum of ${targetDays} day(s) runway...`
      }
    }

    if (plan.delta === 0n) {
      await printSummary(synapse, 'No Changes Needed')
      outro(alreadyMessage)
      return
    }

    if (plan.walletShortfall != null && plan.walletShortfall > 0n) {
      spinner.stop()
      console.error(
        pc.red(
          `✗ Insufficient USDFC in wallet (need ${formatUSDFC(plan.delta)} USDFC, have ${formatUSDFC(planResult.status.walletUsdfcBalance)} USDFC)`
        )
      )
      cancel('Fund adjustment aborted')
      throw new Error('Insufficient USDFC in wallet')
    }

    await performAdjustment({ synapse, spinner, delta: plan.delta, depositMsg, withdrawMsg })

    await printSummary(synapse)
    outro('Fund adjustment completed')
  } catch (error) {
    spinner.stop()
    console.error(pc.red('✗ Fund adjustment failed'))
    console.error(pc.red('Error:'), error instanceof Error ? error.message : error)
    process.exitCode = 1
  } finally {
    await cleanupSynapseService()
  }
}
