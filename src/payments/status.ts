/**
 * Payment status display command
 *
 * Shows current payment configuration and balances for Filecoin Onchain Cloud.
 * This provides a quick overview of the user's payment setup without making changes.
 */

import { RPC_URLS, Synapse, TIME_CONSTANTS } from '@filoz/synapse-sdk'
import { ethers } from 'ethers'
import pc from 'picocolors'
import { calculateDepositCapacity } from '../synapse/payments.js'
import { cleanupProvider } from '../synapse/service.js'
import { cancel, createSpinner, intro, outro } from '../utils/cli-helpers.js'
import { log } from '../utils/cli-logger.js'
import { formatRunwayDuration } from '../utils/time.js'
import { checkFILBalance, checkUSDFCBalance, displayDepositWarning, formatUSDFC, getPaymentStatus } from './setup.js'

interface StatusOptions {
  privateKey?: string
  rpcUrl?: string
}

/**
 * Display current payment status
 *
 * @param options - Options from command line
 */
export async function showPaymentStatus(options: StatusOptions): Promise<void> {
  // Parse and validate all arguments upfront
  // 1. Private key
  const privateKey = options.privateKey || process.env.PRIVATE_KEY
  if (!privateKey) {
    console.error(pc.red('Error: Private key required via --private-key or PRIVATE_KEY env'))
    process.exit(1)
  }

  // Validate private key format early
  try {
    new ethers.Wallet(privateKey)
  } catch {
    console.error(pc.red('Error: Invalid private key format'))
    process.exit(1)
  }

  // 2. RPC URL
  const rpcUrl = options.rpcUrl || process.env.RPC_URL || RPC_URLS.calibration.websocket

  intro(pc.bold('Filecoin Onchain Cloud Payment Status'))

  const spinner = createSpinner()
  spinner.start('Fetching current configuration...')

  // Store provider reference for cleanup if it's a WebSocket provider
  let provider: any = null

  try {
    // Initialize connection
    const synapse = await Synapse.create({
      privateKey,
      rpcURL: rpcUrl,
    })
    const network = synapse.getNetwork()
    const signer = synapse.getSigner()
    const address = await signer.getAddress()

    // Store provider reference for cleanup if it's a WebSocket provider
    if (rpcUrl.match(/^wss?:\/\//)) {
      provider = synapse.getProvider()
    }

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

      // Clean up WebSocket provider before exiting
      await cleanupProvider(provider)

      cancel('Account not funded')
      process.exit(1)
    }

    const usdfcBalance = await checkUSDFCBalance(synapse)

    // Check if we have USDFC tokens before continuing
    if (usdfcBalance === 0n) {
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

      await cleanupProvider(provider)

      cancel('USDFC required to use Filecoin Onchain Cloud')
      process.exit(1)
    }

    const status = await getPaymentStatus(synapse)

    // Get storage pricing for capacity calculation and spend summaries
    const storageInfo = await synapse.storage.getStorageInfo()
    const pricePerTiBPerEpoch = storageInfo.pricing.noCDN.perTiBPerEpoch

    const paymentRailsData = await fetchPaymentRailsData(synapse)
    spinner.stop(`${pc.green('✓')} Configuration loaded`)

    // Display all status information
    log.line('━━━ Current Status ━━━')

    log.line(`Address: ${address}`)
    log.line(`Network: ${pc.bold(network)}`)
    log.line('')

    // Show wallet balances
    log.line(pc.bold('Wallet'))
    const filUnit = filStatus.isCalibnet ? 'tFIL' : 'FIL'
    log.indent(`${ethers.formatEther(filStatus.balance)} ${filUnit}`)
    log.indent(`${formatUSDFC(usdfcBalance)} USDFC`)
    log.line('')

    // Show deposit and capacity
    const capacity = calculateDepositCapacity(status.depositedAmount, pricePerTiBPerEpoch)
    log.line(pc.bold('Storage Deposit'))
    log.indent(`${formatUSDFC(status.depositedAmount)} USDFC deposited`)
    if (capacity.gibPerMonth > 0) {
      const asTiB = capacity.tibPerMonth
      const tibStr = asTiB >= 100 ? Math.round(asTiB).toLocaleString() : asTiB.toFixed(1)
      log.indent(`Capacity: ~${tibStr} TiB/month ${pc.gray('(includes 10-day safety reserve)')}`)
    } else if (status.depositedAmount > 0n) {
      log.indent(pc.gray('(insufficient for storage)'))
    }
    log.flush()

    // Show payment rails summary
    displayPaymentRailsSummary(paymentRailsData, log)

    // Show spend summaries (rateUsed, runway)
    const rateUsed = status.currentAllowances.rateUsed ?? 0n
    const lockupUsed = status.currentAllowances.lockupUsed ?? 0n
    const maxLockup = status.currentAllowances.maxLockupPeriod
    const lockupDays = maxLockup != null ? Number(maxLockup / TIME_CONSTANTS.EPOCHS_PER_DAY) : 10
    if (rateUsed > 0n) {
      const perDay = rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY
      const available = status.depositedAmount > lockupUsed ? status.depositedAmount - lockupUsed : 0n
      const runwayDays = Number(available / perDay)
      const runwayHoursRemainder = Number(((available % perDay) * 24n) / perDay)

      log.line(pc.bold('WarmStorage Usage'))
      log.indent(`Spend rate: ${formatUSDFC(rateUsed)} USDFC/epoch`)
      log.indent(`Locked: ${formatUSDFC(lockupUsed)} USDFC (~${lockupDays}-day reserve)`)
      log.indent(`Runway: ~${formatRunwayDuration(runwayDays, runwayHoursRemainder)}`)
      log.flush()
    } else {
      log.line(pc.bold('WarmStorage Usage'))
      log.indent(pc.gray('No active spend detected'))
      log.flush()
    }

    // Show deposit warning if needed
    displayDepositWarning(status.depositedAmount, status.currentAllowances.lockupUsed)
    log.flush()

    await cleanupProvider(provider)

    // Show success outro
    outro('Status check complete')
  } catch (error) {
    spinner.stop(`${pc.red('✗')} Status check failed`)

    log.line('')
    log.line(`${pc.red('Error:')} ${error instanceof Error ? error.message : String(error)}`)
    log.flush()

    await cleanupProvider(provider)

    cancel('Status check failed')
    process.exit(1)
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
function displayPaymentRailsSummary(data: PaymentRailsData, log: any): void {
  log.line(pc.bold('Payment Rails'))

  if (data.error) {
    log.indent(pc.gray(data.error))
    log.flush()
    return
  }

  if (data.activeRails === 0 && data.terminatedRails === 0) {
    log.indent(pc.gray('No active payment rails'))
    log.flush()
    return
  }

  log.indent(`${data.activeRails} active, ${data.terminatedRails} terminated`)

  if (data.activeRails > 0) {
    const dailyCost = data.totalActiveRate * 2880n // 2880 epochs per day
    const monthlyCost = dailyCost * 30n

    log.indent(`Daily cost: ${formatUSDFC(dailyCost)} USDFC`)
    log.indent(`Monthly cost: ${formatUSDFC(monthlyCost)} USDFC`)
  }

  if (data.totalPendingSettlements > 0n) {
    log.indent(`Pending settlement: ${formatUSDFC(data.totalPendingSettlements)} USDFC`)
  }

  if (data.railsNeedingSettlement > 0) {
    log.indent(`${data.railsNeedingSettlement} rail(s) need settlement`)
  }

  log.flush()
}
