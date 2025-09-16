import { EventEmitter } from 'node:events'
import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Helia } from 'helia'
import type { CID } from 'multiformats/cid'
import type { Logger } from 'pino'
import type { CARBlockstoreStats, CARWritingBlockstore } from './car-blockstore.js'
import type { Config } from './config.js'
import { createPinningHeliaNode } from './create-pinning-helia.js'
import type { SynapseService } from './synapse-service.js'

export interface PinningServiceUser {
  id: string
  name: string
}

export interface PinOptions {
  name?: string
  origins?: string[]
  meta?: Record<string, string>
}

export interface StoredPinStatus {
  id: string
  status: 'queued' | 'pinning' | 'pinned' | 'failed'
  created: number
  pin: {
    cid: string
    name?: string
    origins?: string[]
    meta?: Record<string, string>
  }
  info?: Record<string, string>
}

export interface FilecoinPinMetadata {
  carFilePath: string
  carStats: CARBlockstoreStats
  pinStarted: number
  pinCompleted?: number
  synapsePieceCid?: string
  synapsePieceId?: number
  synapseDataSetId?: string
}

export interface FilecoinStoredPinStatus extends StoredPinStatus {
  filecoin?: FilecoinPinMetadata
}

export interface FilecoinPinStoreInit {
  config: Config
  logger: Logger
  synapseService: SynapseService
}

/**
 * Filecoin-specific pin store that creates CAR files for each pin operation
 */
export class FilecoinPinStore extends EventEmitter {
  private readonly config: Config
  private readonly logger: Logger
  private readonly synapseService: SynapseService
  private readonly pins = new Map<string, FilecoinStoredPinStatus>()
  private readonly activePins = new Map<
    string,
    {
      helia: Helia
      blockstore: CARWritingBlockstore
      metadata: FilecoinPinMetadata
    }
  >()

  private pinCounter = 0

  constructor(init: FilecoinPinStoreInit) {
    super()
    this.config = init.config
    this.logger = init.logger
    this.synapseService = init.synapseService
  }

  async start(): Promise<void> {
    this.logger.info('Filecoin pin store started')
  }

  async stop(): Promise<void> {
    // Clean up any active pins
    for (const [pinId, { helia, blockstore }] of this.activePins.entries()) {
      try {
        await blockstore.cleanup()
        await helia.stop()
      } catch (error) {
        this.logger.warn({ pinId, error }, 'Error cleaning up active pin during shutdown')
      }
    }
    this.activePins.clear()

    this.logger.info('Filecoin pin store stopped')
  }

  async pin(user: PinningServiceUser, cid: CID, options: PinOptions = {}): Promise<FilecoinStoredPinStatus> {
    const pinId = `pin-${Date.now()}-${++this.pinCounter}`
    const pinStarted = Date.now()

    // Generate CAR file path
    const carFileName = `${cid.toString()}-${pinStarted}.car`
    const carFilePath = join(this.config.carStoragePath, carFileName)

    this.logger.info(
      {
        userId: user.id,
        pinId,
        cid: cid.toString(),
        carFilePath,
        name: options.name,
      },
      'Starting Filecoin pin operation'
    )

    // Create initial pin record
    const pinStatus: FilecoinStoredPinStatus = {
      id: pinId,
      status: 'queued',
      created: pinStarted,
      pin: {
        cid: cid.toString(),
        ...(options.name != null && { name: options.name }),
        ...(options.origins != null && { origins: options.origins }),
        ...(options.meta != null && { meta: options.meta }),
      },
      filecoin: {
        carFilePath,
        carStats: {
          blocksWritten: 0,
          missingBlocks: new Set(),
          totalSize: 0,
          startTime: pinStarted,
          finalized: false,
        },
        pinStarted,
      },
      info: {
        car_file_path: carFilePath,
        blocks_written: '0',
        total_size: '0',
        status: 'initializing',
      },
    }

    // Store the pin
    this.pins.set(pinId, pinStatus)

    // Start the actual pinning process in the background after a small delay
    setTimeout(() => {
      this.logger.debug({ pinId }, 'setTimeout callback executing')
      this._processPinInBackground(pinId, user, cid)
        .then(() => {
          this.logger.debug({ pinId }, 'Background processing completed')
        })
        .catch((error) => {
          this.logger.error(
            {
              pinId,
              userId: user.id,
              cid: cid.toString(),
              error: error instanceof Error ? (error.stack ?? error.message) : String(error),
            },
            'Background pin processing failed'
          )

          // Update pin status to failed
          const failedPin = this.pins.get(pinId)
          if (failedPin != null) {
            failedPin.status = 'failed'
            failedPin.info = {
              ...failedPin.info,
              error: error.message,
              status: 'failed',
            }
            this.pins.set(pinId, failedPin)
          }
        })
    }, 100) // Small delay to ensure pin starts in 'queued' state

    return pinStatus
  }

  private async _processPinInBackground(pinId: string, user: PinningServiceUser, cid: CID): Promise<void> {
    this.logger.debug({ pinId, cid: cid.toString() }, 'Entered _processPinInBackground')
    const pinStatus = this.pins.get(pinId)
    if (pinStatus == null || pinStatus.filecoin == null) {
      this.logger.error({ pinId }, 'Pin not found in _processPinInBackground')
      throw new Error(`Pin ${pinId} not found`)
    }

    try {
      this.logger.info({ pinId, cid: cid.toString() }, 'Starting background pin processing')

      // Update status to pinning
      pinStatus.status = 'pinning'
      if (pinStatus.info != null) {
        pinStatus.info.status = 'pinning'
      }
      this.pins.set(pinId, pinStatus)

      // Create a single Helia node with CAR blockstore for this specific pin
      this.logger.debug({ pinId, cid: cid.toString() }, 'Creating pinning Helia node')
      const { helia, blockstore } = await createPinningHeliaNode({
        config: this.config,
        logger: this.logger,
        rootCID: cid,
        outputPath: pinStatus.filecoin.carFilePath,
        origins: pinStatus.pin.origins ?? [],
      })
      this.logger.debug({ pinId, cid: cid.toString() }, 'Pinning Helia node created')

      // Store active pin info
      this.activePins.set(pinId, {
        helia,
        blockstore,
        metadata: pinStatus.filecoin,
      })

      // Set up event handlers for monitoring
      blockstore.on('block:stored', (data) => {
        this.emit('pin:block:stored', {
          pinId,
          userId: user.id,
          cid: data.cid,
          size: data.size,
        })

        // Update pin status
        const currentPin = this.pins.get(pinId)
        if (currentPin?.filecoin != null) {
          currentPin.filecoin.carStats = blockstore.getStats()
          currentPin.info = {
            ...currentPin.info,
            blocks_written: currentPin.filecoin.carStats.blocksWritten.toString(),
            total_size: currentPin.filecoin.carStats.totalSize.toString(),
          }
          this.pins.set(pinId, currentPin)
        }
      })

      blockstore.on('block:missing', (data) => {
        this.emit('pin:block:missing', {
          pinId,
          userId: user.id,
          cid: data.cid,
        })
      })

      // Fetch and pin the DAG
      this.logger.debug({ pinId, cid: cid.toString() }, 'Starting DAG pinning')

      try {
        // Use Helia's pin system to walk the full DAG
        // This will fetch all blocks recursively via Bitswap
        this.logger.debug({ pinId, cid: cid.toString() }, 'Pinning content via Helia')

        for await (const pinnedCid of helia.pins.add(cid)) {
          this.logger.debug(
            {
              pinId,
              cid: cid.toString(),
              pinnedCid: pinnedCid.toString(),
            },
            'Block pinned during DAG walk'
          )
        }

        this.logger.info({ pinId, cid: cid.toString() }, 'Content fully pinned')
      } catch (error) {
        this.logger.warn(
          {
            pinId,
            cid: cid.toString(),
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to pin content - some blocks may be missing'
        )
        // Don't throw - we'll finalize the CAR with whatever blocks we got
      }

      // Finalize the CAR file
      const finalStats = await blockstore.finalize()

      this.logger.info(
        {
          pinId,
          cid: cid.toString(),
          blocksWritten: finalStats.blocksWritten,
          totalSize: finalStats.totalSize,
          missingBlocks: finalStats.missingBlocks.size,
        },
        'CAR file finalized'
      )

      // Store on Filecoin
      try {
        // Read the CAR file (streaming not yet supported in Synapse)
        const carData = await readFile(pinStatus.filecoin.carFilePath)

        // Upload using Synapse
        const synapseResult = await this.synapseService.storage.upload(carData, {
          onUploadComplete: (pieceCid) => {
            this.logger.info(
              {
                event: 'synapse.upload.piece_uploaded',
                pinId,
                pieceCid: pieceCid.toString(),
              },
              'Upload to PDP server complete'
            )
          },
          onPieceAdded: (transaction) => {
            if (transaction != null) {
              this.logger.info(
                {
                  event: 'synapse.upload.piece_added',
                  pinId,
                  txHash: transaction.hash,
                },
                'Piece addition transaction submitted'
              )
            } else {
              this.logger.info(
                {
                  event: 'synapse.upload.piece_added',
                  pinId,
                },
                'Piece added to data set'
              )
            }
          },
          onPieceConfirmed: (pieceIds) => {
            this.logger.info(
              {
                event: 'synapse.upload.piece_confirmed',
                pinId,
                pieceIds,
              },
              'Piece addition confirmed on-chain'
            )
          },
        })

        // Store Synapse metadata
        pinStatus.filecoin.synapsePieceCid = synapseResult.pieceCid.toString()
        if (synapseResult.pieceId !== undefined) {
          pinStatus.filecoin.synapsePieceId = synapseResult.pieceId
        }
        pinStatus.filecoin.synapseDataSetId = String(this.synapseService.storage.dataSetId)

        // Add to info for API response
        pinStatus.info = {
          ...pinStatus.info,
          synapse_piece_cid: synapseResult.pieceCid.toString(),
          synapse_piece_id: (synapseResult.pieceId ?? 0).toString(),
          synapse_data_set_id: String(this.synapseService.storage.dataSetId),
        }

        this.logger.info(
          {
            event: 'synapse.upload.success',
            pinId,
            pieceCid: synapseResult.pieceCid,
            pieceId: synapseResult.pieceId,
            dataSetId: this.synapseService.storage.dataSetId,
          },
          'Successfully uploaded to Filecoin with Synapse'
        )
      } catch (error) {
        // Rollback on Synapse failure
        this.logger.error(
          {
            event: 'synapse.upload.failed',
            pinId,
            error,
          },
          'Failed to upload to Filecoin with Synapse, rolling back'
        )

        // Clean up the CAR file
        try {
          await blockstore.cleanup()
          await unlink(pinStatus.filecoin.carFilePath)
          this.logger.info(
            { pinId, carFilePath: pinStatus.filecoin.carFilePath },
            'Deleted CAR file after Synapse failure'
          )
        } catch (cleanupError) {
          this.logger.warn({ pinId, error: cleanupError }, 'Failed to clean up CAR file')
        }

        // Re-throw to mark pin as failed
        throw new Error(`Synapse upload failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }

      // Update pin status to completed
      pinStatus.status = 'pinned'
      pinStatus.filecoin.carStats = finalStats
      pinStatus.filecoin.pinCompleted = Date.now()
      pinStatus.info = {
        ...pinStatus.info,
        status: 'pinned',
        blocks_written: finalStats.blocksWritten.toString(),
        total_size: finalStats.totalSize.toString(),
        missing_blocks: finalStats.missingBlocks.size.toString(),
        pin_duration: (pinStatus.filecoin.pinCompleted - pinStatus.filecoin.pinStarted).toString(),
      }
      this.pins.set(pinId, pinStatus)

      // Emit completion event
      this.emit('pin:car:completed', {
        pinId,
        userId: user.id,
        cid,
        stats: finalStats,
        carFilePath: pinStatus.filecoin.carFilePath,
      })

      this.logger.info({ pinId, cid: cid.toString() }, 'Pin processing completed successfully')
    } catch (error) {
      this.logger.error({ pinId, cid: cid.toString(), error }, 'Pin processing failed')

      // Update pin status to failed
      pinStatus.status = 'failed'
      pinStatus.info = {
        ...pinStatus.info,
        status: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      }
      this.pins.set(pinId, pinStatus)

      this.emit('pin:failed', {
        pinId,
        userId: user.id,
        cid,
        error,
      })
    } finally {
      // Clean up active pin
      const activePin = this.activePins.get(pinId)
      if (activePin != null) {
        await activePin.helia.stop()
        this.activePins.delete(pinId)
      }
    }
  }

  async get(_user: PinningServiceUser, id: string): Promise<FilecoinStoredPinStatus | undefined> {
    return this.pins.get(id)
  }

  async update(
    _user: PinningServiceUser,
    id: string,
    options: PinOptions
  ): Promise<FilecoinStoredPinStatus | undefined> {
    const pinStatus = this.pins.get(id)
    if (pinStatus == null) {
      return undefined
    }

    // Update the pin object
    if (options.name !== undefined) {
      pinStatus.pin.name = options.name
    }
    if (options.origins !== undefined) {
      pinStatus.pin.origins = options.origins
    }
    if (options.meta !== undefined) {
      pinStatus.pin.meta = { ...pinStatus.pin.meta, ...options.meta }
    }

    this.pins.set(id, pinStatus)
    return pinStatus
  }

  async cancel(_user: PinningServiceUser, id: string): Promise<void> {
    // Get the pin to find the CAR file path
    const pin = this.pins.get(id)

    // Clean up active pin if it exists
    const activePin = this.activePins.get(id)
    if (activePin != null) {
      try {
        await activePin.blockstore.cleanup()
        await activePin.helia.stop()
      } catch (error) {
        this.logger.warn({ pinId: id, error }, 'Error cleaning up cancelled pin')
      }
      this.activePins.delete(id)
    }

    // Delete the CAR file if it exists
    if (pin?.filecoin?.carFilePath != null) {
      try {
        await unlink(pin.filecoin.carFilePath)
        this.logger.info({ pinId: id, carFilePath: pin.filecoin.carFilePath }, 'Deleted CAR file for cancelled pin')
      } catch (error: any) {
        // Only warn if it's not a "file not found" error
        if (error.code !== 'ENOENT') {
          this.logger.warn({ pinId: id, carFilePath: pin.filecoin.carFilePath, error }, 'Failed to delete CAR file')
        }
      }
    }

    // Remove the pin from memory
    this.pins.delete(id)
  }

  async list(
    _user: PinningServiceUser,
    query?: {
      cid?: string
      name?: string
      status?: string
      limit?: number
    }
  ): Promise<{
    count: number
    results: FilecoinStoredPinStatus[]
  }> {
    let results = Array.from(this.pins.values())

    // Apply filters
    if (query?.cid != null && query.cid.length > 0) {
      results = results.filter((pin) => pin.pin.cid === query.cid)
    }
    if (query?.name != null && query.name.length > 0) {
      const nameFilter = query.name
      results = results.filter((pin) => pin.pin.name?.includes(nameFilter) === true)
    }
    if (query?.status != null) {
      results = results.filter((pin) => pin.status === query.status)
    }

    // Apply limit
    if (query?.limit != null && query.limit > 0) {
      results = results.slice(0, query.limit)
    }

    // Sort by created date (newest first)
    results.sort((a, b) => b.created - a.created)

    return {
      count: results.length,
      results,
    }
  }

  /**
   * Get statistics for all active pins
   */
  getActivePinStats(): Array<{
    pinId: string
    cid: string
    stats: CARBlockstoreStats
    duration: number
  }> {
    return Array.from(this.activePins.entries()).map(([pinId, { metadata }]) => ({
      pinId,
      cid: metadata.carFilePath.split('/').pop()?.split('-')[0] ?? 'unknown',
      stats: metadata.carStats,
      duration: Date.now() - metadata.pinStarted,
    }))
  }
}
