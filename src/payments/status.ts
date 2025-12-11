/**
 * Payment status display command
 *
 * Shows current payment configuration and balances for Filecoin Onchain Cloud.
 * This provides a quick overview of the user's payment setup without making changes.
 */

import { SIZE_CONSTANTS } from '@filoz/synapse-core/utils'
import type { Synapse } from '@filoz/synapse-sdk'
import { TIME_CONSTANTS } from '@filoz/synapse-sdk'
import { ethers } from 'ethers'
import pc from 'picocolors'
import { TELEMETRY_CLI_APP_NAME } from '../common/constants.js'
import { type ActualStorageResult, calculateActualStorage, listDataSets } from '../core/data-set/index.js'
import {
  calculateDepositCapacity,
  calculateStorageRunway,
  checkFILBalance,
  checkUSDFCBalance,
  FLOOR_PRICE_DAYS,
  FLOOR_PRICE_PER_30_DAYS,
  getPaymentStatus,
} from '../core/payments/index.js'
import { cleanupSynapseService, initializeSynapse } from '../core/synapse/index.js'
import { formatFIL, formatUSDFC } from '../core/utils/format.js'
import { formatRunwaySummary } from '../core/utils/index.js'
import { type CLIAuthOptions, getCLILogger, parseCLIAuth } from '../utils/cli-auth.js'
import { cancel, createSpinner, formatFileSize, intro, outro } from '../utils/cli-helpers.js'
import { log } from '../utils/cli-logger.js'
import { displayDepositWarning } from './setup.js'

interface StatusOptions extends CLIAuthOptions {
  includeRails?: boolean
}

const STORAGE_DISPLAY_PRECISION_DIGITS = 6
const STORAGE_DISPLAY_PRECISION = 10n ** BigInt(STORAGE_DISPLAY_PRECISION_DIGITS)
const { TiB } = SIZE_CONSTANTS

/**
 * Convert a payment rate (USDFC per epoch) to storage bytes using the provider's pricing.
 *
 * This calculates: "How much storage does this payment rate cover?"
 *
 * Formula: storageBytes = (rate / pricePerTiBPerEpoch) * TiB
 *
 * NOTE: This calculation assumes a linear relationship between payment rate and
 * storage size, which breaks down when floor pricing is applied to small files.
 * The result represents "storage equivalent" at the given rate, not actual bytes stored.
 * Use calculateActualStorage() from core/data-set for accurate byte counts.
 *
 * @param ratePerEpoch - Payment rate in USDFC per epoch
 * @param pricePerTiBPerEpoch - Provider's price for 1 TiB per epoch in USDFC
 * @returns Storage bytes that the rate covers, or null if invalid inputs
 */
function convertRateToStorageBytes(ratePerEpoch: bigint, pricePerTiBPerEpoch: bigint): bigint | null {
  if (ratePerEpoch <= 0n || pricePerTiBPerEpoch <= 0n) {
    return null
  }

  // storageTiBScaled preserves fractional precision using STORAGE_DISPLAY_PRECISION scaling
  const storageTiBScaled = (ratePerEpoch * STORAGE_DISPLAY_PRECISION) / pricePerTiBPerEpoch
  if (storageTiBScaled <= 0n) {
    return null
  }

  // Convert scaled TiB to bytes: TiB * 1024^4 bytes, then unscale
  return (storageTiBScaled * TiB) / STORAGE_DISPLAY_PRECISION
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
    const authConfig = parseCLIAuth(options)

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
      log.indent(`Epoch cost: ${formatUSDFC(rateUsed)} USDFC`)
      log.indent(`Daily cost: ${formatUSDFC(dailyCost)} USDFC`)
      log.indent(`Monthly cost: ${formatUSDFC(monthlyCost)} USDFC`)
    } else {
      log.indent(`Epoch cost: ${pc.gray('0 USDFC')}`)
      log.indent(`Daily cost: ${pc.gray('0 USDFC')}`)
      log.indent(`Monthly cost: ${pc.gray('0 USDFC')}`)
    }
    if (paymentRailsData != null) {
      displayPaymentRailsSummary(paymentRailsData, 1)
    }
    log.line('')

    // Show storage usage details
    log.line(pc.bold('WarmStorage Usage'))

    let actualStorageResult: ActualStorageResult | null = null
    try {
      spinner.start('Fetching data sets...')
      // Get all active data sets for this address
      const dataSets = await listDataSets(synapse, {
        withProviderDetails: false,
        address,
        filter: (ds) => ds.isLive, // Only count active/live data sets
        logger,
      })
      spinner.stop(`${pc.green('✓')} Data sets fetched`)

      spinner.start('Calculating actual storage from data sets...')
      actualStorageResult = await calculateActualStorage(synapse, dataSets, {
        logger,
        onProgress: (progress) => {
          if (progress.type === 'actual-storage:progress') {
            spinner.message(
              `Calculating actual storage from data sets (${progress.data.dataSetsProcessed}/${progress.data.dataSetCount})`
            )
          }
        },
      })

      if (actualStorageResult.timedOut) {
        spinner.stop(`${pc.yellow('⚠')} Calculation timed out`)
      } else if (actualStorageResult.warnings.length > 0) {
        spinner.stop(
          `${pc.yellow('⚠')} Actual storage calculated with ${actualStorageResult.warnings.length} warning(s)`
        )
      } else {
        spinner.stop(`${pc.green('✓')} Actual storage calculated`)
      }

      if (actualStorageResult.warnings.length > 0) {
        for (const warning of actualStorageResult.warnings) {
          log.indent(pc.yellow(`⚠ ${warning.message}`))
        }
      }

      if (actualStorageResult.totalBytes > 0n) {
        const formattedSize = formatFileSize(actualStorageResult.totalBytes)
        log.indent(`Stored: ${formattedSize}`)
      } else {
        log.indent(pc.gray('Stored: 0 B'))
      }
    } catch (error) {
      spinner.stop(`${pc.yellow('⚠')} Could not calculate actual storage`)
      log.indent(pc.gray(`  Error: ${error instanceof Error ? error.message : String(error)}`))
    }

    if (runway.state === 'active') {
      log.indent(`Runway: ~${runwayDisplay}`)
    } else {
      log.indent(pc.gray(`Runway: ${runwayDisplay}`))
    }

    const capacityTibPerMonth = ethers.parseUnits(capacity.tibPerMonth.toString(), 18)
    const capacityBytes = (capacityTibPerMonth * TiB) / 10n ** 18n
    const capacityLine = `Funding could cover ~${formatFileSize(capacityBytes)} for one month`
    log.indent(capacityLine)

    log.flush()

    const billedBytes = convertRateToStorageBytes(rateUsed, pricePerTiBPerEpoch)
    if (billedBytes != null) {
      // Calculate what storage the floor price represents at current pricing
      const epochsInFloorPeriod = BigInt(FLOOR_PRICE_DAYS) * TIME_CONSTANTS.EPOCHS_PER_DAY
      const floorRatePerEpoch = FLOOR_PRICE_PER_30_DAYS / epochsInFloorPeriod
      const floorEquivalentBytes = convertRateToStorageBytes(floorRatePerEpoch, pricePerTiBPerEpoch)
      const floorEquivalentFormatted = floorEquivalentBytes ? formatFileSize(floorEquivalentBytes) : '~24.6 GiB'

      const sectionContent = [
        pc.gray('Filecoin Onchain Cloud uses floor pricing for DataSets.'),
        pc.gray(`Each DataSet is billed a minimum of ${formatUSDFC(FLOOR_PRICE_PER_30_DAYS, 2)} USDFC per 30 days.`),
        pc.gray(`This is equivalent to ~${floorEquivalentFormatted} per month.`),
        `Billed capacity: ~${formatFileSize(billedBytes)}`,
      ]
      if (actualStorageResult != null && billedBytes > actualStorageResult.totalBytes) {
        const additionalStorage = billedBytes - actualStorageResult.totalBytes
        sectionContent.push(`Storage remaining: ~${formatFileSize(additionalStorage)}`)
      }
      log.indent(pc.bold('Storage usage details:'))
      for (const content of sectionContent) {
        log.indent(content, 2)
      }
    }

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
    throw error
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
