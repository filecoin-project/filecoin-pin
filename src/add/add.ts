/**
 * File and directory add functionality
 *
 * This module handles adding files and directories to Filecoin via Synapse SDK.
 * It encodes content as UnixFS, creates CAR files, and uploads to Filecoin.
 */

import { readFile, stat } from 'node:fs/promises'
import { RPC_URLS } from '@filoz/synapse-sdk'
import pc from 'picocolors'
import pino from 'pino'
import { displayUploadResults, performUpload, validatePaymentSetup } from '../common/upload-flow.js'
import {
  cleanupSynapseService,
  createStorageContext,
  initializeSynapse,
  type SynapseService,
} from '../synapse/service.js'
import { cancel, createSpinner, formatFileSize, intro, outro } from '../utils/cli-helpers.js'
import type { AddOptions, AddResult } from './types.js'
import { cleanupTempCar, createCarFromPath } from './unixfs-car.js'

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
        return { exists: false, error: `--bare flag is not supported for directories` }
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
    return { exists: false, error: `Cannot access path: ${path} (${error?.message || 'unknown error'})` }
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

  // Initialize logger (silent for CLI output)
  const logger = pino({
    level: process.env.LOG_LEVEL || 'error',
  })

  let tempCarPath: string | undefined

  try {
    // Validate path exists and is readable
    spinner.start('Validating path...')

    const pathValidation = await validatePath(options.filePath, options)
    if (!pathValidation.exists || !pathValidation.stats) {
      spinner.stop(`${pc.red('✗')} ${pathValidation.error}`)
      cancel('Add cancelled')
      process.exit(1)
    }

    const pathStat = pathValidation.stats
    const isDirectory = pathValidation.isDirectory || false

    const pathType = isDirectory ? 'Directory' : 'File'
    const sizeDisplay = isDirectory ? '' : ` (${formatFileSize(pathStat.size)})`
    spinner.stop(`${pc.green('✓')} ${pathType} validated${sizeDisplay}`)

    // Initialize Synapse SDK (without storage context)
    spinner.start('Initializing Synapse SDK...')

    if (!options.privateKey) {
      spinner.stop(`${pc.red('✗')} Private key required via --private-key or PRIVATE_KEY env`)
      cancel('Add cancelled')
      process.exit(1)
    }

    const config = {
      privateKey: options.privateKey,
      rpcUrl: options.rpcUrl || RPC_URLS.calibration.websocket,
      // Other config fields not needed for add
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

    // Check payment setup (may configure permissions if needed)
    // Actual CAR size will be checked later
    spinner.start('Checking payment setup...')
    await validatePaymentSetup(synapse, 0, spinner)

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

    // Validate payment capacity for actual file size
    spinner.start('Checking payment capacity...')
    await validatePaymentSetup(synapse, carSize, spinner)

    // Create storage context
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

    // Upload to Synapse
    const uploadResult = await performUpload(synapseService, carData, rootCid, {
      contextType: 'add',
      fileSize: carSize,
      logger,
      spinner,
    })

    // Display results
    spinner.stop('━━━ Add Complete ━━━')

    const result: AddResult = {
      filePath: options.filePath,
      fileSize: carSize,
      ...(isDirectory && { isDirectory }),
      rootCid: rootCid.toString(),
      pieceCid: uploadResult.pieceCid,
      pieceId: uploadResult.pieceId,
      dataSetId: uploadResult.dataSetId,
      transactionHash: uploadResult.transactionHash,
      providerInfo: uploadResult.providerInfo,
    }

    displayUploadResults(result, 'Add', network)

    // Clean up WebSocket providers to allow process termination
    await cleanupSynapseService()

    outro('Add completed successfully')

    return result
  } catch (error) {
    spinner.stop(`${pc.red('✗')} Add failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    logger.error({ event: 'add.failed', error }, 'Add failed')

    // Clean up even on error
    await cleanupSynapseService()

    // Always cleanup temp CAR even on error
    if (tempCarPath) {
      await cleanupTempCar(tempCarPath, logger)
    }

    cancel('Add failed')
    process.exit(1)
  }
}
