/**
 * CAR file import functionality
 *
 * This module handles importing existing CAR files to Filecoin via Synapse SDK.
 * It validates the CAR format, extracts root CIDs, and uploads to Filecoin.
 */

import { createReadStream, existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { RPC_URLS } from '@filoz/synapse-sdk'
import { CarReader } from '@ipld/car'
import { CID } from 'multiformats/cid'
import pc from 'picocolors'
import pino from 'pino'
import { checkInsufficientFunds, formatUSDFC } from '../payments/setup.js'
import { checkFILBalance, checkUSDFCBalance, validatePaymentCapacity } from '../synapse/payments.js'
import { cleanupSynapseService, initializeSynapse } from '../synapse/service.js'
import { uploadToSynapse } from '../synapse/upload.js'
import { createSpinner, formatFileSize, intro } from '../utils/cli-helpers.js'
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

    if (!existsSync(options.filePath)) {
      spinner.stop()
      console.error(`${pc.red('✗')} File not found: ${options.filePath}`)
      process.exit(1)
    }

    const fileStat = await stat(options.filePath)
    if (!fileStat.isFile()) {
      spinner.stop()
      console.error(`${pc.red('✗')} Not a file: ${options.filePath}`)
      process.exit(1)
    }

    // Step 2: Validate CAR format and extract roots
    let roots: CID[]
    try {
      roots = await validateCarFile(options.filePath)
    } catch (error) {
      spinner.stop()
      console.error(`${pc.red('✗')} Invalid CAR file: ${error instanceof Error ? error.message : 'Unknown error'}`)
      process.exit(1)
    }

    // Step 3: Handle root CID cases
    let rootCid: CID
    let rootCidString: string
    if (roots.length === 0) {
      // No roots - use zero CID
      rootCidString = ZERO_CID
      rootCid = CID.parse(ZERO_CID)
      spinner.stop(`${pc.green('✓')} Valid CAR file (${formatFileSize(fileStat.size)})`)
      log.line(`${pc.yellow('⚠')} No root CIDs found in CAR header, using zero CID: ${rootCidString}`)
      log.flush()
    } else if (roots.length === 1 && roots[0]) {
      // Exactly one root - perfect
      rootCid = roots[0]
      rootCidString = rootCid.toString()
      spinner.stop(`${pc.green('✓')} Valid CAR file (${formatFileSize(fileStat.size)})`)
      log.line(`Root CID: ${rootCidString}`)
      log.flush()
    } else if (roots[0]) {
      // Multiple roots - use first, warn about others
      rootCid = roots[0]
      rootCidString = rootCid.toString()
      spinner.stop(`${pc.green('✓')} Valid CAR file (${formatFileSize(fileStat.size)})`)
      log.line(`${pc.yellow('⚠')} Multiple root CIDs found (${roots.length}), using first: ${rootCidString}`)
      log.indent(
        `Other roots: ${roots
          .slice(1)
          .map((r) => r.toString())
          .join(', ')}`
      )
      log.flush()
    } else {
      // This shouldn't happen but handle it gracefully
      rootCidString = ZERO_CID
      rootCid = CID.parse(ZERO_CID)
      spinner.stop(`${pc.green('✓')} Valid CAR file (${formatFileSize(fileStat.size)})`)
      log.line(`${pc.yellow('⚠')} Invalid root CID structure, using zero CID: ${rootCidString}`)
      log.flush()
    }

    // Step 4: Initialize Synapse
    spinner.start('Initializing Synapse...')

    if (!options.privateKey) {
      spinner.stop()
      console.error(`${pc.red('✗')} Private key required via --private-key or PRIVATE_KEY env`)
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

    // Initialize Synapse with progress callbacks
    const synapseService = await initializeSynapse(config, logger, {
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
    const network = synapseService.synapse.getNetwork()

    spinner.stop(`${pc.green('✓')} Connected to ${pc.bold(network)}`)

    // Step 5: Validate payment setup
    spinner.start('Validating payment setup...')

    // First check basic requirements (FIL and USDFC balance)
    const { isCalibnet, hasSufficientGas } = await checkFILBalance(synapseService.synapse)
    const usdfcBalance = await checkUSDFCBalance(synapseService.synapse)

    // Check basic requirements using existing function
    const hasBasicRequirements = checkInsufficientFunds(hasSufficientGas, usdfcBalance, isCalibnet, false)

    if (!hasBasicRequirements) {
      spinner.stop(`${pc.red('✗')} Payment setup incomplete`)
      log.line('')
      log.line(`${pc.yellow('⚠')} Your payment setup is not complete. Please run:`)
      log.indent(pc.cyan('filecoin-pin payments setup'))
      log.line('')
      log.line('For more information, run:')
      log.indent(pc.cyan('filecoin-pin payments status'))
      log.flush()
      await cleanupSynapseService()
      process.exit(1)
    }

    // Now check capacity for this specific file
    const capacityCheck = await validatePaymentCapacity(synapseService.synapse, fileStat.size)

    if (!capacityCheck.canUpload) {
      spinner.stop(`${pc.red('✗')} Insufficient payment capacity for this file`)
      log.line('')
      log.line(pc.bold('File Requirements:'))
      log.indent(`File size: ${formatFileSize(fileStat.size)} (${capacityCheck.storageTiB.toFixed(4)} TiB)`)
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
      capacityCheck.suggestions.forEach((suggestion) => {
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
      await cleanupSynapseService()
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
      spinner.start('Uploading to Filecoin...')
    } else {
      spinner.stop(`${pc.green('✓')} Payment capacity verified`)
      spinner.start('Uploading to Filecoin...')
    }

    // Step 6: Read CAR file and upload to Synapse

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

    log.line(`Network: ${pc.bold(network)}`)
    log.line('')

    log.line(pc.bold('Import Details'))
    log.indent(`File: ${options.filePath}`)
    log.indent(`Size: ${formatFileSize(fileStat.size)}`)
    log.indent(`Root CID: ${rootCidString}`)
    log.line('')

    log.line(pc.bold('Filecoin Storage'))
    log.indent(`Piece CID: ${uploadResult.pieceCid}`)
    log.indent(`Piece ID: ${uploadResult.pieceId?.toString() || 'N/A'}`)
    log.indent(`Data Set ID: ${uploadResult.dataSetId}`)

    if (uploadResult.providerInfo) {
      log.line('')
      log.line(pc.bold('Storage Provider'))
      log.indent(`Provider ID: ${uploadResult.providerInfo.id}`)
      log.indent(`Name: ${uploadResult.providerInfo.name}`)
      log.indent(`Direct Download URL: ${uploadResult.providerInfo.downloadURL}`)
    }

    if (transactionHash) {
      log.line('')
      log.line(pc.bold('Transaction'))
      log.indent(`Hash: ${transactionHash}`)
    }

    log.flush()

    const result = {
      filePath: options.filePath,
      fileSize: fileStat.size,
      rootCid: rootCidString,
      pieceCid: uploadResult.pieceCid,
      pieceId: uploadResult.pieceId !== undefined ? uploadResult.pieceId : undefined,
      dataSetId: uploadResult.dataSetId,
      transactionHash: transactionHash !== undefined ? transactionHash : undefined,
      providerInfo: uploadResult.providerInfo,
    }

    // Clean up WebSocket providers to allow process termination
    await cleanupSynapseService()

    return result
  } catch (error) {
    spinner.stop()
    console.error(`${pc.red('✗')} Import failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    logger.error({ event: 'import.failed', error }, 'Import failed')

    // Clean up even on error
    await cleanupSynapseService()

    process.exit(1)
  }
}
