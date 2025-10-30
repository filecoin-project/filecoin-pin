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
import { DEFAULT_LOCKUP_DAYS, type PaymentCapacityCheck } from '../core/payments/index.js'
import { cleanupSynapseService, type SynapseService } from '../core/synapse/index.js'
import { checkUploadReadiness, executeUpload, getDownloadURL, type SynapseUploadResult } from '../core/upload/index.js'
import { formatUSDFC } from '../core/utils/format.js'
import { autoFund } from '../payments/fund.js'
import type { AutoFundOptions } from '../payments/types.js'
import type { Spinner } from '../utils/cli-helpers.js'
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
  spinner?: Spinner
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
      if (result.approvalTx) {
        log.indent(pc.gray(`Approval tx: ${result.approvalTx}`))
      }
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
 * @param fileSize - Size of file to upload in bytes
 * @param spinner - Optional spinner for progress
 * @returns true if validation passes, exits process if not
 */
export async function validatePaymentSetup(synapse: Synapse, fileSize: number, spinner?: Spinner): Promise<void> {
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
  if (suggestions.length > 0 && capacity?.canUpload) {
    spinner?.stop(`${pc.yellow('⚠')} Payment capacity check passed with warnings`)
    log.line('')
    log.line(pc.bold('Suggestions:'))
    suggestions.forEach((suggestion) => {
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
function displayPaymentIssues(capacityCheck: PaymentCapacityCheck, fileSize: number, spinner?: Spinner): void {
  spinner?.stop(`${pc.red('✗')} Insufficient deposit for this file`)
  log.line('')
  log.line(pc.bold('File Requirements:'))
  log.indent(`File size: ${formatFileSize(fileSize)} (${capacityCheck.storageTiB.toFixed(4)} TiB)`)
  log.indent(`Storage cost: ${formatUSDFC(capacityCheck.required.rateAllowance)} USDFC/epoch`)
  log.indent(
    `Required deposit: ${formatUSDFC(capacityCheck.required.lockupAllowance + capacityCheck.required.lockupAllowance / 10n)} USDFC`
  )
  log.indent(pc.gray(`(includes ${DEFAULT_LOCKUP_DAYS}-day safety reserve)`))
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
  const { contextType, logger, spinner } = options

  spinner?.start('Uploading to Filecoin...')

  const uploadResult = await executeUpload(synapseService, carData, rootCid, {
    logger,
    contextId: `${contextType}-${Date.now()}`,
    ipniValidation: { enabled: false },
    callbacks: {
      onUploadComplete: () => {
        spinner?.message('Upload complete, adding to data set...')
      },
      onPieceAdded: (transaction) => {
        if (transaction) {
          spinner?.message('Piece added to data set, confirming on-chain...')
        }
      },
    },
  })

  return {
    ...uploadResult,
    network: synapseService.synapse.getNetwork(),
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
