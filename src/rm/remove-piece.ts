/**
 * CLI entrypoint for removing a piece from a Data Set.
 *
 * Responsibilities:
 * - Validate required CLI arguments (piece CID, dataSet)
 * - Initialize Synapse with CLI auth/env configuration
 * - Wire up progress events to spinner output
 * - Return transaction hash and confirmation status (or throw on failure)
 */
import pc from 'picocolors'
import pino from 'pino'
import { type RemovePieceProgressEvents, removePiece } from '../core/piece/index.js'
import { cleanupSynapseService, initializeSynapse } from '../core/synapse/index.js'
import { createStorageContextFromDataSetId } from '../core/synapse/storage-context-helper.js'
import { parseCLIAuth } from '../utils/cli-auth.js'
import { cancel, createSpinner, intro, outro } from '../utils/cli-helpers.js'
import { log } from '../utils/cli-logger.js'
import type { RmPieceOptions, RmPieceResult } from './types.js'

/**
 * Run the remove piece process.
 *
 * @param options - CLI options including piece CID and dataSet id
 * @returns Transaction hash, confirmation status, and identifiers used
 *
 * Behavior:
 * - Requires both `piece` and `dataSet`; throws if missing/invalid
 * - Uses CLI auth env/flags via parseCLIAuth
 * - Streams progress to spinner and exits with cancel on failure
 * - Always calls cleanupSynapseService to close providers
 */
export async function runRmPiece(options: RmPieceOptions): Promise<RmPieceResult> {
  intro(pc.bold('Filecoin Pin Remove'))

  const spinner = createSpinner()

  // Initialize logger (silent for CLI output)
  const logger = pino({
    level: process.env.LOG_LEVEL || 'silent',
  })

  const { piece: pieceCid, dataSet } = options

  // Validate inputs
  if (!pieceCid || !dataSet) {
    spinner.stop(`${pc.red('✗')} Piece CID and DataSet ID are required`)
    cancel('Remove cancelled')
    throw new Error('Piece CID and DataSet ID are required')
  }

  const dataSetId = Number(dataSet)
  if (!Number.isInteger(dataSetId) || dataSetId <= 0) {
    spinner.stop(`${pc.red('✗')} DataSet ID must be a positive integer`)
    cancel('Remove cancelled')
    throw new Error('DataSet ID must be a positive integer')
  }

  try {
    spinner.start('Initializing Synapse SDK...')

    const authConfig = parseCLIAuth(options)
    const synapse = await initializeSynapse(authConfig, logger)
    const network = synapse.getNetwork()

    spinner.stop(`${pc.green('✓')} Connected to ${pc.bold(network)}`)

    log.spinnerSection('Remove Configuration', [
      pc.gray(`Piece CID: ${pieceCid}`),
      pc.gray(`Data Set ID: ${dataSetId}`),
    ])

    // Track transaction details
    let txHash = ''
    let isConfirmed = false

    // Remove piece with progress tracking
    const onProgress = (event: RemovePieceProgressEvents): void => {
      switch (event.type) {
        case 'remove-piece:submitting':
          spinner.message('Submitting remove transaction...')
          break

        case 'remove-piece:submitted':
          spinner.message(`Transaction submitted: ${event.data.txHash}`)
          txHash = event.data.txHash
          break

        case 'remove-piece:confirming':
          spinner.message('Waiting for transaction confirmation...')
          break

        case 'remove-piece:confirmation-failed':
          spinner.message(`${pc.yellow('⚠')} Confirmation wait timed out: ${event.data.message}`)
          break

        case 'remove-piece:complete':
          isConfirmed = event.data.confirmed
          txHash = event.data.txHash
          // Main flow will handle stopping the spinner
          break
      }
    }

    spinner.start('Creating storage context...')
    const { storage } = await createStorageContextFromDataSetId(synapse, dataSetId)

    spinner.stop(`${pc.green('✓')} Storage context created`)

    spinner.start('Removing piece...')
    txHash = await removePiece(pieceCid, storage, {
      synapse,
      logger,
      onProgress,
      waitForConfirmation: options.waitForConfirmation ?? false,
    })

    // Ensure spinner is stopped before displaying results
    spinner.stop(`${pc.green('✓')} Piece removed${isConfirmed ? ' and confirmed' : ' (confirmation pending)'}`)

    // Display results
    log.spinnerSection('Results', [
      pc.gray(`Transaction Hash: ${txHash}`),
      pc.gray(`Status: ${isConfirmed ? 'Confirmed' : 'Pending confirmation'}`),
      pc.gray(`Network: ${network}`),
    ])

    const result: RmPieceResult = {
      pieceCid,
      dataSetId,
      transactionHash: txHash,
      confirmed: isConfirmed,
    }

    // Clean up WebSocket providers to allow process termination
    await cleanupSynapseService()

    outro('Remove completed successfully')

    return result
  } catch (error) {
    spinner.stop(`${pc.red('✗')} Remove failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    logger.error({ event: 'rm.failed', error }, 'Remove failed')

    cancel('Remove failed')
    throw error
  } finally {
    // Always cleanup WebSocket providers
    await cleanupSynapseService()
  }
}
