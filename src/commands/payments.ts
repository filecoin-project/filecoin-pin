import { Command } from 'commander'
import { runAutoSetup } from '../payments/auto.js'
import { runInteractiveSetup } from '../payments/interactive.js'
import { showPaymentStatus } from '../payments/status.js'
import type { PaymentSetupOptions } from '../payments/types.js'

export const paymentsCommand = new Command('payments').description('Manage payment setup for Filecoin Onchain Cloud')

paymentsCommand
  .command('setup')
  .description('Setup payment approvals for Filecoin Onchain Cloud storage')
  .option('--auto', 'Run in automatic mode with defaults')
  .option('--private-key <key>', 'Private key (can also use PRIVATE_KEY env)')
  .option('--rpc-url <url>', 'RPC endpoint (can also use RPC_URL env)')
  .option('--deposit <amount>', 'USDFC amount to deposit in Filecoin Pay (default: 1)')
  .option(
    '--rate-allowance <amount>',
    'Storage allowance for WarmStorage service (e.g., "1TiB/month", "500GiB/month", or "0.0000565" USDFC/epoch, default: 1TiB/month)'
  )
  .action(async (options) => {
    try {
      const setupOptions: PaymentSetupOptions = {
        auto: options.auto || false,
        privateKey: options.privateKey,
        rpcUrl: options.rpcUrl || process.env.RPC_URL,
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

// Add a status subcommand for checking current payment status
paymentsCommand
  .command('status')
  .description('Check current payment setup status')
  .option('--private-key <key>', 'Private key (can also use PRIVATE_KEY env)')
  .option('--rpc-url <url>', 'RPC endpoint (can also use RPC_URL env)')
  .action(async (options) => {
    try {
      await showPaymentStatus({
        privateKey: options.privateKey,
        rpcUrl: options.rpcUrl || process.env.RPC_URL,
      })
    } catch (error) {
      console.error('Failed to get payment status:', error instanceof Error ? error.message : error)
      process.exit(1)
    }
  })
