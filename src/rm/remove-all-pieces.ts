/**
 * CLI entrypoint for removing all pieces from a Data Set.
 *
 * Responsibilities:
 * - Validate required CLI arguments (dataSet)
 * - Initialize Synapse with CLI auth/env configuration
 * - Prompt user for confirmation (unless --force is specified)
 * - Wire up progress events to spinner output
 * - Return aggregated results (or throw on failure)
 */
import { confirm, isCancel } from '@clack/prompts'
import pc from 'picocolors'
import pino from 'pino'
import { type RemoveAllPiecesProgressEvents, removeAllPieces } from '../core/piece/index.js'
import { cleanupSynapseService, initializeSynapse } from '../core/synapse/index.js'
import { createStorageContextFromDataSetId } from '../core/synapse/storage-context-helper.js'
import { parseCLIAuth } from '../utils/cli-auth.js'
import { cancel, createSpinner, intro, isInteractive, outro } from '../utils/cli-helpers.js'
import { log } from '../utils/cli-logger.js'
import type { RmAllPiecesOptions, RmAllPiecesResult } from './types.js'

/**
 * Run the remove all pieces process.
 *
 * @param options - CLI options including dataSet id and force flag
 * @returns Aggregated removal results
 *
 * Behavior:
 * - Requires `dataSet`; throws if missing/invalid
 * - Uses CLI auth env/flags via parseCLIAuth
 * - Prompts for confirmation unless --force is specified
 * - Streams progress to spinner and exits with cancel on failure
 * - Always calls cleanupSynapseService to close providers
 */
export async function runRmAllPieces(options: RmAllPiecesOptions): Promise<RmAllPiecesResult> {
  intro(pc.bold('Filecoin Pin Remove All'))

  const spinner = createSpinner()

  // Initialize logger (silent for CLI output)
  const logger = pino({
    level: process.env.LOG_LEVEL || 'silent',
  })

  const { dataSet, force } = options

  // Validate dataSet
  if (!dataSet) {
    spinner.stop(`${pc.red('✗')} DataSet ID is required`)
    cancel('Remove cancelled')
    throw new Error('DataSet ID is required')
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

    // Create storage context to fetch pieces
    spinner.start('Fetching pieces from DataSet...')
    const { storage } = await createStorageContextFromDataSetId(synapse, dataSetId)

    // Get piece count for confirmation
    const { pieces: allPieces } = await import('../core/data-set/get-data-set-pieces.js').then((m) =>
      m.getDataSetPieces(synapse, storage, { logger })
    )
    const { PieceStatus } = await import('../core/data-set/types.js')
    const activePieces = allPieces.filter((p) => p.status === PieceStatus.ACTIVE)
    const pendingRemovalPieces = allPieces.filter((p) => p.status === PieceStatus.PENDING_REMOVAL)
    const pieceCount = activePieces.length
    const pendingRemovalCount = pendingRemovalPieces.length

    if (pendingRemovalCount > 0) {
      spinner.stop(
        `${pc.green('✓')} Found ${pc.bold(String(pieceCount))} active piece(s) in DataSet ${dataSetId} (${pendingRemovalCount} already pending removal)`
      )
    } else {
      spinner.stop(`${pc.green('✓')} Found ${pc.bold(String(pieceCount))} piece(s) in DataSet ${dataSetId}`)
    }

    if (pieceCount === 0) {
      if (pendingRemovalCount > 0) {
        outro(`No active pieces to remove (${pendingRemovalCount} piece(s) already pending removal)`)
      } else {
        outro('No pieces to remove')
      }
      return {
        dataSetId,
        totalPieces: 0,
        removedCount: 0,
        failedCount: 0,
        transactions: [],
      }
    }

    // Confirmation prompt (unless --force is specified)
    if (!force) {
      if (!isInteractive()) {
        spinner.stop(`${pc.red('✗')} Confirmation required. Use --force to skip in interactive mode`)
        cancel('Remove cancelled')
        throw new Error('Confirmation required for destructive operation')
      }

      log.line('')
      log.line(pc.yellow(`⚠ WARNING: This will remove ALL ${pieceCount} piece(s) from DataSet ${dataSetId}`))
      log.line(pc.yellow('  This action cannot be undone.'))
      log.flush()

      const shouldProceed = await confirm({
        message: `Are you sure you want to remove all ${pieceCount} pieces?`,
        initialValue: false,
      })

      if (isCancel(shouldProceed) || !shouldProceed) {
        cancel('Remove cancelled by user')
        throw new Error('Remove cancelled by user')
      }
    }

    // Track removal progress
    let currentPiece = 0
    let totalPieces = pieceCount

    const onProgress = (event: RemoveAllPiecesProgressEvents): void => {
      switch (event.type) {
        case 'remove-all:fetching':
          spinner.message('Fetching pieces...')
          break

        case 'remove-all:fetched':
          totalPieces = event.data.totalPieces
          spinner.message(`Found ${totalPieces} pieces`)
          break

        case 'remove-all:removing':
          currentPiece = event.data.current
          spinner.message(`Removing piece ${currentPiece}/${totalPieces}...`)
          break

        case 'remove-all:removed':
          spinner.message(`${pc.green('✓')} Removed ${event.data.current}/${totalPieces}`)
          break

        case 'remove-all:failed':
          spinner.message(`${pc.red('✗')} Failed ${event.data.current}/${totalPieces}: ${event.data.error}`)
          break

        case 'remove-all:complete':
          // Main flow will handle stopping the spinner
          break
      }
    }

    spinner.start('Removing pieces...')
    const result = await removeAllPieces(storage, {
      synapse,
      logger,
      onProgress,
      waitForConfirmation: options.waitForConfirmation ?? false,
      pieces: activePieces,
    })

    // Ensure spinner is stopped before displaying results
    spinner.stop(
      `${pc.green('✓')} Removal complete: ${result.removedCount}/${result.totalPieces} succeeded, ${result.failedCount} failed`
    )

    // Display results
    log.spinnerSection('Results', [
      pc.gray(`Total Pieces: ${result.totalPieces}`),
      pc.gray(`Removed: ${result.removedCount}`),
      pc.gray(`Failed: ${result.failedCount}`),
      pc.gray(`Network: ${network}`),
    ])

    if (result.failedCount > 0) {
      outro(`Remove completed with ${result.failedCount} failure(s)`)
    } else {
      outro('Remove completed successfully')
    }

    return {
      dataSetId,
      totalPieces: result.totalPieces,
      removedCount: result.removedCount,
      failedCount: result.failedCount,
      transactions: result.transactions,
    }
  } catch (error) {
    spinner.stop(`${pc.red('✗')} Remove failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    logger.error({ event: 'rm-all.failed', error }, 'Remove all failed')

    cancel('Remove failed')
    throw error
  } finally {
    // Always cleanup WebSocket providers
    await cleanupSynapseService()
  }
}
