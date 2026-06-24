/**
 * Common upload flow shared between import and add commands
 *
 * This module provides reusable functions for the Synapse upload workflow
 * including payment validation, storage context creation, and result display.
 */

import { isCancel, multiselect } from '@clack/prompts'
import type { CopyResult, FailedAttempt, Synapse, UploadCosts } from '@filoz/synapse-sdk'
import { METADATA_KEYS } from '@filoz/synapse-sdk'
import type { CID } from 'multiformats/cid'
import pc from 'picocolors'
import type { Logger } from 'pino'
import type { DataSetSummary } from '../core/data-set/types.js'
import { DEFAULT_LOCKUP_DAYS, type PaymentCapacityCheck } from '../core/payments/index.js'
import { DEFAULT_COPIES } from '../core/synapse/constants.js'
import {
  checkUploadReadiness,
  executeUpload,
  getNetworkSlug,
  type SynapseUploadData,
  type SynapseUploadResult,
} from '../core/upload/index.js'
import { formatUSDFC } from '../core/utils/format.js'
import { autoFund } from '../payments/fund.js'
import type { AutoFundOptions } from '../payments/types.js'
import type { Spinner } from '../utils/cli-helpers.js'
import { cancel, formatFileSize, isInteractive } from '../utils/cli-helpers.js'
import { log } from '../utils/cli-logger.js'
import { createSpinnerFlow } from '../utils/multi-operation-spinner.js'
import { CliFatal } from './cli-errors.js'

/**
 * Truncates a string to a maximum length while preserving its suffix when
 * possible.
 *
 * For lengths greater than 7, the string is truncated in the middle,
 * preserving the last 6 characters and inserting an ellipsis (`…`).
 * For shorter limits, the string is truncated at the end and suffixed with
 * an ellipsis.
 *
 * The returned string will never exceed `max` characters.
 */
export function truncate(str: string, max: number): string {
  if (str.length <= max) return str
  if (max <= 0) return ''

  if (max <= 7) {
    return `${str.slice(0, max - 1)}…`
  }

  return `${str.slice(0, max - 7)}…${str.slice(-6)}`
}

/**
 * Find the metadata keys whose values differ across the candidate set.
 * Keys with identical values on every dataset add no signal to the prompt.
 * Falls back to all keys when everything is uniform.
 */
export function differentiatingKeys(dataSets: DataSetSummary[]): string[] {
  if (dataSets.length === 0) return []

  const allKeys = [...new Set(dataSets.flatMap((ds) => Object.keys(ds.metadata ?? {})))]

  const varying = allKeys.filter((key) => {
    const values = dataSets.map((ds) => ds.metadata?.[key])
    return values.some((v) => v !== values[0])
  })

  return varying.length > 0 ? varying : allKeys
}

export function buildOptionLabel(ds: DataSetSummary, keys: string[]): string {
  const MAX_LABEL_PAIRS = 3
  const MAX_VALUE_LENGTH = 20

  const pairs = keys
    .filter((key) => ds.metadata != null && key in ds.metadata)
    .map((key) => {
      const raw = ds.metadata?.[key] ?? ''
      return raw === '' ? key : `${key}=${truncate(raw, MAX_VALUE_LENGTH)}`
    })

  const visible = pairs.slice(0, MAX_LABEL_PAIRS)
  const overflow = pairs.length - visible.length
  const overflowSuffix = overflow > 0 ? `  (+${overflow} more)` : ''

  const pieces = Number(ds.activePieceCount ?? 0n)
  const piecesLabel = `(${pieces} piece${pieces !== 1 ? 's' : ''})`

  const label = [`#${ds.dataSetId}`, ...visible, piecesLabel].join('  ') + overflowSuffix

  return label
}

/**
 * Prompt the user to select exactly `expectedCopies` data sets from a list of candidates.
 *
 * Only called when `--data-set-metadata` matched more datasets than `--copies` requires and
 * the process is running in an interactive TTY. Throws in non-interactive contexts.
 *
 * Stops the spinner before rendering the Clack prompt (they cannot coexist).
 */
export async function promptDataSetSelection(
  matchedDataSets: DataSetSummary[],
  expectedCopies: number,
  spinner: Spinner
): Promise<bigint[]> {
  if (!isInteractive()) {
    throw new Error(
      `--data-set-metadata matched ${matchedDataSets.length} data sets (${matchedDataSets.map((d) => d.dataSetId).join(', ')}) ` +
        `but expected ${expectedCopies}. Narrow the filter, pass --data-set-id, or run in a TTY to pick interactively.`
    )
  }

  spinner.stop(
    `${pc.yellow('?')} --data-set-metadata matched ${matchedDataSets.length} data sets — select ${expectedCopies} to upload to`
  )

  const keys = differentiatingKeys(matchedDataSets)

  const options = matchedDataSets.map((ds) => {
    const label = buildOptionLabel(ds, keys)
    return { value: ds.dataSetId, label }
  })

  const exact = `exactly ${expectedCopies} data set${expectedCopies !== 1 ? 's' : ''}`
  let message = `Select ${exact}:`

  while (true) {
    const chosen = await multiselect<bigint>({ message, options, required: true })

    if (isCancel(chosen)) {
      cancel('Cancelled')
      throw new CliFatal('Dataset selection cancelled')
    }

    if (chosen.length === expectedCopies) return chosen

    message = `${pc.yellow(`Please select ${exact} — got ${chosen.length}. Try again:`)}`
  }
}

export interface UploadFlowOptions {
  /**
   * Context identifier for logging (e.g., 'import', 'add')
   */
  contextType: string

  /**
   * Size of the file being uploaded in bytes
   */
  fileSize: number

  /**
   * Logger instance
   */
  logger: Logger

  /**
   * Optional spinner for progress updates
   */
  spinner?: Spinner

  /**
   * Optional metadata attached to the upload request (per-piece)
   */
  pieceMetadata?: Record<string, string>

  /** Number of storage copies to create. */
  copies?: number

  /**
   * Specific provider IDs to upload to. The SDK resolves or creates data sets
   * on each provider automatically. Mutually exclusive with `dataSetIds`.
   *
   * This is the recommended way to target specific providers. Do not call
   * `createContext()` to resolve data sets first. Pass provider IDs here
   * and the SDK handles the rest.
   */
  providerIds?: bigint[]

  /**
   * Specific existing data set IDs to target. Mutually exclusive with
   * `providerIds`.
   *
   * Use only when resuming into a known data set from a prior operation.
   * For first-time uploads to specific providers, use `providerIds` instead.
   */
  dataSetIds?: bigint[]

  /** Provider IDs to exclude from selection. */
  excludeProviderIds?: bigint[]

  /** Data set metadata applied when creating or matching contexts. */
  metadata?: Record<string, string>

  /** Skip IPNI advertisement verification after upload */
  skipIpniVerification?: boolean
}

export interface UploadFlowResult extends SynapseUploadResult {
  network: string
}

/**
 * Perform auto-funding if requested
 * Automatically ensures the configured minimum runway (default MIN_RUNWAY_DAYS) based on current
 * usage + new file requirements. Optional `maxBalance` caps the resulting Filecoin Pay balance.
 *
 * @param synapse - Initialized Synapse instance
 * @param fileSize - Size of file being uploaded (in bytes)
 * @param spinner - Optional spinner for progress
 * @param options - Optional auto-funding modifiers and upload targeting inputs
 * @param options.minRunwayDays - Minimum runway to maintain, in days (defaults to MIN_RUNWAY_DAYS)
 * @param options.maxBalance - Maximum Filecoin Pay balance after deposit (USDFC base units)
 * @param options.copies - Number of storage copies used to estimate new data set fees
 * @param options.providerIds - Provider IDs used to estimate new data set fees
 * @param options.dataSetIds - Data set IDs used to estimate new data set fees
 * @param options.metadata - Data set metadata used to estimate new data set fees
 */
export async function performAutoFunding(
  synapse: Synapse,
  fileSize: number,
  spinner?: Spinner,
  options: Pick<
    AutoFundOptions,
    'minRunwayDays' | 'maxBalance' | 'copies' | 'providerIds' | 'dataSetIds' | 'metadata' | 'withCDN'
  > = {}
): Promise<void> {
  spinner?.start('Checking funding requirements for upload...')

  try {
    const fundOptions: AutoFundOptions = {
      synapse,
      fileSize,
      ...(options?.copies != null ? { copies: options.copies } : {}),
      ...(options?.providerIds != null ? { providerIds: options.providerIds } : {}),
      ...(options?.dataSetIds != null ? { dataSetIds: options.dataSetIds } : {}),
      ...(options?.metadata != null ? { metadata: options.metadata } : {}),
      ...(options?.withCDN != null ? { withCDN: options.withCDN } : {}),
    }
    if (spinner !== undefined) {
      fundOptions.spinner = spinner
    }
    if (options.minRunwayDays !== undefined) {
      fundOptions.minRunwayDays = options.minRunwayDays
    }
    if (options.maxBalance !== undefined) {
      fundOptions.maxBalance = options.maxBalance
    }
    const result = await autoFund(fundOptions)
    const hasWarnings = result.warnings != null && result.warnings.length > 0
    spinner?.stop(
      hasWarnings ? `${pc.yellow('⚠')} Funding completed with warnings` : `${pc.green('✓')} Funding requirements met`
    )

    if (hasWarnings && result.warnings != null) {
      for (const warning of result.warnings) {
        log.line(pc.yellow(`⚠ ${warning}`))
      }
      log.flush()
    }

    if (result.adjusted) {
      log.line(pc.bold('Auto-funding completed:'))
      log.indent(`Deposited ${formatUSDFC(result.delta)} USDFC`)
      log.indent(`Total deposited: ${formatUSDFC(result.newDepositedAmount)} USDFC`)
      log.indent(
        `Runway: ~${result.newRunwayDays} day(s)${result.newRunwayHours > 0 ? ` ${result.newRunwayHours} hour(s)` : ''}`
      )
      if (result.transactionHash) {
        log.indent(pc.gray(`Transaction: ${result.transactionHash}`))
      }
      log.flush()
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    spinner?.stop(`${pc.red('✗')} Auto-funding failed`)
    log.line('')
    log.line(`${pc.red('Error:')} ${msg}`)
    log.flush()
    cancel('Operation cancelled - auto-funding failed')
    throw new CliFatal(msg, { cause: error instanceof Error ? error : undefined })
  }
}

/**
 * Validate payment setup and capacity for upload
 *
 * @param synapse - Initialized Synapse instance
 * @param fileSize - Size of file to upload in bytes (use 0 for minimum setup check)
 * @param spinner - Optional spinner for progress
 * @param options - Optional configuration
 * @param options.suppressSuggestions - If true, don't display suggestion warnings
 * @returns Resolves if validation passes, throws if not
 */
export async function validatePaymentSetup(
  synapse: Synapse,
  fileSize: number,
  spinner?: Spinner,
  options?: { suppressSuggestions?: boolean }
): Promise<void> {
  const readiness = await checkUploadReadiness({
    synapse,
    fileSize,
    onProgress: (event) => {
      if (!spinner) return

      switch (event.type) {
        case 'checkingBalances': {
          spinner.message('Checking payment setup requirements...')
          return
        }
        case 'checkingAllowances': {
          spinner.message('Checking WarmStorage permissions...')
          return
        }
        case 'configuringAllowances': {
          spinner.message('Configuring WarmStorage permissions (one-time setup)...')
          return
        }
        case 'validatingCapacity': {
          spinner.message('Validating payment capacity...')
          return
        }
        case 'allowancesConfigured': {
          // No spinner change; we log once readiness completes.
          return
        }
      }
    },
  })
  const { validation, allowances, capacity, suggestions } = readiness

  if (!validation.isValid) {
    const errorMsg = validation.errorMessage ?? 'Payment setup required'
    spinner?.stop(`${pc.red('✗')} Payment setup incomplete`)

    log.line('')
    log.line(`${pc.red('✗')} ${errorMsg}`)

    if (validation.helpMessage) {
      log.line('')
      log.line(`  ${pc.cyan(validation.helpMessage)}`)
    }

    log.line('')
    log.line(`${pc.yellow('⚠')} Your payment setup is not complete. Please run:`)
    log.indent(pc.cyan('filecoin-pin payments setup'))
    log.line('')
    log.line('For more information, run:')
    log.indent(pc.cyan('filecoin-pin payments status'))
    log.flush()

    cancel('Operation cancelled - payment setup required')
    throw new CliFatal(errorMsg)
  }

  if (allowances.updated) {
    spinner?.stop(`${pc.green('✓')} WarmStorage permissions configured`)
    if (allowances.transactionHash) {
      log.indent(pc.gray(`Transaction: ${allowances.transactionHash}`))
      log.flush()
    }
    spinner?.start('Validating payment capacity...')
  } else {
    spinner?.message('Validating payment capacity...')
  }

  if (!capacity?.canUpload) {
    if (capacity) {
      displayPaymentIssues(capacity, fileSize, spinner)
    }
    cancel('Operation cancelled - insufficient payment capacity')
    throw new CliFatal('Insufficient payment capacity')
  }

  // Show warning if suggestions exist (even if upload is possible)
  if (suggestions.length > 0 && capacity?.canUpload && !options?.suppressSuggestions) {
    spinner?.stop(`${pc.yellow('⚠')} Payment capacity check passed with warnings`)
    log.line(pc.bold('Suggestions:'))
    suggestions.forEach((suggestion) => {
      log.indent(`• ${suggestion}`)
    })
    log.flush()
  } else if (fileSize === 0) {
    // Different message based on whether this is minimum setup (fileSize=0) or actual capacity check
    // Note: 0.06 USDFC is the floor price, but with 10% buffer, ~0.066 USDFC is actually required
    spinner?.stop(`${pc.green('✓')} Minimum payment setup verified (~0.066 USDFC required)`)
  } else {
    spinner?.stop(`${pc.green('✓')} Payment capacity verified for ${formatFileSize(fileSize)}`)
  }
}

/**
 * Display payment capacity issues and suggestions
 */
function displayPaymentIssues(capacityCheck: PaymentCapacityCheck, fileSize: number, spinner?: Spinner): void {
  spinner?.stop(`${pc.red('✗')} Insufficient deposit for this file`)
  log.line(pc.bold('File Requirements:'))
  if (fileSize === 0) {
    log.indent(`File size: ${formatFileSize(fileSize)} (${capacityCheck.storageTiB.toFixed(4)} TiB)`)
  }
  log.indent(`Storage cost: ${formatUSDFC(capacityCheck.required.rateAllowance)} USDFC/epoch`)
  log.indent(
    `Required deposit: ${formatUSDFC(capacityCheck.required.lockupAllowance + capacityCheck.required.lockupAllowance / 10n)} USDFC ${pc.gray(`(includes ${DEFAULT_LOCKUP_DAYS}-day safety reserve)`)}`
  )
  log.line('')

  log.line(pc.bold('Suggested actions:'))
  capacityCheck.suggestions.forEach((suggestion: string) => {
    log.indent(`• ${suggestion}`)
  })
  log.line('')

  // Calculate suggested deposit
  const suggestedDeposit = capacityCheck.issues.insufficientDeposit
    ? formatUSDFC(capacityCheck.issues.insufficientDeposit)
    : '0'

  log.line(`${pc.yellow('⚠')} To fix this, run:`)
  log.indent(pc.cyan(`filecoin-pin payments setup --deposit ${suggestedDeposit} --auto`))
  log.flush()
}

export interface EstimateUploadCostOptions {
  /** Number of storage copies to create. Ignored if `providerIds`/`dataSetIds` are set. */
  copies?: number
  /** Specific provider IDs to target. Determines copy count when set. */
  providerIds?: bigint[]
  /** Specific existing data set IDs to target. Determines copy count when set. */
  dataSetIds?: bigint[]
  /** Data set metadata used to match/create contexts. */
  metadata?: Record<string, string>
  /** Whether CDN (FilBeam) is enabled for the upload. */
  withCDN?: boolean
}

export interface UploadCostEstimate {
  /** Number of copies the estimate was computed for. */
  requestedCopies: number
  /** How many of those copies would create a new data set. */
  newDataSetCount: number
  /** Aggregated cost breakdown across all copies. */
  costs: UploadCosts
}

/**
 * Shared shape returned by `add`/`import` when run with `--dry-run`.
 * Extend per command for any command-specific fields (e.g. `isDirectory` on add).
 */
export interface UploadDryRunResult {
  dryRun: true
  filePath: string
  fileSize: number
  rootCid: string
  requestedCopies: number
  newDataSetCount: number
  costs: UploadCosts
}

/**
 * Estimate the cost of an upload without submitting any transaction.
 *
 * Resolves contexts via `createContexts()` using the same selectors the real
 * upload would use, then aggregates costs across all of them with
 * `calculateMultiContextCosts()`. That function sums per-context lockup/fees
 * while computing account-level debt/runway/buffer exactly once; calling the
 * single-context `getUploadCosts()` once per copy and summing the results
 * would double-count those account-level terms.
 *
 * @param synapse - Initialized Synapse instance (read-only auth is sufficient)
 * @param fileSize - Size of the data to upload, in bytes
 * @param options - Copy count / targeting / metadata, mirroring the real upload's selectors
 */
export async function estimateUploadCost(
  synapse: Synapse,
  fileSize: number,
  options: EstimateUploadCostOptions
): Promise<UploadCostEstimate> {
  const requestedCopies = options.providerIds?.length ?? options.dataSetIds?.length ?? options.copies ?? DEFAULT_COPIES

  // Mirror uploadToSynapse's metadata injection: when not targeting specific data
  // sets by ID, prepend WITH_IPFS_INDEXING so metadataMatches() finds existing
  // data sets that the real upload would also resolve to (it uses exact key-count
  // matching — omitting this key causes all contexts to resolve as new data sets).
  const resolvedMetadata: Record<string, string> =
    options.dataSetIds != null
      ? (options.metadata ?? {})
      : { [METADATA_KEYS.WITH_IPFS_INDEXING]: '', ...(options.metadata ?? {}) }

  const contexts = await synapse.storage.createContexts({
    copies: requestedCopies,
    ...(options.providerIds && { providerIds: options.providerIds }),
    ...(options.dataSetIds && { dataSetIds: options.dataSetIds }),
    metadata: resolvedMetadata,
    ...(options.withCDN && { withCDN: options.withCDN }),
  })

  const newDataSetCount = contexts.filter((context) => context.dataSetId == null).length
  const costs = await synapse.storage.calculateMultiContextCosts(contexts, { dataSize: BigInt(fileSize) })

  return { requestedCopies, newDataSetCount, costs }
}

/**
 * Display a dry-run cost estimate. No upload happens and no funds move.
 */
export function displayDryRunEstimate(
  fileInfo: { filePath: string; fileSize: number; rootCid: string },
  estimate: UploadCostEstimate,
  networkDisplay: string
): void {
  const { requestedCopies, newDataSetCount, costs } = estimate
  const existingDataSetCount = requestedCopies - newDataSetCount

  log.line(`Network: ${pc.bold(networkDisplay)}`)
  log.line('')

  log.line(pc.bold('Content'))
  log.indent(`File: ${fileInfo.filePath}`)
  log.indent(`Size: ${formatFileSize(fileInfo.fileSize)}`)
  log.indent(`Root CID: ${fileInfo.rootCid}`)
  log.line('')

  log.line(pc.bold('Copies'))
  const dataSetParts = [
    newDataSetCount > 0 && `${newDataSetCount} new`,
    existingDataSetCount > 0 && `${existingDataSetCount} existing`,
  ].filter((part): part is string => Boolean(part))
  const dataSetSuffix =
    dataSetParts.length > 0 ? ` (${dataSetParts.join(', ')} data set${requestedCopies !== 1 ? 's' : ''})` : ''
  log.indent(`Requested: ${requestedCopies}${dataSetSuffix}`)
  log.line('')

  log.line(pc.bold('Estimated Cost'))
  log.indent(`Storage rate: ${formatUSDFC(costs.rates.perMonth)} USDFC/month`)
  log.indent(`One-time fees: ${formatUSDFC(costs.fees.total)} USDFC`)
  log.indent(`Lockup (held while active): ${formatUSDFC(costs.lockups.total)} USDFC`)
  log.indent(`Deposit needed: ${formatUSDFC(costs.depositNeeded)} USDFC`)
  log.line('')

  if (costs.ready) {
    log.line(`${pc.green('✓')} Account is ready to upload — no deposit or approval needed`)
  } else {
    log.line(`${pc.yellow('⚠')} Account is not ready to upload:`)
    if (costs.depositNeeded > 0n) {
      log.indent(`Deposit ${formatUSDFC(costs.depositNeeded)} USDFC before uploading`)
    }
    if (costs.needsFwssMaxApproval) {
      log.indent('WarmStorage operator approval required')
    }
  }
  log.line('')
  log.line(pc.gray('Dry run — no upload performed, no funds moved.'))
  log.flush()
}

/**
 * Format a role label for spinner output (e.g., "[Primary]" or "[Secondary]")
 */
type CopyRole = 'primary' | 'secondary'

function roleLabel(role: CopyRole): string {
  return role === 'primary' ? pc.cyan('[Primary]') : pc.magenta('[Secondary]')
}

/**
 * Upload CAR data to Synapse with multi-copy progress tracking
 *
 * @param synapse - Initialized Synapse instance
 * @param carData - CAR file data as bytes or a readable stream
 * @param rootCid - Root CID of the content
 * @param options - Upload flow options
 * @returns Upload result with copies and network information
 */
export async function performUpload(
  synapse: Synapse,
  carData: SynapseUploadData,
  rootCid: CID,
  options: UploadFlowOptions
): Promise<UploadFlowResult> {
  const { contextType, fileSize, logger, spinner, pieceMetadata } = options

  const flow = createSpinnerFlow(spinner)

  // Start with upload operation
  flow.addOperation('upload', 'Uploading to Filecoin...')

  // Track primary provider ID from `stored` to label subsequent events
  let primaryProviderId: bigint | undefined
  let lastUploadPercent = -1

  function getRole(providerId: bigint): CopyRole {
    if (primaryProviderId == null || providerId === primaryProviderId) {
      return 'primary'
    }
    return 'secondary'
  }

  function getUploadProgressMessage(bytesUploaded: number): { percent: number; message: string } {
    const totalBytes = Math.max(fileSize, 1)
    const uploadedBytes = Math.min(bytesUploaded, totalBytes)
    const percent = Math.min(100, Math.floor((uploadedBytes / totalBytes) * 100))
    return {
      percent,
      message: `Uploading to Filecoin... ${formatFileSize(uploadedBytes)}/${formatFileSize(fileSize)} (${percent}%)`,
    }
  }

  function getIpniAdvertisementMsg(details: {
    attempt: number
    totalAttempts: number
    cidAttempt: number
    cidMaxAttempts: number
    cidIndex: number
    cidCount: number
  }): string {
    const { attempt, totalAttempts, cidAttempt, cidMaxAttempts, cidIndex, cidCount } = details
    const overallPart = totalAttempts > 0 ? `${attempt}/${totalAttempts}` : `${attempt}`
    const cidPart = cidCount > 1 ? `, CID ${cidIndex}/${cidCount} attempt ${cidAttempt}/${cidMaxAttempts}` : ''
    return `Checking for IPNI provider records (${overallPart}${cidPart})`
  }

  const network = getNetworkSlug(synapse.chain)

  const uploadResult = await executeUpload(synapse, carData, rootCid, {
    logger,
    contextId: `${contextType}-${Date.now()}`,
    ...(pieceMetadata && { pieceMetadata }),
    ...(options.copies != null && { copies: options.copies }),
    ...(options.providerIds != null && { providerIds: options.providerIds }),
    ...(options.dataSetIds != null && { dataSetIds: options.dataSetIds }),
    ...(options.excludeProviderIds != null && { excludeProviderIds: options.excludeProviderIds }),
    ...(options.metadata != null && { metadata: options.metadata }),
    ...(options.skipIpniVerification && { ipniValidation: { enabled: false } }),
    onProgress(event) {
      switch (event.type) {
        case 'uploadProgress': {
          const { percent, message } = getUploadProgressMessage(event.data.bytesUploaded)
          if (percent > lastUploadPercent) {
            lastUploadPercent = percent
            flow.updateOperation('upload', message)
          }
          break
        }
        case 'stored': {
          primaryProviderId = event.data.providerId
          flow.completeOperation('upload', `${roleLabel('primary')} Stored on provider ${event.data.providerId}`, {
            type: 'success',
          })
          // Commit happens later (`piecesAdded`), not here.
          break
        }
        case 'pullProgress': {
          flow.addOperation(
            `secondary-pull-${event.data.providerId}`,
            `${roleLabel('secondary')} Pulling to provider ${event.data.providerId}...`
          )
          break
        }
        case 'copyComplete': {
          flow.completeOperation(
            `secondary-pull-${event.data.providerId}`,
            `${roleLabel('secondary')} Stored on provider ${event.data.providerId}`,
            { type: 'success' }
          )
          break
        }
        case 'copyFailed': {
          flow.completeOperation(
            `secondary-pull-${event.data.providerId}`,
            `${roleLabel('secondary')} Failed: provider ${event.data.providerId} - ${event.data.error.message}`,
            { type: 'warning' }
          )
          break
        }
        case 'piecesAdded': {
          const role = getRole(event.data.providerId)

          const commitId = `commit-${event.data.providerId}`
          flow.addOperation(commitId, `${roleLabel(role)} Adding piece to Data Set...`)

          // Show per-SP transaction URL as indented line under the "added" message
          const afterLines: string[] = []
          if (event.data.txHash) {
            if (network === 'devnet') {
              afterLines.push(pc.gray(`Tx: ${event.data.txHash}`))
            } else {
              const filfoxBase = network === 'mainnet' ? 'https://filfox.info' : `https://${network}.filfox.info`
              afterLines.push(pc.gray(`Tx: ${filfoxBase}/en/message/${event.data.txHash}`))
            }
          }
          flow.completeOperation(commitId, `${roleLabel(role)} Piece added to Data Set (unconfirmed on-chain)`, {
            type: 'success',
            ...(afterLines.length > 0 && { afterLines }),
          })
          flow.addOperation(
            `chain-${event.data.providerId}`,
            `${roleLabel(role)} Confirming piece added to Data Set on-chain`
          )
          break
        }
        case 'piecesConfirmed': {
          const role = getRole(event.data.providerId)
          flow.completeOperation(
            `chain-${event.data.providerId}`,
            `${roleLabel(role)} Piece added to Data Set (confirmed on-chain)`,
            { type: 'success' }
          )
          break
        }

        case 'ipniProviderResults:retryUpdate': {
          const attempt = event.data.attempt ?? (event.data.retryCount === 0 ? 1 : event.data.retryCount + 1)
          flow.addOperation(
            'ipni',
            getIpniAdvertisementMsg({
              attempt,
              totalAttempts: event.data.totalAttempts ?? attempt,
              cidAttempt: event.data.cidAttempt ?? attempt,
              cidMaxAttempts: event.data.cidMaxAttempts ?? event.data.totalAttempts ?? attempt,
              cidIndex: event.data.cidIndex ?? 1,
              cidCount: event.data.cidCount ?? 1,
            })
          )
          break
        }
        case 'ipniProviderResults:complete': {
          flow.completeOperation('ipni', 'IPNI provider records found. IPFS retrieval possible.', {
            type: 'success',
            details: {
              title: 'IPFS Retrieval URLs',
              content: [pc.gray(`View in a browser: https://inbrowser.link/ipfs/${rootCid}`)],
            },
          })
          break
        }
        case 'ipniProviderResults:failed': {
          flow.completeOperation('ipni', 'IPNI provider records not found.', {
            type: 'warning',
            details: {
              title: 'IPFS retrieval is not possible yet.',
              content: [pc.gray(`IPNI provider records for this SP does not exist for the provided root CID`)],
            },
          })
          break
        }
        default: {
          break
        }
      }
    },
  })

  return uploadResult
}

/**
 * Display results for import or add command
 *
 * @param result - Result data to display
 * @param operation - Operation name ('Import' or 'Add')
 * @param networkDisplay - Human-readable network name
 * @param networkSlug - Network slug used to build explorer URLs
 * @param egress - Optional egress info; when `filbeamUrl` is set, a FilBeam block is rendered
 */
export function displayUploadResults(
  result: {
    filePath: string
    fileSize: number
    rootCid: string
    pieceCid: string
    size?: number
    copies: CopyResult[]
    failedAttempts: FailedAttempt[]
  },
  operation: string,
  networkDisplay: string,
  networkSlug: string,
  egress?: { filbeamUrl?: string }
): void {
  log.line(`Network: ${pc.bold(networkDisplay)}`)
  log.line('')

  log.line(pc.bold(`${operation} Details`))
  log.indent(`File: ${result.filePath}`)
  log.indent(`Size: ${formatFileSize(result.fileSize)}`)
  log.indent(`Root CID: ${result.rootCid}`)
  log.line('')

  log.line(pc.bold('Filecoin Storage'))
  log.indent(`Piece CID: ${result.pieceCid}`)
  if (result.size != null) {
    log.indent(`Piece Size: ${formatFileSize(result.size)}`)
  }
  if (networkSlug !== 'devnet') {
    log.indent(`Explorer: ${pc.gray(`https://pdp.vxb.ai/${encodeURIComponent(networkSlug)}/piece/${result.pieceCid}`)}`)
  }
  log.line('')

  if (result.copies.length > 0) {
    log.line(pc.bold('Copies'))
    for (const copy of result.copies) {
      const label = copy.role === 'primary' ? pc.cyan('[Primary]') : pc.magenta('[Secondary]')
      log.indent(`${label} Provider ${copy.providerId}`)
      log.indent(`  Data Set ID: ${copy.dataSetId}`)
      log.indent(`  Piece ID: ${copy.pieceId}`)
      if (copy.retrievalUrl) {
        log.indent(`  Retrieval URL: ${copy.retrievalUrl}`)
      }
      if (copy.isNewDataSet) {
        log.indent(`  ${pc.gray('(new data set created)')}`)
      }
    }
  }

  if (result.failedAttempts.length > 0) {
    log.line('')
    log.line(pc.bold(pc.yellow('Warnings')))
    for (const attempt of result.failedAttempts) {
      const label = attempt.role === 'primary' ? pc.cyan('[Primary]') : pc.magenta('[Secondary]')
      log.indent(`${pc.yellow('⚠')} ${label} Provider ${attempt.providerId} failed: ${attempt.error}`)
    }
  }

  if (egress?.filbeamUrl != null) {
    log.line('')
    log.line(pc.bold('FilBeam Egress (CDN)'))
    log.indent(`URL: ${pc.gray(egress.filbeamUrl)}`)
    log.indent('Note: serves CAR/piece data, not the original file.')
    log.indent('Disable on next upload: --egress-provider none')
  }

  log.flush()
}
