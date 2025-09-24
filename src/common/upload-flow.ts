/**
 * Common upload flow shared between import and add commands
 *
 * This module provides reusable functions for the Synapse upload workflow
 * including payment validation, storage context creation, and result display.
 */

import type { Synapse } from '@filoz/synapse-sdk'
import type { CID } from 'multiformats/cid'
import pc from 'picocolors'
import type { Logger } from 'pino'
import { formatUSDFC, validatePaymentRequirements } from '../payments/setup.js'
import { checkFILBalance, checkUSDFCBalance, validatePaymentCapacity } from '../synapse/payments.js'
import { cleanupSynapseService, type SynapseService } from '../synapse/service.js'
import { getDownloadURL, type SynapseUploadResult, uploadToSynapse } from '../synapse/upload.js'
import { cancel, formatFileSize } from '../utils/cli-helpers.js'
import { log } from '../utils/cli-logger.js'

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
  spinner?: ReturnType<typeof import('../utils/cli-helpers.js').createSpinner>
}

export interface UploadFlowResult extends SynapseUploadResult {
  network: string
  transactionHash?: string | undefined
}

/**
 * Validate payment setup and capacity for upload
 *
 * @param synapse - Initialized Synapse instance
 * @param fileSize - Size of file to upload in bytes
 * @param spinner - Optional spinner for progress
 * @returns true if validation passes, exits process if not
 */
export async function validatePaymentSetup(
  synapse: Synapse,
  fileSize: number,
  spinner?: ReturnType<typeof import('../utils/cli-helpers.js').createSpinner>
): Promise<void> {
  // Check basic requirements (FIL and USDFC balance)
  const filStatus = await checkFILBalance(synapse)
  const usdfcBalance = await checkUSDFCBalance(synapse)

  // Validate payment requirements
  const validation = validatePaymentRequirements(filStatus.hasSufficientGas, usdfcBalance, filStatus.isCalibnet)

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

  // Check capacity for this specific file
  const capacityCheck = await validatePaymentCapacity(synapse, fileSize)

  if (!capacityCheck.canUpload) {
    displayPaymentIssues(capacityCheck, fileSize, spinner)
    await cleanupSynapseService()
    cancel('Operation cancelled - insufficient payment capacity')
    process.exit(1)
  }

  // Show warning if suggestions exist (even if upload is possible)
  if (capacityCheck.suggestions.length > 0 && capacityCheck.canUpload) {
    spinner?.stop(`${pc.yellow('⚠')} Payment capacity check passed with warnings`)
    log.line('')
    log.line(pc.bold('Suggestions:'))
    capacityCheck.suggestions.forEach((suggestion) => {
      log.indent(`• ${suggestion}`)
    })
    log.flush()
  } else {
    spinner?.stop(`${pc.green('✓')} Payment capacity verified`)
  }
}

/**
 * Display payment capacity issues and suggestions
 */
function displayPaymentIssues(
  capacityCheck: any,
  fileSize: number,
  spinner?: ReturnType<typeof import('../utils/cli-helpers.js').createSpinner>
): void {
  spinner?.stop(`${pc.red('✗')} Insufficient payment capacity for this file`)
  log.line('')
  log.line(pc.bold('File Requirements:'))
  log.indent(`File size: ${formatFileSize(fileSize)} (${capacityCheck.storageTiB.toFixed(4)} TiB)`)
  log.indent(`Storage cost: ${formatUSDFC(capacityCheck.required.rateAllowance)} USDFC/epoch`)
  log.indent(`10-day lockup: ${formatUSDFC(capacityCheck.required.lockupAllowance)} USDFC`)
  log.line('')

  log.line(pc.bold(`${pc.red('Issues found:')}`))
  if (capacityCheck.issues.insufficientDeposit) {
    log.indent(
      `${pc.red('✗')} Insufficient deposit (need ${formatUSDFC(capacityCheck.issues.insufficientDeposit)} more)`
    )
  }
  if (capacityCheck.issues.insufficientRateAllowance) {
    log.indent(
      `${pc.red('✗')} Rate allowance too low (need ${formatUSDFC(capacityCheck.issues.insufficientRateAllowance)} more per epoch)`
    )
  }
  if (capacityCheck.issues.insufficientLockupAllowance) {
    log.indent(
      `${pc.red('✗')} Lockup allowance too low (need ${formatUSDFC(capacityCheck.issues.insufficientLockupAllowance)} more)`
    )
  }
  log.line('')

  log.line(pc.bold('Suggested actions:'))
  capacityCheck.suggestions.forEach((suggestion: string) => {
    log.indent(`• ${suggestion}`)
  })
  log.line('')

  // Calculate suggested parameters for payment setup
  const suggestedDeposit = capacityCheck.issues.insufficientDeposit
    ? formatUSDFC(capacityCheck.issues.insufficientDeposit)
    : '0'
  const suggestedStorage = `${Math.ceil(capacityCheck.storageTiB * 10) / 10}TiB/month`

  log.line(`${pc.yellow('⚠')} To fix these issues, run:`)
  if (capacityCheck.issues.insufficientDeposit) {
    log.indent(
      pc.cyan(`filecoin-pin payments setup --deposit ${suggestedDeposit} --storage ${suggestedStorage} --auto`)
    )
  } else {
    log.indent(pc.cyan(`filecoin-pin payments setup --storage ${suggestedStorage} --auto`))
  }
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
  const { contextType, logger, spinner } = options

  spinner?.start('Uploading to Filecoin...')

  // Track transaction hash from callbacks
  let transactionHash: string | undefined

  // Upload using shared function with root CID metadata
  const uploadResult = await uploadToSynapse(synapseService, carData, rootCid, logger, {
    contextId: `${contextType}-${Date.now()}`,
    callbacks: {
      onUploadComplete: () => {
        spinner?.message('Upload complete, adding to data set...')
      },
      onPieceAdded: (transaction) => {
        if (transaction) {
          transactionHash = transaction.hash
          spinner?.message('Piece added to data set, confirming on-chain...')
        }
      },
      onPieceConfirmed: () => {
        // Don't stop spinner here, caller will do it
      },
    },
  })

  return {
    ...uploadResult,
    network: synapseService.synapse.getNetwork(),
    transactionHash,
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
