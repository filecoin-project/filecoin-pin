/**
 * File and directory add functionality
 *
 * This module handles adding files and directories to Filecoin via Synapse SDK.
 * It encodes content as UnixFS, creates CAR files, and uploads to Filecoin.
 */

import { readFile, stat } from 'node:fs/promises'
import pc from 'picocolors'
import pino from 'pino'
import { warnAboutCDNPricingLimitations } from '../common/cdn-warning.js'
import { DEVNET_CHAIN_ID } from '../common/get-rpc-url.js'
import { displayUploadResults, performAutoFunding, performUpload, validatePaymentSetup } from '../common/upload-flow.js'
import { resolveDataSetIdsByMetadata } from '../core/data-set/index.js'
import { normalizeMetadataConfig } from '../core/metadata/index.js'
import { DEFAULT_COPIES } from '../core/synapse/constants.js'
import { initializeSynapse } from '../core/synapse/index.js'
import { cleanupTempCar, createCarFromPath } from '../core/unixfs/index.js'
import { getNetworkSlug } from '../core/upload/index.js'
import { parseCLIAuth, parseContextSelectionOptions } from '../utils/cli-auth.js'
import { cancel, createSpinner, formatFileSize, intro, outro } from '../utils/cli-helpers.js'
import { log } from '../utils/cli-logger.js'
import type { AddOptions, AddResult } from './types.js'

/**
 * Validate that a path exists and is a regular file or directory
 */
async function validatePath(
  path: string,
  options: AddOptions
): Promise<{
  exists: boolean
  stats?: any
  isDirectory?: boolean
  error?: string
}> {
  try {
    const stats = await stat(path)
    if (stats.isFile()) {
      return { exists: true, stats, isDirectory: false }
    }
    if (stats.isDirectory()) {
      // Check if bare flag is used with directory
      if (options.bare) {
        return {
          exists: false,
          error: `--bare flag is not supported for directories`,
        }
      }
      return { exists: true, stats, isDirectory: true }
    }
    // Not a file or directory (could be symlink, socket, etc.)
    return { exists: false, error: `Not a file or directory: ${path}` }
  } catch (error: any) {
    // Differentiate between not found and other errors
    if (error?.code === 'ENOENT') {
      return { exists: false, error: `Path not found: ${path}` }
    }
    // Other errors like permission denied, etc.
    return {
      exists: false,
      error: `Cannot access path: ${path} (${error?.message || 'unknown error'})`,
    }
  }
}

/**
 * Run the file or directory add process
 *
 * @param options - Add configuration
 */
export async function runAdd(options: AddOptions): Promise<AddResult> {
  intro(pc.bold('Filecoin Pin Add'))

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
      cancel('Add cancelled')
      throw new Error('CDN pricing limitations warning cancelled')
    }
  }

  let tempCarPath: string | undefined

  try {
    // Validate path exists and is readable
    spinner.start('Validating path...')

    const pathValidation = await validatePath(options.filePath, options)
    if (!pathValidation.exists || !pathValidation.stats) {
      spinner.stop(`${pc.red('✗')} ${pathValidation.error}`)
      cancel('Add cancelled')
      throw new Error(pathValidation.error)
    }

    const pathStat = pathValidation.stats
    const isDirectory = pathValidation.isDirectory || false

    const pathType = isDirectory ? 'Directory' : 'File'
    const sizeDisplay = isDirectory ? '' : ` (${formatFileSize(pathStat.size)})`
    spinner.stop(`${pc.green('✓')} ${pathType} validated${sizeDisplay}`)

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

    // Resolve --data-set-metadata to existing dataset IDs via local subset match
    // when the caller has not pinned dataSetIds/providerIds explicitly. Sidesteps
    // synapse-sdk's exact-equality matching so callers can target existing datasets
    // by partial metadata (e.g. source=storacha-migration).
    let effectiveDataSetMetadata = dataSetMetadata
    if (dataSetMetadata != null && contextSelection.dataSetIds == null && contextSelection.providerIds == null) {
      const expectedCopies = options.copies ?? DEFAULT_COPIES
      spinner.start('Resolving data sets from --data-set-metadata...')
      const resolution = await resolveDataSetIdsByMetadata(synapse, dataSetMetadata, { expectedCopies, logger })
      if (resolution.kind === 'matched') {
        contextSelection.dataSetIds = resolution.dataSetIds
        effectiveDataSetMetadata = undefined
        spinner.stop(
          `${pc.green('✓')} Matched existing data sets ${resolution.dataSetIds.join(', ')} via metadata filter`
        )
      } else if (resolution.kind === 'ambiguous') {
        spinner.stop(`${pc.red('✗')} Ambiguous --data-set-metadata filter`)
        throw new Error(
          `--data-set-metadata matched ${resolution.matchedIds.length} data sets (${resolution.matchedIds.join(', ')}) ` +
            `but expected ${resolution.expected} (use --copies <n> or --data-set-ids to pin the target).`
        )
      } else {
        spinner.stop(
          `${pc.gray('•')} No existing data sets matched --data-set-metadata; SDK will create a new data set with the requested metadata`
        )
      }
    }

    // Check payment setup (may configure permissions if needed)
    if (!options.autoFund) {
      spinner.start('Checking payment setup...')
      await validatePaymentSetup(synapse, 0, spinner, {
        suppressSuggestions: true,
      })
    }

    // Create CAR from file or directory
    const packingMsg = isDirectory
      ? 'Packing directory for IPFS...'
      : `Packing file for IPFS${options.bare ? ' (bare mode)' : ''}...`
    spinner.start(packingMsg)

    const { carPath, rootCid } = await createCarFromPath(options.filePath, {
      logger,
      spinner,
      isDirectory,
      ...(options.bare !== undefined && { bare: options.bare }),
    })
    tempCarPath = carPath

    spinner.stop(`${pc.green('✓')} ${isDirectory ? 'Directory' : 'File'} packed with root CID: ${rootCid.toString()}`)

    // Read CAR data
    spinner.start('Loading packed IPFS content ...')
    const carData = await readFile(tempCarPath)
    const carSize = carData.length
    spinner.stop(`${pc.green('✓')} IPFS content loaded (${formatFileSize(carSize)})`)

    if (options.autoFund) {
      await performAutoFunding(synapse, carSize, spinner)
    } else {
      spinner.start('Checking payment capacity...')
      await validatePaymentSetup(synapse, carSize, spinner)
    }

    // Auto-skip IPNI on devnet (no IPNI infrastructure available)
    const skipIpniVerification = options.skipIpniVerification || synapse.chain.id === DEVNET_CHAIN_ID

    const uploadOptions: Parameters<typeof performUpload>[3] = {
      contextType: 'add',
      fileSize: carSize,
      logger,
      spinner,
      skipIpniVerification,
      ...(pieceMetadata && { pieceMetadata }),
      ...(effectiveDataSetMetadata && { metadata: effectiveDataSetMetadata }),
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

    // Upload to Synapse (SDK handles provider selection and multi-copy)
    const requestedCopies = uploadOptions.copies ?? DEFAULT_COPIES
    const uploadResult = await performUpload(synapse, carData, rootCid, uploadOptions)

    // Display results
    spinner.stop('━━━ Add Complete ━━━')

    const result: AddResult = {
      filePath: options.filePath,
      fileSize: carSize,
      ...(isDirectory && { isDirectory }),
      rootCid: rootCid.toString(),
      pieceCid: uploadResult.pieceCid,
      size: uploadResult.size,
      copies: uploadResult.copies,
      failedAttempts: uploadResult.failedAttempts,
    }

    displayUploadResults(result, 'Add', network, networkSlug)

    if (uploadResult.copies.length < requestedCopies) {
      log.line('')
      log.line(
        pc.yellow(
          `${uploadResult.failedAttempts.length} copy failure(s). ` +
            `Got ${uploadResult.copies.length}/${requestedCopies} copies. Data is stored but with reduced redundancy.`
        )
      )
      log.flush()
      outro('Add completed with errors')
      process.exitCode = 1
    } else if (uploadResult.failedAttempts.length > 0) {
      log.line('')
      log.line(pc.gray(`${uploadResult.failedAttempts.length} non-critical copy failure(s) during upload.`))
      log.flush()
      outro('Add completed successfully')
    } else {
      outro('Add completed successfully')
    }

    return result
  } catch (error) {
    spinner.stop(`${pc.red('✗')} Add failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    logger.error({ event: 'add.failed', error }, 'Add failed')

    // Always cleanup temp CAR even on error
    if (tempCarPath) {
      await cleanupTempCar(tempCarPath, logger)
    }

    cancel('Add failed')
    throw error
  }
}
