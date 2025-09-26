/**
 * payments fund command
 *
 * Adjusts funds to exactly match a target runway (days) or a target deposited amount.
 */

import { RPC_URLS, Synapse, TIME_CONSTANTS } from '@filoz/synapse-sdk'
import { ethers } from 'ethers'
import pc from 'picocolors'
import { computeAdjustmentForExactDays, computeAdjustmentForExactDeposit } from '../synapse/payments.js'
import { cleanupProvider } from '../synapse/service.js'
import { cancel, createSpinner, intro, outro } from '../utils/cli-helpers.js'
import { log } from '../utils/cli-logger.js'
import { checkFILBalance, depositUSDFC, formatUSDFC, getPaymentStatus, withdrawUSDFC } from './setup.js'

export interface FundOptions {
  privateKey?: string
  rpcUrl?: string
  exactDays?: number
  exactAmount?: string
}

export async function runFund(options: FundOptions): Promise<void> {
  intro(pc.bold('Filecoin Onchain Cloud Fund Adjustment'))
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

  const hasExactDays = options.exactDays != null
  const hasExactAmount = options.exactAmount != null
  if ((hasExactDays && hasExactAmount) || (!hasExactDays && !hasExactAmount)) {
    console.error(pc.red('Error: Specify exactly one of --exact-days <N> or --exact-amount <USDFC>'))
    process.exit(1)
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
      await cleanupProvider(provider)
      cancel('Fund adjustment aborted')
      process.exit(1)
    }

    const status = await getPaymentStatus(synapse)
    // Finish connection phase spinner before proceeding
    spinner.stop(`${pc.green('✓')} Connected`)

    if (hasExactDays) {
      const targetDays = Number(options.exactDays)
      if (!Number.isFinite(targetDays) || targetDays < 0) {
        console.error(pc.red('Error: --exact-days must be a non-negative number'))
        process.exit(1)
      }

      const { delta, perDay, rateUsed, available, lockupUsed } = computeAdjustmentForExactDays(status, targetDays)

      if (rateUsed === 0n) {
        log.line(`${pc.red('✗')} No active spend detected (rateUsed = 0). Cannot compute runway.`)
        log.line('Use --exact-amount to set a target deposit instead.')
        log.flush()
        await cleanupProvider(provider)
        cancel('Fund adjustment aborted')
        process.exit(1)
      }

      const dailyStr = formatUSDFC(perDay)
      const availableStr = formatUSDFC(available)
      const lockedStr = formatUSDFC(lockupUsed)
      const runwayDays = Number(available / perDay)
      const infoLines = [
        `Current daily spend: ${dailyStr} USDFC/day`,
        `Available: ${availableStr} USDFC (locked: ${lockedStr} USDFC)`,
        `Current runway: ~${runwayDays} day(s)`,
      ]
      log.section('Current Usage', infoLines)

      if (delta === 0n) {
        outro(`Already at target of ~${targetDays} day(s). No changes needed.`)
        await cleanupProvider(provider)
        return
      } else if (delta > 0n) {
        // Need to deposit
        const needed = delta
        const usdfcWallet = await (async () => {
          const { checkUSDFCBalance } = await import('./setup.js')
          return await checkUSDFCBalance(synapse)
        })()
        if (needed > usdfcWallet) {
          console.error(
            pc.red(
              `✗ Insufficient USDFC in wallet (need ${formatUSDFC(needed)} USDFC, have ${formatUSDFC(usdfcWallet)} USDFC)`
            )
          )
          process.exit(1)
        }
        spinner.start(`Depositing ${formatUSDFC(needed)} USDFC to reach ~${targetDays} day(s) runway...`)
        const { approvalTx, depositTx } = await depositUSDFC(synapse, needed)
        spinner.stop(`${pc.green('✓')} Deposit complete`)
        log.line(pc.bold('Transaction details:'))
        if (approvalTx) log.indent(pc.gray(`Approval: ${approvalTx}`))
        log.indent(pc.gray(`Deposit: ${depositTx}`))
        log.flush()
      } else {
        // Can withdraw
        const withdrawAmount = -delta
        spinner.start(`Withdrawing ${formatUSDFC(withdrawAmount)} USDFC to reach ~${targetDays} day(s) runway...`)
        const txHash = await withdrawUSDFC(synapse, withdrawAmount)
        spinner.stop(`${pc.green('✓')} Withdraw complete`)
        log.line(pc.bold('Transaction'))
        log.indent(pc.gray(txHash))
        log.flush()
      }

      // Summary
      const updated = await getPaymentStatus(synapse)
      const newAvailable = updated.depositedAmount - (updated.currentAllowances.lockupUsed ?? 0n)
      const newPerDay = (updated.currentAllowances.rateUsed ?? 0n) * TIME_CONSTANTS.EPOCHS_PER_DAY
      const newRunway = newPerDay > 0n ? Number(newAvailable / newPerDay) : 0
      const newRunwayHours = newPerDay > 0n ? Number(((newAvailable % newPerDay) * 24n) / newPerDay) : 0
      log.section('Updated', [
        `Deposited: ${formatUSDFC(updated.depositedAmount)} USDFC`,
        `Runway: ~${newRunway} day(s)${newRunwayHours > 0 ? ` ${newRunwayHours} hour(s)` : ''}`,
      ])
      await cleanupProvider(provider)
      outro('Fund adjustment completed')
      return
    }

    // exact-amount path
    let targetDeposit: bigint
    try {
      targetDeposit = ethers.parseUnits(String(options.exactAmount), 18)
    } catch {
      console.error(pc.red(`Error: Invalid --exact-amount '${options.exactAmount}'`))
      process.exit(1)
    }

    const { delta, clampedTarget, lockupUsed } = computeAdjustmentForExactDeposit(status, targetDeposit)

    if (targetDeposit < lockupUsed) {
      log.line(pc.yellow('⚠ Target amount is below locked funds. Clamping to locked amount.'))
      log.indent(`Locked: ${formatUSDFC(lockupUsed)} USDFC`)
      log.flush()
    }

    if (delta === 0n) {
      outro(`Already at target deposit of ${formatUSDFC(clampedTarget)} USDFC. No changes needed.`)
      await cleanupProvider(provider)
      return
    } else if (delta > 0n) {
      const needed = delta
      const usdfcWallet = await (async () => {
        const { checkUSDFCBalance } = await import('./setup.js')
        return await checkUSDFCBalance(synapse)
      })()
      if (needed > usdfcWallet) {
        console.error(
          pc.red(
            `✗ Insufficient USDFC in wallet (need ${formatUSDFC(needed)} USDFC, have ${formatUSDFC(usdfcWallet)} USDFC)`
          )
        )
        process.exit(1)
      }
      spinner.start(`Depositing ${formatUSDFC(needed)} USDFC to reach ${formatUSDFC(clampedTarget)} USDFC total...`)
      const { approvalTx, depositTx } = await depositUSDFC(synapse, needed)
      spinner.stop(`${pc.green('✓')} Deposit complete`)
      log.line(pc.bold('Transaction details:'))
      if (approvalTx) log.indent(pc.gray(`Approval: ${approvalTx}`))
      log.indent(pc.gray(`Deposit: ${depositTx}`))
      log.flush()
    } else {
      const withdrawAmount = -delta
      spinner.start(
        `Withdrawing ${formatUSDFC(withdrawAmount)} USDFC to reach ${formatUSDFC(clampedTarget)} USDFC total...`
      )
      const txHash = await withdrawUSDFC(synapse, withdrawAmount)
      spinner.stop(`${pc.green('✓')} Withdraw complete`)
      log.line(pc.bold('Transaction'))
      log.indent(pc.gray(txHash))
      log.flush()
    }

    const updated = await getPaymentStatus(synapse)
    const newAvailable = updated.depositedAmount - (updated.currentAllowances.lockupUsed ?? 0n)
    const newPerDay = (updated.currentAllowances.rateUsed ?? 0n) * TIME_CONSTANTS.EPOCHS_PER_DAY
    const newRunway = newPerDay > 0n ? Number(newAvailable / newPerDay) : 0
    const newRunwayHours = newPerDay > 0n ? Number(((newAvailable % newPerDay) * 24n) / newPerDay) : 0
    log.section('Updated', [
      `Deposited: ${formatUSDFC(updated.depositedAmount)} USDFC`,
      `Runway: ~${newRunway} day(s)${newRunwayHours > 0 ? ` ${newRunwayHours} hour(s)` : ''}`,
    ])
    await cleanupProvider(provider)
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
