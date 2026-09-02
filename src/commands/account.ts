/**
 * Commander wiring for `balance` and `dashboard` (PRD section 5, appendix A
 * decision 17): a thin local balance command and a deep link to the
 * console for anything richer.
 */

import { Command } from 'commander'
import pc from 'picocolors'
import { runDashboard } from '../login/run-dashboard.js'
import { showPaymentStatus } from '../payments/status.js'
import { addAuthOptions, addNetworkOptions } from '../utils/cli-options.js'

// balance: alias of `payments status`, which already computes balances,
// reserve, available funds, storage footprint, and runway.
export const balanceCommand = new Command('balance')
  .description('Show wallet and Filecoin Cloud balances, reserve, available funds, storage, and runway')
  .action(async (options) => {
    try {
      await showPaymentStatus({ ...options, footer: pc.gray('Top up or manage billing:  filecoin-pin dashboard') })
    } catch {
      // showPaymentStatus already printed the failure.
      process.exitCode = 1
    }
  })
addAuthOptions(balanceCommand)

export const dashboardCommand = new Command('dashboard')
  .description('Open the Filecoin Cloud console billing page in your browser')
  .action((options) => {
    try {
      runDashboard(options)
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    }
  })
addNetworkOptions(dashboardCommand)
