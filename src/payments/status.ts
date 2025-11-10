/**
 * Payment status display command
 *
 * Shows current payment configuration and balances for Filecoin Onchain Cloud.
 * This provides a quick overview of the user's payment setup without making changes.
 */

import type { Synapse } from '@filoz/synapse-sdk'
import { TIME_CONSTANTS } from '@filoz/synapse-sdk'
import { ethers } from 'ethers'
import pc from 'picocolors'
import { TELEMETRY_CLI_APP_NAME } from '../common/constants.js'
import {
  calculateDepositCapacity,
  calculateStorageRunway,
  checkFILBalance,
  checkUSDFCBalance,
  getPaymentStatus,
} from '../core/payments/index.js'
import { cleanupSynapseService, initializeSynapse } from '../core/synapse/index.js'
import { formatFIL, formatUSDFC } from '../core/utils/format.js'
import { formatRunwaySummary } from '../core/utils/index.js'
import { type CLIAuthOptions, getCLILogger, parseCLIAuth } from '../utils/cli-auth.js'
import { cancel, createSpinner, intro, outro } from '../utils/cli-helpers.js'
import { log } from '../utils/cli-logger.js'
import { displayDepositWarning } from './setup.js'

interface StatusOptions extends CLIAuthOptions {
  includeRails?: boolean
}

const STORAGE_DISPLAY_PRECISION_DIGITS = 6
const STORAGE_DISPLAY_PRECISION = 10n ** BigInt(STORAGE_DISPLAY_PRECISION_DIGITS)

/**
 * Derives the current warm storage size from the Filecoin Pay spend rate.
 *
 * rateUsed represents the USDFC burn per epoch while pricePerTiBPerEpoch
 * represents the quoted USDFC price for storing 1 TiB for the same duration.
 * Dividing the two gives the actively billed TiB, which we convert to GiB for
 * display with a small fixed precision.
 */
function formatStorageGiB(rateUsed: bigint, pricePerTiBPerEpoch: bigint): string {
  if (rateUsed === 0n || pricePerTiBPerEpoch === 0n) {
    return pc.gray('Stored: no active usage')
  }

  if (pricePerTiBPerEpoch <= 0) {
    return pc.gray('Stored: unknown')
  }

  const storedTiBScaled = (rateUsed * STORAGE_DISPLAY_PRECISION) / pricePerTiBPerEpoch
  if (storedTiBScaled <= 0) {
    return pc.gray('Stored: no active usage')
  }

  const storedGiB = Number(
    ethers.formatUnits(storedTiBScaled * 1024n, STORAGE_DISPLAY_PRECISION_DIGITS)
  )

  if (storedGiB < 0.1) {
    return 'Stored: < 0.1 GiB'
  }

  let digits = 1
  if (storedGiB < 10) {
    digits = 2
  }
  const formatted = storedGiB.toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  })
  return `Stored: ~${formatted} GiB`
}

/**
 * Display current payment status
 *
 * @param options - Options from command line
 */
export async function showPaymentStatus(options: StatusOptions): Promise<void> {
  intro(pc.bold('Filecoin Onchain Cloud Payment Status'))

  const spinner = createSpinner()
  spinner.start('Fetching current configuration...')

  try {
    // Parse and validate authentication
    const authConfig = parseCLIAuth({
      privateKey: options.privateKey,
      walletAddress: options.walletAddress,
      sessionKey: options.sessionKey,
      rpcUrl: options.rpcUrl,
    })

    const logger = getCLILogger()
    const synapse = await initializeSynapse(
      { ...authConfig, telemetry: { sentrySetTags: { appName: TELEMETRY_CLI_APP_NAME } } },
      logger
    )
    const network = synapse.getNetwork()
    const client = synapse.getClient()
    const address = await client.getAddress()

    // Check balances and status
    const filStatus = await checkFILBalance(synapse)

    // Early exit if account has no funds
    if (filStatus.balance === 0n) {
      spinner.stop('━━━ Current Status ━━━')

      log.line(`Address: ${address}`)
      log.line(`Network: ${network}`)
      log.line('')
      log.line(`${pc.red('✗')} Account has no FIL balance`)
      log.line('')
      log.line(
        `Get test FIL from: ${filStatus.isCalibnet ? 'https://faucet.calibnet.chainsafe-fil.io/' : 'Purchase FIL from an exchange'}`
      )
      log.flush()

      cancel('Account not funded')
      throw new Error('Account has no FIL balance')
    }

    const walletUsdfcBalance = await checkUSDFCBalance(synapse)

    // Check if we have USDFC tokens before continuing
    if (walletUsdfcBalance === 0n) {
      spinner.stop('━━━ Current Status ━━━')

      log.line(`Address: ${address}`)
      log.line(`Network: ${network}`)
      log.line('')
      log.line(`${pc.red('✗')} No USDFC tokens found`)
      log.line('')
      const helpMessage = filStatus.isCalibnet
        ? 'Get test USDFC from: https://docs.secured.finance/usdfc-stablecoin/getting-started/getting-test-usdfc-on-testnet'
        : 'Mint USDFC with FIL: https://docs.secured.finance/usdfc-stablecoin/getting-started/minting-usdfc-step-by-step'
      log.line(`  ${pc.cyan(helpMessage)}`)
      log.flush()

      cancel('USDFC required to use Filecoin Onchain Cloud')
      throw new Error('No USDFC tokens found')
    }

    const status = await getPaymentStatus(synapse)

    // Get storage pricing for capacity calculation and spend summaries
    const storageInfo = await synapse.storage.getStorageInfo()
    const pricePerTiBPerEpoch = storageInfo.pricing.noCDN.perTiBPerEpoch

    let paymentRailsData: PaymentRailsData | null = null
    if (options.includeRails === true) {
      paymentRailsData = await fetchPaymentRailsData(synapse)
    }
    spinner.stop(`${pc.green('✓')} Configuration loaded`)

    // Display all status information
    log.line('━━━ Current Status ━━━')

    // Show wallet balances
    log.line(pc.bold('Wallet'))
    log.indent(`Owner address: ${address}`)
    log.indent(`Network: ${network}`)
    log.indent(`FIL: ${formatFIL(filStatus.balance, filStatus.isCalibnet)}`)
    log.indent(`USDFC: ${formatUSDFC(walletUsdfcBalance)} USDFC`)
    log.line('')

    // Show deposit and capacity
    const lockupUsed = status.currentAllowances.lockupUsed ?? 0n
    const rateUsed = status.currentAllowances.rateUsed ?? 0n
    const availableDeposit = status.filecoinPayBalance > lockupUsed ? status.filecoinPayBalance - lockupUsed : 0n
    const capacity = calculateDepositCapacity(status.filecoinPayBalance, pricePerTiBPerEpoch)
    const runway = calculateStorageRunway(status)
    const runwayDisplay = formatRunwaySummary(runway)
    const dailyCost = runway.perDay
    const monthlyCost = dailyCost * TIME_CONSTANTS.DAYS_PER_MONTH

    log.line(pc.bold('Filecoin Pay'))
    log.indent(`Balance: ${formatUSDFC(status.filecoinPayBalance)} USDFC`)
    log.indent(`Locked: ${formatUSDFC(lockupUsed)} USDFC (30-day reserve)`)
    log.indent(`Available: ${formatUSDFC(availableDeposit)} USDFC`)
    if (rateUsed > 0n) {
      log.indent(`Spend rate: ${formatUSDFC(rateUsed)} USDFC/epoch`)
      log.indent(`Daily cost: ${formatUSDFC(dailyCost)} USDFC`)
      log.indent(`Monthly cost: ${formatUSDFC(monthlyCost)} USDFC`)
    } else {
      log.indent(`Spend rate: ${pc.gray('0 USDFC/epoch')}`)
      log.indent(`Daily cost: ${pc.gray('0 USDFC')}`)
      log.indent(`Monthly cost: ${pc.gray('0 USDFC')}`)
    }
    if (paymentRailsData != null) {
      displayPaymentRailsSummary(paymentRailsData, 1)
    }
    log.line('')

    // Show storage usage details
    log.line(pc.bold('WarmStorage Usage'))
    if (rateUsed > 0n) {
      log.indent(formatStorageGiB(rateUsed, pricePerTiBPerEpoch))
    } else if (status.filecoinPayBalance > 0n) {
      log.indent(pc.gray('Stored: no active usage'))
    } else {
      log.indent(pc.gray('Stored: none'))
    }
    if (runway.state === 'active') {
      log.indent(`Runway: ~${runwayDisplay}`)
    } else {
      log.indent(pc.gray(`Runway: ${runwayDisplay}`))
    }
    const capacityTiB =
      capacity.tibPerMonth >= 100
        ? Math.round(capacity.tibPerMonth).toLocaleString()
        : capacity.tibPerMonth.toFixed(1)
    const capacityLine = `Funding could cover ~${capacityTiB} TiB per month`
    if (capacity.gibPerMonth > 0) {
      log.indent(capacityLine)
    } else {
      log.indent(pc.gray(capacityLine))
    }
    log.flush()

    // Show deposit warning if needed
    displayDepositWarning(status.filecoinPayBalance, status.currentAllowances.lockupUsed)
    log.flush()

    // Show success outro
    outro('Status check complete')
  } catch (error) {
    spinner.stop(`${pc.red('✗')} Status check failed`)

    log.line('')
    log.line(`${pc.red('Error:')} ${error instanceof Error ? error.message : String(error)}`)
    log.flush()

    cancel('Status check failed')
    process.exitCode = 1
  } finally {
    await cleanupSynapseService()
  }
}

interface PaymentRailsData {
  activeRails: number
  terminatedRails: number
  totalActiveRate: bigint
  totalPendingSettlements: bigint
  railsNeedingSettlement: number
  error?: string
}

/**
 * Fetch payment rails data without displaying anything
 */
async function fetchPaymentRailsData(synapse: Synapse): Promise<PaymentRailsData> {
  try {
    // Get rails as payer
    const payerRails = await synapse.payments.getRailsAsPayer()

    if (payerRails.length === 0) {
      return {
        activeRails: 0,
        terminatedRails: 0,
        totalActiveRate: 0n,
        totalPendingSettlements: 0n,
        railsNeedingSettlement: 0,
      }
    }

    // Analyze rails for summary
    let totalPendingSettlements = 0n
    let totalActiveRate = 0n
    let activeRails = 0
    let terminatedRails = 0
    let railsNeedingSettlement = 0

    for (const rail of payerRails) {
      try {
        const railDetails = await synapse.payments.getRail(rail.railId)
        const settlementPreview = await synapse.payments.getSettlementAmounts(rail.railId)

        if (rail.isTerminated) {
          terminatedRails++
        } else {
          activeRails++
          totalActiveRate += railDetails.paymentRate
        }

        // Check for pending settlements
        if (settlementPreview.totalSettledAmount > 0n) {
          totalPendingSettlements += settlementPreview.totalSettledAmount
          railsNeedingSettlement++
        }
      } catch (error) {
        log.warn(`Could not analyze rail ${rail.railId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    return {
      activeRails,
      terminatedRails,
      totalActiveRate,
      totalPendingSettlements,
      railsNeedingSettlement,
    }
  } catch {
    return {
      activeRails: 0,
      terminatedRails: 0,
      totalActiveRate: 0n,
      totalPendingSettlements: 0n,
      railsNeedingSettlement: 0,
      error: 'Unable to fetch rail information',
    }
  }
}

/**
 * Display payment rails summary
 */
function displayPaymentRailsSummary(data: PaymentRailsData, indentLevel: number = 1): void {
  log.indent(pc.bold('Payment Rails'), indentLevel)

  if (data.error) {
    log.indent(pc.gray(data.error), indentLevel + 1)
    return
  }

  if (data.activeRails === 0 && data.terminatedRails === 0) {
    log.indent(pc.gray('No active payment rails'), indentLevel + 1)
    return
  }

  log.indent(`${data.activeRails} active, ${data.terminatedRails} terminated`, indentLevel + 1)

  if (data.totalPendingSettlements > 0n) {
    log.indent(`Pending settlement: ${formatUSDFC(data.totalPendingSettlements)} USDFC`, indentLevel + 1)
  }

  if (data.railsNeedingSettlement > 0) {
    log.indent(`${data.railsNeedingSettlement} rail(s) need settlement`, indentLevel + 1)
  }
}
