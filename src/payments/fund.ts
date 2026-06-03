/**
 * payments fund command
 *
 * Adjusts funds to exactly match a target runway (days) or a target deposited amount.
 */

import { confirm } from '@clack/prompts'
import type { Synapse } from '@filoz/synapse-sdk'
import pc from 'picocolors'
import { parseUnits } from 'viem'
import { CliFatal, isCliFatal } from '../common/cli-errors.js'
import { MIN_RUNWAY_DAYS } from '../common/constants.js'
import {
  checkUSDFCBalance,
  clampDepositToLimit,
  DEFAULT_LOCKUP_DAYS,
  depositUSDFC,
  executeFilecoinPayFunding,
  planFilecoinPayFunding,
  toStorageRunwaySummary,
  withdrawUSDFC,
} from '../core/payments/index.js'
import { initializeSynapse } from '../core/synapse/index.js'
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
    log.line(pc.red(warningLine1))
    log.line(pc.red(warningLine2))
    log.flush()
    cancel('Fund adjustment aborted')
    throw new CliFatal(`Unsafe target below ${DEFAULT_LOCKUP_DAYS}-day baseline`)
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
      throw new Error(
        `Insufficient USDFC in wallet (need ${formatUSDFC(needed)} USDFC, have ${formatUSDFC(usdfcWallet)} USDFC)`
      )
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
  const summary = await synapse.payments.accountSummary({})
  const runway = toStorageRunwaySummary(summary)
  const runwayDisplay = formatRunwaySummary(runway)
  const lines = [`Deposited: ${formatUSDFC(summary.funds)} USDFC`]
  if (runway.state === 'active') {
    lines.push(`Storage covered: ~${runwayDisplay.coverage} total`)
    lines.push(`Top-up needed in: ~${runwayDisplay.runway}`)
  } else {
    lines.push(runwayDisplay.coverage)
  }
  log.section(title, lines)
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
  const { synapse, fileSize, copies, providerIds, dataSetIds, metadata, spinner, maxBalance, withCDN } = options
  const targetRunwayDays = options.minRunwayDays ?? MIN_RUNWAY_DAYS

  spinner?.message('Checking wallet readiness...')

  const contexts = await synapse.storage.createContexts({
    ...(copies != null ? { copies } : {}),
    ...(providerIds != null ? { providerIds } : {}),
    ...(dataSetIds != null ? { dataSetIds } : {}),
    ...(metadata != null ? { metadata } : {}),
  })
  const newDataSetCount = contexts.filter((context) => context.dataSetId == null).length

  const planResult = await planFilecoinPayFunding({
    synapse,
    targetRunwayDays,
    pieceSizeBytes: fileSize,
    newDataSetCount,
    withCDN: withCDN === true,
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
      newRunwayDays: plan.projected.runway.runwayDays,
      newRunwayHours: plan.projected.runway.runwayHours,
    }
  }

  // Apply --max-balance ceiling (skip or clamp the planned deposit)
  const warnings: string[] = []
  const clamp = clampDepositToLimit(status.filecoinPayBalance, plan.delta, maxBalance)
  if (clamp.reason === 'already-at-limit') {
    if (clamp.message) warnings.push(clamp.message)
    return {
      adjusted: false,
      delta: 0n,
      newDepositedAmount: status.filecoinPayBalance,
      newRunwayDays: plan.current.runway.runwayDays,
      newRunwayHours: plan.current.runway.runwayHours,
      warnings,
    }
  }
  if (clamp.reason === 'clamped' && clamp.message != null) {
    warnings.push(clamp.message)
  }
  const adjustedPlan = clamp.deposit !== plan.delta ? { ...plan, delta: clamp.deposit } : plan

  if (status.walletUsdfcBalance < adjustedPlan.delta) {
    throw new Error(
      `Insufficient USDFC in wallet (need ${formatUSDFC(adjustedPlan.delta)} USDFC, have ${formatUSDFC(status.walletUsdfcBalance)} USDFC)`
    )
  }

  const depositMsg =
    clamp.reason === 'clamped'
      ? `Depositing ${formatUSDFC(adjustedPlan.delta)} USDFC toward ${targetRunwayDays} day(s) runway (limited by --max-balance)...`
      : `Depositing ${formatUSDFC(adjustedPlan.delta)} USDFC to ensure at least ${targetRunwayDays} day(s) runway...`
  spinner?.message(depositMsg)
  const execution = await executeFilecoinPayFunding(synapse, adjustedPlan)
  spinner?.message(`${pc.green('✓')} Deposit complete`)

  return {
    adjusted: execution.adjusted,
    delta: adjustedPlan.delta,
    transactionHash: execution.transactionHash,
    newDepositedAmount: execution.newDepositedAmount,
    newRunwayDays: execution.newRunwayDays,
    newRunwayHours: execution.newRunwayHours,
    warnings,
  }
}

export async function runFund(options: FundOptions): Promise<void> {
  intro(pc.bold('Filecoin Onchain Cloud Fund Adjustment'))
  const spinner = createSpinner()

  // Validate inputs
  const hasDays = options.days != null
  const hasAmount = options.amount != null
  if ((hasDays && hasAmount) || (!hasDays && !hasAmount)) {
    log.line(pc.red('Error: Specify exactly one of --target-days <N> or --amount <USDFC>'))
    log.flush()
    throw new CliFatal('Specify exactly one of --target-days <N> or --amount <USDFC>')
  }
  if (options.mode != null && !['exact', 'minimum'].includes(options.mode)) {
    log.line(pc.red(`Error: Invalid mode (must be "exact" or "minimum"), received: '${options.mode}'`))
    log.flush()
    throw new CliFatal(`Invalid mode (must be "exact" or "minimum"), received: '${options.mode}'`)
  }

  spinner.start('Connecting...')
  try {
    // Parse and validate authentication
    const authConfig = parseCLIAuth(options)

    const logger = getCLILogger()
    const synapse = await initializeSynapse(authConfig, logger)

    spinner.stop(`${pc.green('✓')} Connected`)

    const targetDays: number = hasDays ? Number(options.days) : 0
    if (hasDays && (!Number.isFinite(targetDays) || targetDays < 0)) {
      throw new Error('--target-days must be a non-negative number')
    }

    let targetDeposit: bigint = 0n
    try {
      targetDeposit = options.amount != null ? parseUnits(String(options.amount), 18) : 0n
    } catch {
      throw new Error(`Invalid --amount '${options.amount}'`)
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
      throw new CliFatal('No active spend')
    }

    // Safety baseline measures projected top-up window (net runway after deposit),
    // sourced from the SDK so --days and --amount paths share one metric.
    const projectedRunwayDays = plan.projected.runway.state === 'active' ? plan.projected.runway.runwayDays : null

    if (plan.mode !== 'minimum' && projectedRunwayDays != null && projectedRunwayDays < DEFAULT_LOCKUP_DAYS) {
      const line1 = `Projected top-up window after this adjustment is less than ${DEFAULT_LOCKUP_DAYS} days.`
      const line2 = `WarmStorage reserves ${DEFAULT_LOCKUP_DAYS} days of costs; a shorter top-up window risks termination.`
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
      throw new Error(
        `Insufficient USDFC in wallet (need ${formatUSDFC(plan.delta)} USDFC, have ${formatUSDFC(planResult.status.walletUsdfcBalance)} USDFC)`
      )
    }

    await performAdjustment({
      synapse,
      spinner,
      delta: plan.delta,
      depositMsg,
      withdrawMsg,
    })

    await printSummary(synapse)
    outro('Fund adjustment completed')
  } catch (error) {
    if (isCliFatal(error)) {
      spinner.stop()
      throw error
    }
    const msg = error instanceof Error ? error.message : String(error)
    spinner.stop(`${pc.red('✗')} Fund adjustment failed: ${msg}`)
    cancel('Fund adjustment failed')
    throw new CliFatal(msg, { cause: error instanceof Error ? error : undefined })
  }
}
