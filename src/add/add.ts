/**
 * File add functionality
 *
 * This module handles adding regular files to Filecoin via Synapse SDK.
 * It encodes files as UnixFS, creates CAR files, and uploads to Filecoin.
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
import { cleanupTempCar, createCarFromFile } from './unixfs-car.js'

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
 * Run the file add process
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
    // Step 1: Validate file exists and is readable
    spinner.start('Validating file...')

    const fileValidation = await validateFilePath(options.filePath)
    if (!fileValidation.exists || !fileValidation.stats) {
      spinner.stop(`${pc.red('✗')} ${fileValidation.error}`)
      cancel('Add cancelled')
      process.exit(1)
    }
    const fileStat = fileValidation.stats

    spinner.stop(`${pc.green('✓')} File validated (${formatFileSize(fileStat.size)})`)

    // Step 2: Initialize Synapse SDK (without storage context)
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

    // Step 3: Validate payment setup
    spinner.start('Validating payment setup...')
    await validatePaymentSetup(synapse, fileStat.size, spinner)

    // Step 4: Create CAR from file
    spinner.start('Preparing file for IPFS ...')
    const { carPath, rootCid } = await createCarFromFile(options.filePath, { logger })
    tempCarPath = carPath
    spinner.stop(`${pc.green('✓')} File packed for IPFS with root CID: ${rootCid.toString()}`)

    // Step 5: Read CAR data
    spinner.start('Loading packed IPFS content ...')
    const carData = await readFile(tempCarPath)
    spinner.stop(`${pc.green('✓')} IPFS content loaded (${formatFileSize(carData.length)})`)

    // Step 6: Create storage context
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

    // Step 7: Upload to Synapse
    const uploadResult = await performUpload(synapseService, carData, rootCid, {
      contextType: 'add',
      fileSize: fileStat.size,
      logger,
      spinner,
    })

    // Step 8: Display results
    spinner.stop('━━━ Add Complete ━━━')

    const result: AddResult = {
      filePath: options.filePath,
      fileSize: fileStat.size,
      rootCid: rootCid.toString(),
      pieceCid: uploadResult.pieceCid,
      pieceId: uploadResult.pieceId,
      dataSetId: uploadResult.dataSetId,
      transactionHash: uploadResult.transactionHash,
      providerInfo: uploadResult.providerInfo,
    }

    // Display the results
    displayUploadResults(result, 'Add', network)

    // Clean up WebSocket providers to allow process termination
    await cleanupSynapseService()

    // Show success outro
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
