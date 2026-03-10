/**
 * Common upload flow shared between import and add commands
 *
 * This module provides reusable functions for the Synapse upload workflow
 * including payment validation, storage context creation, and result display.
 */

import type { CopyResult, FailedCopy, Synapse } from '@filoz/synapse-sdk'
import type { CID } from 'multiformats/cid'
import pc from 'picocolors'
import type { Logger } from 'pino'
import { DEFAULT_LOCKUP_DAYS, type PaymentCapacityCheck } from '../core/payments/index.js'
import { checkUploadReadiness, executeUpload, getNetworkSlug, type SynapseUploadResult } from '../core/upload/index.js'
import { formatUSDFC } from '../core/utils/format.js'
import { autoFund } from '../payments/fund.js'
import type { AutoFundOptions } from '../payments/types.js'
import type { Spinner } from '../utils/cli-helpers.js'
import { cancel, formatFileSize } from '../utils/cli-helpers.js'
import { log } from '../utils/cli-logger.js'
import { createSpinnerFlow } from '../utils/multi-operation-spinner.js'

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
  count?: number

  /** Specific provider IDs to use. */
  providerIds?: bigint[]

  /** Specific data set IDs to use. */
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
 * Automatically ensures a minimum of 30 days of runway based on current usage + new file requirements
 *
 * @param synapse - Initialized Synapse instance
 * @param fileSize - Size of file being uploaded (in bytes)
 * @param spinner - Optional spinner for progress
 */
export async function performAutoFunding(synapse: Synapse, fileSize: number, spinner?: Spinner): Promise<void> {
  spinner?.start('Checking funding requirements for upload...')

  try {
    const fundOptions: AutoFundOptions = {
      synapse,
      fileSize,
    }
    if (spinner !== undefined) {
      fundOptions.spinner = spinner
    }
    const result = await autoFund(fundOptions)
    spinner?.stop(`${pc.green('✓')} Funding requirements met`)

    if (result.adjusted) {
      log.line('')
      log.line(pc.bold('Auto-funding completed:'))
      log.indent(`Deposited ${formatUSDFC(result.delta)} USDFC`)
      log.indent(`Total deposited: ${formatUSDFC(result.newDepositedAmount)} USDFC`)
      log.indent(
        `Runway: ~${result.newRunwayDays} day(s)${result.newRunwayHours > 0 ? ` ${result.newRunwayHours} hour(s)` : ''}`
      )
      if (result.transactionHash) {
        log.indent(pc.gray(`Transaction: ${result.transactionHash}`))
      }
      log.line('')
      log.flush()
    }
  } catch (error) {
    spinner?.stop(`${pc.red('✗')} Auto-funding failed`)
    log.line('')
    log.line(`${pc.red('Error:')} ${error instanceof Error ? error.message : String(error)}`)
    log.flush()
    cancel('Operation cancelled - auto-funding failed')
    process.exit(1)
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
 * @returns true if validation passes, exits process if not
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
        case 'checking-balances': {
          spinner.message('Checking payment setup requirements...')
          return
        }
        case 'checking-allowances': {
          spinner.message('Checking WarmStorage permissions...')
          return
        }
        case 'configuring-allowances': {
          spinner.message('Configuring WarmStorage permissions (one-time setup)...')
          return
        }
        case 'validating-capacity': {
          spinner.message('Validating payment capacity...')
          return
        }
        case 'allowances-configured': {
          // No spinner change; we log once readiness completes.
          return
        }
      }
    },
  })
  const { validation, allowances, capacity, suggestions } = readiness

  if (!validation.isValid) {
    spinner?.stop(`${pc.red('✗')} Payment setup incomplete`)

    log.line('')
    log.line(`${pc.red('✗')} ${validation.errorMessage}`)

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
    process.exit(1)
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
    process.exit(1)
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
 * @param carData - CAR file data as Uint8Array
 * @param rootCid - Root CID of the content
 * @param options - Upload flow options
 * @returns Upload result with copies and failures
 */
export async function performUpload(
  synapse: Synapse,
  carData: Uint8Array,
  rootCid: CID,
  options: UploadFlowOptions
): Promise<UploadFlowResult> {
  const { contextType, logger, spinner, pieceMetadata } = options

  const flow = createSpinnerFlow(spinner)

  // Start with upload operation
  flow.addOperation('upload', 'Uploading to Filecoin...')

  // Track primary provider ID from onStored to label subsequent events
  let primaryProviderId: bigint | undefined

  function getRole(providerId: bigint): CopyRole {
    if (primaryProviderId == null || providerId === primaryProviderId) {
      return 'primary'
    }
    return 'secondary'
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
    ...(options.count != null && { count: options.count }),
    ...(options.providerIds != null && { providerIds: options.providerIds }),
    ...(options.dataSetIds != null && { dataSetIds: options.dataSetIds }),
    ...(options.excludeProviderIds != null && { excludeProviderIds: options.excludeProviderIds }),
    ...(options.metadata != null && { metadata: options.metadata }),
    ...(options.skipIpniVerification && { ipniValidation: { enabled: false } }),
    onProgress(event) {
      switch (event.type) {
        case 'onStored': {
          primaryProviderId = event.data.providerId
          flow.completeOperation('upload', `${roleLabel('primary')} Stored on provider ${event.data.providerId}`, {
            type: 'success',
          })
          // Commit happens later (onPiecesAdded), not here.
          break
        }
        case 'onPullProgress': {
          flow.addOperation(
            `secondary-pull-${event.data.providerId}`,
            `${roleLabel('secondary')} Pulling to provider ${event.data.providerId}...`
          )
          break
        }
        case 'onCopyComplete': {
          flow.completeOperation(
            `secondary-pull-${event.data.providerId}`,
            `${roleLabel('secondary')} Stored on provider ${event.data.providerId}`,
            { type: 'success' }
          )
          break
        }
        case 'onCopyFailed': {
          flow.completeOperation(
            `secondary-pull-${event.data.providerId}`,
            `${roleLabel('secondary')} Failed: provider ${event.data.providerId} - ${event.data.error.message}`,
            { type: 'warning' }
          )
          break
        }
        case 'onPiecesAdded': {
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
        case 'onPiecesConfirmed': {
          const role = getRole(event.data.providerId)
          flow.completeOperation(
            `chain-${event.data.providerId}`,
            `${roleLabel(role)} Piece added to Data Set (confirmed on-chain)`,
            { type: 'success' }
          )
          break
        }

        case 'ipniProviderResults.retryUpdate': {
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
        case 'ipniProviderResults.complete': {
          flow.completeOperation('ipni', 'IPNI provider records found. IPFS retrieval possible.', {
            type: 'success',
            details: {
              title: 'IPFS Retrieval URLs',
              content: [
                pc.gray(`ipfs://${rootCid}`),
                pc.gray(`https://inbrowser.link/ipfs/${rootCid}`),
                pc.gray(`https://dweb.link/ipfs/${rootCid}`),
              ],
            },
          })
          break
        }
        case 'ipniProviderResults.failed': {
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
 * @param network - Network name
 */
export function displayUploadResults(
  result: {
    filePath: string
    fileSize: number
    rootCid: string
    pieceCid: string
    size?: number
    copies: CopyResult[]
    failures: FailedCopy[]
  },
  operation: string,
  networkDisplay: string,
  networkSlug: string
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

  if (result.failures.length > 0) {
    log.line('')
    log.line(pc.bold(pc.yellow('Warnings')))
    for (const failure of result.failures) {
      const label = failure.role === 'primary' ? pc.cyan('[Primary]') : pc.magenta('[Secondary]')
      log.indent(`${pc.yellow('⚠')} ${label} Provider ${failure.providerId} failed: ${failure.error}`)
    }
  }

  log.flush()
}
