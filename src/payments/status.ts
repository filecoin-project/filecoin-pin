/**
 * Payment status display command
 *
 * Shows current payment configuration and balances for Filecoin Onchain Cloud.
 * This provides a quick overview of the user's payment setup without making changes.
 */
import type { Synapse } from '@filoz/synapse-sdk'
import { TIME_CONSTANTS } from '@filoz/synapse-sdk'
import pc from 'picocolors'
import { calculateActualStorage, listDataSets } from '../core/data-set/index.js'
import { checkFILBalance, checkUSDFCBalance, getUsdfcAcquisitionHelpMessage, validateGasRequirement } from '../core/payments/index.js'
import { getClientAddress, initializeSynapse } from '../core/synapse/index.js'
import { formatFIL, formatUSDFC } from '../core/utils/format.js'
import { type CLIAuthOptions, getCLILogger, parseCLIAuth } from '../utils/cli-auth.js'
import { cancel, createSpinner, formatFileSize, intro, outro } from '../utils/cli-helpers.js'
import { log } from '../utils/cli-logger.js'

interface StatusOptions extends CLIAuthOptions {
  includeRails?: boolean
}

const EPOCHS_14_DAYS = TIME_CONSTANTS.EPOCHS_PER_DAY * 14n
const EPOCH_DURATION_MS = TIME_CONSTANTS.EPOCH_DURATION * 1000

function deriveAccountStatus(runwayInEpochs: bigint, debt: bigint): 'HEALTHY' | 'WARNING' | 'DEFICIT' {
  if (runwayInEpochs === 0n || debt > 0n) return 'DEFICIT'
  if (runwayInEpochs <= EPOCHS_14_DAYS) return 'WARNING'
  return 'HEALTHY'
}

function formatFundedUntil(runwayInEpochs: bigint, lockupRatePerEpoch: bigint): string {
  if (lockupRatePerEpoch === 0n) return 'No active storage spend'
  const fundedUntilMs = Date.now() + Number(runwayInEpochs) * EPOCH_DURATION_MS
  const fundedUntilDate = new Date(fundedUntilMs)
  const dateStr = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(fundedUntilDate)
  const days = Math.floor(Number(runwayInEpochs / TIME_CONSTANTS.EPOCHS_PER_DAY))
  return `Funded until ${dateStr}  (${days} days)`
}

export async function showPaymentStatus(options: StatusOptions): Promise<void> {
  intro(pc.bold('Payment Status'))

  const spinner = createSpinner()
  spinner.start('Fetching current configuration...')

  try {
    const authConfig = parseCLIAuth(options)
    const logger = getCLILogger()
    const synapse = await initializeSynapse(authConfig, logger)
    const network = synapse.chain.name
    const address = getClientAddress(synapse)

    const [filStatus, walletUsdfcBalance, accountSummary] = await Promise.all([
      checkFILBalance(synapse),
      checkUSDFCBalance(synapse),
      synapse.payments.accountSummary({}),
    ])

    spinner.stop(`${pc.green('✓')} Configuration loaded`)

    const {
      runwayInEpochs,
      debt,
      lockupRatePerEpoch,
      funds,
      availableFunds,
      totalLockup,
      totalRateBasedLockup,
      totalFixedLockup,
    } = accountSummary

    const accountStatus = deriveAccountStatus(runwayInEpochs, debt)
    const statusColor = accountStatus === 'HEALTHY' ? pc.green : accountStatus === 'WARNING' ? pc.yellow : pc.red
    const fundedUntilStr = formatFundedUntil(runwayInEpochs, lockupRatePerEpoch)
    const burnRatePerMonth = lockupRatePerEpoch * TIME_CONSTANTS.EPOCHS_PER_DAY * TIME_CONSTANTS.DAYS_PER_MONTH

    const LBL = 25
    log.line('━━━ Payment Status ━━━')
    log.line('')
    log.line(`Network: ${network}`)
    log.line('')
    log.line(`${statusColor('●')} ${pc.bold(statusColor(accountStatus))}  ${fundedUntilStr}`)
    log.line('')

    log.line(pc.bold('Wallet'))
    log.indent(`${'Address'.padEnd(LBL)} ${address}`)
    log.indent(`${'FIL'.padEnd(LBL)}  ${formatFIL(filStatus.balance, filStatus.isCalibnet)}`)
    log.indent(`${'USDFC'.padEnd(LBL)}  ${formatUSDFC(walletUsdfcBalance)} USDFC`)
    
    const hasSufficientGas = validateGasRequirement(filStatus.balance, filStatus.isCalibnet)
    if (!hasSufficientGas.isValid) {
      log.indent(pc.yellow(`⚠ No FIL for gas — ${hasSufficientGas.helpMessage}`))
    }
    if (walletUsdfcBalance === 0n) {
      const helpLines = `⚠ No USDFC in wallet — ${getUsdfcAcquisitionHelpMessage(filStatus.isCalibnet)}`.split('\n')
      for (const line of helpLines) {
        log.indent(pc.yellow(line))
      }
    }
    log.line('')

    
    log.line(pc.bold('Account'))
    log.indent(`${'Total deposited'.padEnd(LBL)} ${formatUSDFC(funds)} USDFC`)
    log.indent(`${'Available to withdraw'.padEnd(LBL)} ${formatUSDFC(availableFunds)} USDFC`)
    log.indent(`${'Burn rate'.padEnd(LBL)} ${formatUSDFC(burnRatePerMonth)} USDFC / month`)
    log.indent(`${'Total locked'.padEnd(LBL)} ${formatUSDFC(totalLockup)} USDFC`)
    log.indent(
      `  ├─ ${'Termination reserve'.padEnd(LBL - 5)} ${formatUSDFC(totalRateBasedLockup)} USDFC  (30-day guarantee)`
    )
    log.indent(
      `  └─ ${'Usage reserve'.padEnd(LBL - 5)} ${formatUSDFC(totalFixedLockup)} USDFC  (Operation + CDN reserve)`
    )
    log.line('')
    log.flush()

    // Datasets — separate spinner pass
    const datasetsUnavailable = 'Datasets  ·  (unavailable)'
    try {
      spinner.start('Calculating storage...')
      const dataSets = await listDataSets(synapse, {
        address,
        filter: (ds) => ds.isLive,
        logger,
      })

      const actualStorageResult = await calculateActualStorage(synapse, dataSets, {
        logger,
        onProgress: (progress) => {
          if (progress.type === 'actual-storage:progress') {
            spinner.message(`Calculating storage (${progress.data.dataSetsProcessed}/${progress.data.dataSetCount})`)
          }
        },
      })

      const storedStr = actualStorageResult.totalBytes > 0n ? formatFileSize(actualStorageResult.totalBytes) : '0 B'
      const datasetsLine = `Datasets  ·  ${dataSets.length} active  ·  ${storedStr} stored`

      if (actualStorageResult.timedOut) {
        spinner.stop(`${pc.yellow('⚠')} Storage calculation timed out`)
        log.line(datasetsLine)
      } else if (actualStorageResult.warnings.length > 0) {
        spinner.stop(`${pc.yellow('⚠')} Storage calculated with ${actualStorageResult.warnings.length} warning(s)`)
        for (const warning of actualStorageResult.warnings) {
          log.indent(pc.yellow(`⚠ ${warning.message}`))
        }
        log.line(datasetsLine)
      } else {
        spinner.stop(datasetsLine)
      }
    } catch (error) {
      spinner.stop(`${pc.yellow('⚠')} Could not calculate storage`)
      log.indent(pc.gray(`Error: ${error instanceof Error ? error.message : String(error)}`))
      log.line(datasetsUnavailable)
    }

    log.flush()

    if (options.includeRails === true) {
      spinner.start('Fetching payment rails...')
      const paymentRailsData = await fetchPaymentRailsData(synapse)
      spinner.stop(pc.bold('Payment Rails'))
      displayPaymentRailsSummary(paymentRailsData)
      log.flush()
    }

    outro('Status check complete')
  } catch (error) {
    spinner.stop(`${pc.red('✗')} Status check failed`)
    log.line('')
    log.line(`${pc.red('Error:')} ${error instanceof Error ? error.message : String(error)}`)
    log.flush()
    cancel('Status check failed')
    throw error
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

async function fetchPaymentRailsData(synapse: Synapse): Promise<PaymentRailsData> {
  try {
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

    let totalPendingSettlements = 0n
    let totalActiveRate = 0n
    let activeRails = 0
    let terminatedRails = 0
    let railsNeedingSettlement = 0

    for (const rail of payerRails) {
      try {
        const railDetails = await synapse.payments.getRail({ railId: rail.railId })
        const settlementPreview = await synapse.payments.getSettlementAmounts({ railId: rail.railId })

        if (rail.isTerminated) {
          terminatedRails++
        } else {
          activeRails++
          totalActiveRate += railDetails.paymentRate
        }

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

function displayPaymentRailsSummary(data: PaymentRailsData): void {
  if (data.error) {
    log.indent(pc.gray(data.error))
    return
  }

  if (data.activeRails === 0 && data.terminatedRails === 0) {
    log.indent(pc.gray('No active payment rails'))
    return
  }

  log.indent(`${data.activeRails} active, ${data.terminatedRails} terminated`)

  if (data.totalPendingSettlements > 0n) {
    log.indent(`Pending settlement: ${formatUSDFC(data.totalPendingSettlements)} USDFC`)
  }

  if (data.railsNeedingSettlement > 0) {
    log.indent(`${data.railsNeedingSettlement} rail(s) need settlement`)
  }
}
