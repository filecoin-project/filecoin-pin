/**
 * Common upload flow shared between import and add commands
 *
 * This module provides reusable functions for the Synapse upload workflow
 * including payment validation, storage context creation, and result display.
 */

import type { PieceCID, Synapse } from '@filoz/synapse-sdk'
import type { CID } from 'multiformats/cid'
import pc from 'picocolors'
import type { Logger } from 'pino'
import { DEFAULT_LOCKUP_DAYS, type PaymentCapacityCheck } from '../core/payments/index.js'
import { cleanupSynapseService, type SynapseService } from '../core/synapse/index.js'
import {
  checkUploadReadiness,
  executeUpload,
  getDownloadURL,
  getServiceURL,
  type SynapseUploadResult,
} from '../core/upload/index.js'
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
   * Optional metadata attached to the upload request
   */
  pieceMetadata?: Record<string, string>
}

export interface UploadFlowResult extends SynapseUploadResult {
  network: string
  transactionHash?: string | undefined
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
    await cleanupSynapseService()
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

    await cleanupSynapseService()
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
    await cleanupSynapseService()
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
 * Upload CAR data to Synapse with progress tracking
 *
 * @param synapseService - Initialized Synapse service with storage context
 * @param carData - CAR file data as Uint8Array
 * @param rootCid - Root CID of the content
 * @param options - Upload flow options
 * @returns Upload result with transaction hash
 */
export async function performUpload(
  synapseService: SynapseService,
  carData: Uint8Array,
  rootCid: CID,
  options: UploadFlowOptions
): Promise<UploadFlowResult> {
  const { contextType, logger, spinner, pieceMetadata } = options

  // Create spinner flow manager for tracking all operations
  const flow = createSpinnerFlow(spinner)

  // Start with upload operation
  flow.addOperation('upload', 'Uploading to Filecoin...')

  let transactionHash: string | undefined

  let pieceCid: PieceCID | undefined
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

  const uploadResult = await executeUpload(synapseService, carData, rootCid, {
    logger,
    contextId: `${contextType}-${Date.now()}`,
    ...(pieceMetadata && { pieceMetadata }),
    onProgress(event) {
      switch (event.type) {
        case 'onUploadComplete': {
          pieceCid = event.data.pieceCid
          flow.completeOperation('upload', 'Upload complete', {
            type: 'success',
            details: (() => {
              const serviceURL = getServiceURL(synapseService.providerInfo)
              if (serviceURL != null && serviceURL !== '') {
                return {
                  title: 'Download IPFS CAR from SP',
                  content: [pc.gray(`${serviceURL.replace(/\/$/, '')}/ipfs/${rootCid}`)],
                }
              }
              return
            })(),
          })
          // Start adding piece to dataset operation
          flow.addOperation('add-to-dataset', 'Adding piece to DataSet...')
          break
        }
        case 'onPieceAdded': {
          if (event.data.txHash) {
            transactionHash = event.data.txHash
          }
          const network = synapseService.synapse.chain.name.toLowerCase()
          const explorerUrls = [pc.gray(`Piece: https://pdp.vxb.ai/${network}/piece/${pieceCid}`)]
          if (transactionHash) {
            const filfoxBase = network === 'mainnet' ? 'https://filfox.info' : `https://${network}.filfox.info`
            explorerUrls.push(pc.gray(`Transaction: ${filfoxBase}/en/message/${transactionHash}`))
          }
          flow.completeOperation('add-to-dataset', 'Piece added to DataSet (unconfirmed on-chain)', {
            type: 'success',
            details: {
              title: 'Explorer URLs',
              content: explorerUrls,
            },
          })
          // Start chain confirmation operation
          flow.addOperation('chain', 'Confirming piece added to DataSet on-chain')
          break
        }
        case 'onPieceConfirmed': {
          flow.completeOperation('chain', 'Piece added to DataSet (confirmed on-chain)', {
            type: 'success',
          })
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
          // complete event is only emitted when result === true (success)
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

  return {
    ...uploadResult,
    network: synapseService.synapse.chain.name.toLowerCase(),
    transactionHash: uploadResult.transactionHash,
  }
}

/**
 * Display results for import or add command
 *
 * @param result - Result data to display
 * @param operation - Operation name ('Import' or 'Add')
 */
export function displayUploadResults(
  result: {
    filePath: string
    fileSize: number
    rootCid: string
    pieceCid: string
    pieceId?: number | undefined
    dataSetId: string
    providerInfo: any
    transactionHash?: string | undefined
  },
  operation: string,
  network: string
): void {
  log.line(`Network: ${pc.bold(network)}`)
  log.line('')

  log.line(pc.bold(`${operation} Details`))
  log.indent(`File: ${result.filePath}`)
  log.indent(`Size: ${formatFileSize(result.fileSize)}`)
  log.indent(`Root CID: ${result.rootCid}`)
  log.line('')

  log.line(pc.bold('Filecoin Storage'))
  log.indent(`Piece CID: ${result.pieceCid}`)
  log.indent(`Piece ID: ${result.pieceId?.toString() || 'N/A'}`)
  log.indent(`Data Set ID: ${result.dataSetId}`)

  log.line('')
  log.line(pc.bold('Storage Provider'))
  log.indent(`Provider ID: ${result.providerInfo.id}`)
  log.indent(`Name: ${result.providerInfo.name}`)
  const downloadURL = getDownloadURL(result.providerInfo, result.pieceCid)
  if (downloadURL) {
    log.indent(`Direct Download URL: ${downloadURL}`)
  }

  if (result.transactionHash) {
    log.line('')
    log.line(pc.bold('Transaction'))
    log.indent(`Hash: ${result.transactionHash}`)
  }

  log.flush()
}
