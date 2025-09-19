/**
 * CAR file import functionality
 *
 * This module handles importing existing CAR files to Filecoin via Synapse SDK.
 * It validates the CAR format, extracts root CIDs, and uploads to Filecoin.
 */

import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { RPC_URLS } from '@filoz/synapse-sdk'
import { CarReader } from '@ipld/car'
import { CID } from 'multiformats/cid'
import pc from 'picocolors'
import pino from 'pino'
import { formatUSDFC, validatePaymentRequirements } from '../payments/setup.js'
import { checkFILBalance, checkUSDFCBalance, validatePaymentCapacity } from '../synapse/payments.js'
import {
  cleanupSynapseService,
  createStorageContext,
  initializeSynapse,
  type SynapseService,
} from '../synapse/service.js'
import { getDownloadURL, uploadToSynapse } from '../synapse/upload.js'
import { cancel, createSpinner, formatFileSize, intro, outro } from '../utils/cli-helpers.js'
import { log } from '../utils/cli-logger.js'
import type { ImportOptions, ImportResult } from './types.js'

/**
 * Zero CID used when CAR has no roots
 * This is the identity CID with empty data
 */
const ZERO_CID = 'bafkqaaa'

/**
 * Validate and extract roots from a CAR file
 *
 * @param filePath - Path to the CAR file
 * @returns Array of root CIDs
 */
async function validateCarFile(filePath: string): Promise<CID[]> {
  const inStream = createReadStream(filePath)

  try {
    // CarReader.fromIterable will only read the header, not the entire file
    const reader = await CarReader.fromIterable(inStream as any)
    const roots = await reader.getRoots()
    return roots
  } finally {
    // Ensure stream is closed
    inStream.close()
  }
}

/**
 * Resolve the root CID from CAR file roots
 * Handles multiple cases: no roots, single root, multiple roots
 */
function resolveRootCID(roots: CID[]): { cid: CID; cidString: string; message?: string } {
  if (roots.length === 0) {
    // No roots - use zero CID
    return {
      cid: CID.parse(ZERO_CID),
      cidString: ZERO_CID,
      message: `${pc.yellow('⚠')} No root CIDs found in CAR header, using zero CID: ${ZERO_CID}`,
    }
  }

  if (roots.length === 1 && roots[0]) {
    // Exactly one root - perfect
    const cid = roots[0]
    return {
      cid,
      cidString: cid.toString(),
      message: `Root CID: ${cid.toString()}`,
    }
  }

  if (roots[0]) {
    // Multiple roots - use first, warn about others
    const cid = roots[0]
    const otherRoots = roots
      .slice(1)
      .map((r) => r.toString())
      .join(', ')
    return {
      cid,
      cidString: cid.toString(),
      message: `${pc.yellow('⚠')} Multiple root CIDs found (${roots.length}), using first: ${cid.toString()}\n  Other roots: ${otherRoots}`,
    }
  }

  // This shouldn't happen but handle it gracefully
  return {
    cid: CID.parse(ZERO_CID),
    cidString: ZERO_CID,
    message: `${pc.yellow('⚠')} Invalid root CID structure, using zero CID: ${ZERO_CID}`,
  }
}

/**
 * Validate that a file exists and is a regular file
 */
async function validateFilePath(filePath: string): Promise<{ exists: boolean; stats?: any; error?: string }> {
  try {
    const stats = await stat(filePath)
    if (!stats.isFile()) {
      return { exists: false, error: `Not a file: ${filePath}` }
    }
    return { exists: true, stats }
  } catch (error: any) {
    // Differentiate between file not found and other errors
    if (error?.code === 'ENOENT') {
      return { exists: false, error: `File not found: ${filePath}` }
    }
    // Other errors like permission denied, etc.
    return { exists: false, error: `Cannot access file: ${filePath} (${error?.message || 'unknown error'})` }
  }
}

/**
 * Display payment capacity issues and suggestions
 */
function displayPaymentIssues(capacityCheck: any, fileSize: number, spinner: ReturnType<typeof createSpinner>): void {
  spinner.stop(`${pc.red('✗')} Insufficient payment capacity for this file`)
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
 * Display import results
 */
function displayImportResults(result: ImportResult, network: string, transactionHash?: string): void {
  log.line(`Network: ${pc.bold(network)}`)
  log.line('')

  log.line(pc.bold('Import Details'))
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

  if (transactionHash) {
    log.line('')
    log.line(pc.bold('Transaction'))
    log.indent(`Hash: ${transactionHash}`)
  }

  log.flush()
}

/**
 * Run the CAR import process
 *
 * @param options - Import configuration
 */
export async function runCarImport(options: ImportOptions): Promise<ImportResult> {
  intro(pc.bold('Filecoin Pin CAR Import'))

  const spinner = createSpinner()

  // Initialize logger (silent for CLI output)
  const logger = pino({
    level: process.env.LOG_LEVEL || 'error',
  })

  try {
    // Step 1: Validate file exists and is readable
    spinner.start('Validating CAR file...')

    const fileValidation = await validateFilePath(options.filePath)
    if (!fileValidation.exists || !fileValidation.stats) {
      spinner.stop(`${pc.red('✗')} ${fileValidation.error}`)
      cancel('Import cancelled')
      process.exit(1)
    }
    const fileStat = fileValidation.stats

    // Step 2: Validate CAR format and extract roots
    let roots: CID[]
    try {
      roots = await validateCarFile(options.filePath)
    } catch (error) {
      spinner.stop(`${pc.red('✗')} Invalid CAR file: ${error instanceof Error ? error.message : 'Unknown error'}`)
      cancel('Import cancelled')
      process.exit(1)
    }

    // Step 3: Handle root CID cases
    const rootCidInfo = resolveRootCID(roots)
    const { cid: rootCid, cidString: rootCidString, message } = rootCidInfo

    spinner.stop(`${pc.green('✓')} Valid CAR file (${formatFileSize(fileStat.size)})`)
    if (message) {
      log.line(message)
      log.flush()
    }

    // Step 4: Initialize Synapse SDK (without storage context)
    spinner.start('Initializing Synapse SDK...')

    if (!options.privateKey) {
      spinner.stop(`${pc.red('✗')} Private key required via --private-key or PRIVATE_KEY env`)
      cancel('Import cancelled')
      process.exit(1)
    }

    const config = {
      privateKey: options.privateKey,
      rpcUrl: options.rpcUrl || RPC_URLS.calibration.websocket,
      // Other config fields not needed for import
      port: 0,
      host: '',
      databasePath: '',
      carStoragePath: '',
      logLevel: 'error',
      warmStorageAddress: undefined,
    }

    // Initialize just the Synapse SDK
    const synapse = await initializeSynapse(config, logger)
    const network = synapse.getNetwork()

    spinner.stop(`${pc.green('✓')} Connected to ${pc.bold(network)}`)

    // Step 5: Validate payment setup before creating storage context
    spinner.start('Validating payment setup...')

    // First check basic requirements (FIL and USDFC balance)
    const filStatus = await checkFILBalance(synapse)
    const usdfcBalance = await checkUSDFCBalance(synapse)

    // Validate payment requirements
    const validation = validatePaymentRequirements(filStatus.hasSufficientGas, usdfcBalance, filStatus.isCalibnet)

    if (!validation.isValid) {
      spinner.stop(`${pc.red('✗')} Payment setup incomplete`)

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
      cancel('Import cancelled - payment setup required')
      process.exit(1)
    }

    // Now check capacity for this specific file
    const capacityCheck = await validatePaymentCapacity(synapse, fileStat.size)

    if (!capacityCheck.canUpload) {
      displayPaymentIssues(capacityCheck, fileStat.size, spinner)
      await cleanupSynapseService()
      cancel('Import cancelled - insufficient payment capacity')
      process.exit(1)
    }

    // Show warning if suggestions exist (even if upload is possible)
    if (capacityCheck.suggestions.length > 0 && capacityCheck.canUpload) {
      spinner.stop(`${pc.yellow('⚠')} Payment capacity check passed with warnings`)
      log.line('')
      log.line(pc.bold('Suggestions:'))
      capacityCheck.suggestions.forEach((suggestion) => {
        log.indent(`• ${suggestion}`)
      })
      log.flush()
    } else {
      spinner.stop(`${pc.green('✓')} Payment capacity verified`)
    }

    // Step 6: Create storage context now that payments are validated
    spinner.start('Creating storage context...')

    const { storage, providerInfo } = await createStorageContext(synapse, logger, {
      onProviderSelected: (provider) => {
        spinner.message(`Connecting to storage provider: ${provider.name || provider.serviceProvider}...`)
      },
      onDataSetCreationStarted: (transaction) => {
        spinner.message(`Creating data set (tx: ${transaction.hash.slice(0, 10)}...)`)
      },
      onDataSetResolved: (info) => {
        if (info.isExisting) {
          spinner.message(`Using existing data set #${info.dataSetId}`)
        } else {
          spinner.message(`Created new data set #${info.dataSetId}`)
        }
      },
    })

    spinner.stop(`${pc.green('✓')} Storage context ready`)

    // Create service object for upload function
    const synapseService: SynapseService = { synapse, storage, providerInfo }

    // Step 7: Read CAR file and upload to Synapse
    spinner.start('Uploading to Filecoin...')

    // Read the entire CAR file (streaming not yet supported in Synapse)
    const carData = await readFile(options.filePath)

    // Track transaction hash from callbacks
    let transactionHash: string | undefined

    // Upload using shared function with root CID metadata
    const uploadResult = await uploadToSynapse(synapseService, carData, rootCid, logger, {
      contextId: `import-${Date.now()}`,
      callbacks: {
        onUploadComplete: () => {
          spinner.message('Upload complete, adding to data set...')
        },
        onPieceAdded: (transaction) => {
          if (transaction) {
            transactionHash = transaction.hash
            spinner.message('Piece added to data set, confirming on-chain...')
          }
        },
        onPieceConfirmed: () => {
          // Don't stop spinner here, we'll do it after
        },
      },
    })

    // Step 6: Display results
    spinner.stop('━━━ Import Complete ━━━')

    const result: ImportResult = {
      filePath: options.filePath,
      fileSize: fileStat.size,
      rootCid: rootCidString,
      pieceCid: uploadResult.pieceCid,
      pieceId: uploadResult.pieceId !== undefined ? uploadResult.pieceId : undefined,
      dataSetId: uploadResult.dataSetId,
      transactionHash: transactionHash !== undefined ? transactionHash : undefined,
      providerInfo,
    }

    // Display the results
    displayImportResults(result, network, transactionHash)

    // Clean up WebSocket providers to allow process termination
    await cleanupSynapseService()

    // Show success outro
    outro('Import completed successfully')

    return result
  } catch (error) {
    spinner.stop(`${pc.red('✗')} Import failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    logger.error({ event: 'import.failed', error }, 'Import failed')

    // Clean up even on error
    await cleanupSynapseService()

    cancel('Import failed')
    process.exit(1)
  }
}
