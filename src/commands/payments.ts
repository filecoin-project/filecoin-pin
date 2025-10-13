import { Command } from 'commander'
import { runAutoSetup } from '../payments/auto.js'
import { runDeposit } from '../payments/deposit.js'
import { runFund } from '../payments/fund.js'
import { runInteractiveSetup } from '../payments/interactive.js'
import { showPaymentStatus } from '../payments/status.js'
import type { FundOptions, PaymentSetupOptions } from '../payments/types.js'
import { runWithdraw } from '../payments/withdraw.js'
import { addAuthOptions } from '../utils/cli-options.js'

export const paymentsCommand = new Command('payments').description('Manage payment setup for Filecoin Onchain Cloud')

// Setup command
const setupCommand = new Command('setup')
  .description('Setup payment approvals for Filecoin Onchain Cloud storage')
  .option('--auto', 'Run in automatic mode with defaults')
  .option('--deposit <amount>', 'USDFC amount to deposit in Filecoin Pay (default: 1)')
  .option(
    '--rate-allowance <amount>',
    'Storage allowance for WarmStorage service (e.g., "1TiB/month", "500GiB/month", or "0.0000565" USDFC/epoch, default: 1TiB/month)'
  )
  .action(async (options) => {
    try {
      const setupOptions: PaymentSetupOptions = {
        ...options,
        auto: options.auto || false,
        deposit: options.deposit || '1',
        rateAllowance: options.rateAllowance || '1TiB/month',
      }

      if (setupOptions.auto) {
        await runAutoSetup(setupOptions)
      } else {
        await runInteractiveSetup(setupOptions)
      }
    } catch (error) {
      console.error('Payment setup failed:', error instanceof Error ? error.message : error)
      process.exit(1)
    }
  })

addAuthOptions(setupCommand)
paymentsCommand.addCommand(setupCommand)

// Fund command - adjust funds to an exact runway or deposited total
const fundCommand = new Command('fund')
  .description('Adjust funds to an exact runway (days) or total deposit')
  .option('--days <n>', 'Set final runway to exactly N days (deposit or withdraw as needed)')
  .option('--amount <usdfc>', 'Set final deposited total to exactly this USDFC amount (deposit or withdraw)')
  .option(
    '--mode <mode>',
    'Mode to use for funding: "exact" (default) or "minimum". "exact" will withdraw/deposit to exactly match the target. "minimum" will only deposit if below the minimum target.'
  )
  .action(async (options) => {
    try {
      const fundOptions: FundOptions = {
        ...options,
        amount: options.amount,
        mode: options.mode,
      }
      if (options.days != null) fundOptions.days = Number(options.days)
      await runFund(fundOptions)
    } catch (error) {
      console.error('Failed to adjust funds:', error instanceof Error ? error.message : error)
      process.exit(1)
    }
  })

addAuthOptions(fundCommand)
paymentsCommand.addCommand(fundCommand)

// Withdraw command
const withdrawCommand = new Command('withdraw')
  .description('Withdraw funds from Filecoin Pay to your wallet')
  .requiredOption('--amount <usdfc>', 'USDFC amount to withdraw (e.g., 5)')
  .action(async (options) => {
    try {
      await runWithdraw({
        ...options,
        amount: options.amount,
      })
    } catch (error) {
      console.error('Failed to withdraw:', error instanceof Error ? error.message : error)
      process.exit(1)
    }
  })

addAuthOptions(withdrawCommand)
paymentsCommand.addCommand(withdrawCommand)

// Status command
const statusCommand = new Command('status')
  .description('Check current payment setup status')
  .action(async (options) => {
    try {
      await showPaymentStatus({
        ...options,
      })
    } catch (error) {
      console.error('Failed to get payment status:', error instanceof Error ? error.message : error)
      process.exit(1)
    }
  })

addAuthOptions(statusCommand)
paymentsCommand.addCommand(statusCommand)

// Deposit command
const depositCommand = new Command('deposit')
  .description('Deposit or top-up funds in Filecoin Pay')
  .option('--amount <usdfc>', 'USDFC amount to deposit (e.g., 10.5)')
  .option('--days <n>', 'Fund enough to keep current spend alive for N days')
  .action(async (options) => {
    try {
      await runDeposit({
        ...options,
        amount: options.amount,
        days: options.days != null ? Number(options.days) : undefined, // Only pass days if explicitly provided
      })
    } catch (error) {
      console.error('Failed to perform deposit:', error instanceof Error ? error.message : error)
      process.exit(1)
    }
  })

addAuthOptions(depositCommand)
paymentsCommand.addCommand(depositCommand)
