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
import { DEVNET_CHAIN_ID } from '../common/get-rpc-url.js'
import { displayUploadResults, performAutoFunding, performUpload, validatePaymentSetup } from '../common/upload-flow.js'
import { normalizeMetadataConfig } from '../core/metadata/index.js'
import { initializeSynapse } from '../core/synapse/index.js'
import { getNetworkSlug } from '../core/upload/index.js'
import { parseCLIAuth, parseContextSelectionOptions } from '../utils/cli-auth.js'
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
function resolveRootCID(roots: CID[]): {
  cid: CID
  cidString: string
  message?: string
} {
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
    return {
      exists: false,
      error: `Cannot access file: ${filePath} (${error?.message || 'unknown error'})`,
    }
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

  const { pieceMetadata, dataSetMetadata } = normalizeMetadataConfig({
    pieceMetadata: options.pieceMetadata,
    dataSetMetadata: options.dataSetMetadata,
  })

  // Initialize logger (silent for CLI output)
  const logger = pino({
    level: process.env.LOG_LEVEL || 'silent',
  })

  // Check CDN status and warn if enabled
  const withCDN = process.env.WITH_CDN === 'true'
  if (withCDN) {
    const proceed = await warnAboutCDNPricingLimitations()
    if (!proceed) {
      cancel('Import cancelled')
      throw new Error('CDN pricing limitations warning cancelled')
    }
  }

  try {
    // Validate file exists and is readable
    spinner.start('Validating CAR file...')

    const fileValidation = await validateFilePath(options.filePath)
    if (!fileValidation.exists || !fileValidation.stats) {
      spinner.stop(`${pc.red('✗')} ${fileValidation.error}`)
      cancel('Import cancelled')
      throw new Error(fileValidation.error)
    }
    const fileStat = fileValidation.stats

    // Validate CAR format and extract roots
    let roots: CID[]
    try {
      roots = await validateCarFile(options.filePath)
    } catch (error) {
      spinner.stop(`${pc.red('✗')} Invalid CAR file: ${error instanceof Error ? error.message : 'Unknown error'}`)
      cancel('Import cancelled')
      throw new Error('Invalid CAR file')
    }

    // Handle root CID cases
    const rootCidInfo = resolveRootCID(roots)
    const { cid: rootCid, cidString: rootCidString, message } = rootCidInfo

    spinner.stop(`${pc.green('✓')} Valid CAR file (${formatFileSize(fileStat.size)})`)
    if (message) {
      log.line(message)
      log.flush()
    }

    // Validate context selection options early (before expensive operations)
    const contextSelection = parseContextSelectionOptions(options)

    // Initialize Synapse SDK
    spinner.start('Initializing Synapse SDK...')

    const config = parseCLIAuth(options)
    if (dataSetMetadata) {
      config.dataSetMetadata = dataSetMetadata
    }
    if (withCDN) config.withCDN = true

    const synapse = await initializeSynapse(config, logger)
    const networkSlug = getNetworkSlug(synapse.chain)
    const network = synapse.chain.name

    spinner.stop(`${pc.green('✓')} Connected to ${pc.bold(network)}`)

    if (options.autoFund) {
      const autoFundOptions: Parameters<typeof performAutoFunding>[3] = {
        ...(dataSetMetadata && { metadata: dataSetMetadata }),
        ...(options.copies != null && { copies: options.copies }),
      }
      if (contextSelection.providerIds) {
        autoFundOptions.providerIds = contextSelection.providerIds
        autoFundOptions.copies = contextSelection.providerIds.length
      }
      if (contextSelection.dataSetIds) {
        autoFundOptions.dataSetIds = contextSelection.dataSetIds
        autoFundOptions.copies = contextSelection.dataSetIds.length
      }
      if (options.minRunwayDays !== undefined) {
        autoFundOptions.minRunwayDays = options.minRunwayDays
      }
      if (options.maxBalance !== undefined) {
        autoFundOptions.maxBalance = options.maxBalance
      }

      await performAutoFunding(synapse, fileStat.size, spinner, autoFundOptions)
    } else {
      spinner.start('Checking payment capacity...')
      await validatePaymentSetup(synapse, fileStat.size, spinner)
    }

    // Read CAR file and upload to Synapse
    spinner.start('Uploading to Filecoin...')

    const carData = await readFile(options.filePath)

    // Auto-skip IPNI on devnet (no IPNI infrastructure available)
    const skipIpniVerification = options.skipIpniVerification || synapse.chain.id === DEVNET_CHAIN_ID

    const uploadOptions: Parameters<typeof performUpload>[3] = {
      contextType: 'import',
      fileSize: fileStat.size,
      logger,
      spinner,
      skipIpniVerification,
      ...(pieceMetadata && { pieceMetadata }),
      ...(dataSetMetadata && { metadata: dataSetMetadata }),
      ...(options.copies != null && { copies: options.copies }),
    }
    if (contextSelection.providerIds) {
      uploadOptions.providerIds = contextSelection.providerIds
      uploadOptions.copies = contextSelection.providerIds.length
    }
    if (contextSelection.dataSetIds) {
      uploadOptions.dataSetIds = contextSelection.dataSetIds
      uploadOptions.copies = contextSelection.dataSetIds.length
    }

    const requestedCopies = uploadOptions.copies ?? 2
    const uploadResult = await performUpload(synapse, carData, rootCid, uploadOptions)

    // Display results
    spinner.stop('━━━ Import Complete ━━━')

    const result: ImportResult = {
      filePath: options.filePath,
      fileSize: fileStat.size,
      rootCid: rootCidString,
      pieceCid: uploadResult.pieceCid,
      size: uploadResult.size,
      copies: uploadResult.copies,
      failedAttempts: uploadResult.failedAttempts,
    }

    displayUploadResults(result, 'Import', network, networkSlug)

    if (uploadResult.copies.length < requestedCopies) {
      log.line('')
      log.line(
        pc.yellow(
          `${uploadResult.failedAttempts.length} copy failure(s). ` +
            `Got ${uploadResult.copies.length}/${requestedCopies} copies. Data is stored but with reduced redundancy.`
        )
      )
      log.flush()
      outro('Import completed with errors')
      process.exitCode = 1
    } else if (uploadResult.failedAttempts.length > 0) {
      log.line('')
      log.line(pc.gray(`${uploadResult.failedAttempts.length} non-critical copy failure(s) during upload.`))
      log.flush()
      outro('Import completed successfully')
    } else {
      outro('Import completed successfully')
    }

    return result
  } catch (error) {
    spinner.stop(`${pc.red('✗')} Import failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    logger.error({ event: 'import.failed', error }, 'Import failed')

    cancel('Import failed')
    throw error
  }
}
