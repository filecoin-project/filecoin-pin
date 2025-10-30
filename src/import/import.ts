/**
 * CAR file import functionality
 *
 * This module handles importing existing CAR files to Filecoin via Synapse SDK.
 * It validates the CAR format, extracts root CIDs, and uploads to Filecoin.
 */

import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { CarReader } from '@ipld/car'
import { CID } from 'multiformats/cid'
import pc from 'picocolors'
import pino from 'pino'
import { warnAboutCDNPricingLimitations } from '../common/cdn-warning.js'
import { displayUploadResults, performAutoFunding, performUpload, validatePaymentSetup } from '../common/upload-flow.js'
import {
  cleanupSynapseService,
  createStorageContext,
  initializeSynapse,
  type SynapseService,
} from '../core/synapse/index.js'
import { parseCLIAuth, parseProviderOptions } from '../utils/cli-auth.js'
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

  // Check CDN status and warn if enabled
  const withCDN = process.env.WITH_CDN === 'true'
  if (withCDN) {
    const proceed = await warnAboutCDNPricingLimitations()
    if (!proceed) {
      cancel('Import cancelled')
      process.exitCode = 1
      throw new Error('CDN pricing limitations warning cancelled')
    }
  }

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

    // Parse authentication options from CLI and environment
    const config = parseCLIAuth(options)
    if (withCDN) config.withCDN = true

    // Initialize just the Synapse SDK
    const synapse = await initializeSynapse(config, logger)
    const network = synapse.getNetwork()

    spinner.stop(`${pc.green('✓')} Connected to ${pc.bold(network)}`)

    if (options.autoFund) {
      // Step 5: Perform auto-funding if requested (now that we know the file size)
      await performAutoFunding(synapse, fileStat.size, spinner)
    } else {
      // Step 5: Validate payment setup (may configure permissions if needed)
      spinner.start('Checking payment capacity...')
      await validatePaymentSetup(synapse, fileStat.size, spinner)
    }

    // Step 6: Create storage context now that payments are validated
    spinner.start('Creating storage context...')

    // Parse provider selection from CLI options and environment variables
    const providerOptions = parseProviderOptions(options)

    const { storage, providerInfo } = await createStorageContext(synapse, logger, {
      ...providerOptions,
      callbacks: {
        onProviderSelected: (provider) => {
          spinner.message(`Connecting to storage provider: ${provider.name || provider.serviceProvider}...`)
        },
        onDataSetResolved: (info) => {
          if (info.isExisting) {
            spinner.message(`Using existing data set #${info.dataSetId}`)
          } else {
            spinner.message(`Created new data set #${info.dataSetId}`)
          }
        },
      },
    })

    spinner.stop(`${pc.green('✓')} Storage context ready`)

    // Create service object for upload function
    const synapseService: SynapseService = { synapse, storage, providerInfo }

    // Step 7: Read CAR file and upload to Synapse
    spinner.start('Uploading to Filecoin...')

    // Read the entire CAR file (streaming not yet supported in Synapse)
    const carData = await readFile(options.filePath)

    // Upload using common upload flow
    const uploadResult = await performUpload(synapseService, carData, rootCid, {
      contextType: 'import',
      fileSize: fileStat.size,
      logger,
      spinner,
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
      transactionHash: uploadResult.transactionHash !== undefined ? uploadResult.transactionHash : undefined,
      providerInfo,
    }

    // Display the results
    displayUploadResults(result, 'Import', network)

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
