/**
 * Node.js filesystem-based storage backend for CAR files.
 * Streams CAR data directly to disk.
 */

import { EventEmitter } from 'node:events'
import type { WriteStream } from 'node:fs'
import { createWriteStream } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { CarWriter } from '@ipld/car'
import type { CID } from 'multiformats/cid'
import type { Logger } from 'pino'
import type { BlockOffset, CARStorageBackend, InitializeResult } from './car-storage-backend.js'

/**
 * File-based storage backend that streams to disk
 */
export class CARFileBackend extends EventEmitter implements CARStorageBackend {
  private readonly outputPath: string
  private readonly logger: Logger | undefined
  private carWriter: any = null
  private writeStream: WriteStream | null = null
  private pipelinePromise: Promise<void> | null = null
  private finalized = false

  constructor(outputPath: string, logger?: Logger) {
    super()
    this.outputPath = outputPath
    this.logger = logger
  }

  async initialize(rootCID: CID): Promise<InitializeResult> {
    // Ensure output directory exists
    await mkdir(dirname(this.outputPath), { recursive: true })

    // Create CAR writer channel
    const { writer, out } = CarWriter.create([rootCID])
    this.carWriter = writer

    // Create write stream
    this.writeStream = createWriteStream(this.outputPath)

    // Track header size by counting bytes until first block is written
    let headerWritten = false
    let headerSize = 0
    const readable = Readable.from(out)

    const tracker = new Transform({
      transform: (chunk, _encoding, callback) => {
        if (!headerWritten) {
          // The header is written before any blocks
          headerSize += (chunk as Buffer).length
        }
        callback(null, chunk)
      },
    })

    // Store the pipeline promise so we can await it on finalize
    this.pipelinePromise = pipeline(readable, tracker, this.writeStream)

    // Handle pipeline errors but don't let them crash the process
    this.pipelinePromise.catch((error) => {
      // Only emit error if not finalized (expected during cleanup)
      if (!this.finalized && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        this.emit('error', error)
      }
    })

    // Force header to be written by accessing the internal mutex
    // This ensures we can accurately track the header size
    await this.carWriter._mutex

    // Mark header as written
    headerWritten = true

    this.emit('initialized', { rootCID, outputPath: this.outputPath })

    return { headerSize }
  }

  async writeBlock(cid: CID, block: Uint8Array, offset: BlockOffset): Promise<void> {
    const cidStr = cid.toString()
    this.logger?.debug({ cid: cidStr, blockSize: block.length }, 'CARWritingBlockstore.put() called')

    // Write block to CAR file
    await this.carWriter?.put({ cid, bytes: block })

    // Wait for the write to be queued/processed by the CAR writer
    // This ensures data is in the pipeline before we return
    await this.carWriter?._mutex

    const varintLength = offset.blockStart - offset.blockLength - cid.bytes.length

    this.logger?.debug(
      {
        cid: cidStr,
        varintLength,
        cidLength: cid.bytes.length,
        blockStart: offset.blockStart,
        blockLength: offset.blockLength,
      },
      'Block offset calculated'
    )

    // Emit event for tracking
    this.emit('block:stored', { cid, size: block.length })

    this.logger?.info({ cid: cidStr }, 'Block written to CAR file')
  }

  async *readBlock(cid: CID, offset: BlockOffset): AsyncGenerator<Uint8Array> {
    const cidStr = cid.toString()
    this.logger?.debug({ cid: cidStr }, 'CARWritingBlockstore.get() called')

    // Open the file in read-only mode
    const fd = await open(this.outputPath, 'r')
    try {
      // Allocate buffer for the block data
      const buffer = Buffer.alloc(offset.blockLength)

      // Read the block from the file at the stored offset
      const { bytesRead } = await fd.read(buffer, 0, offset.blockLength, offset.blockStart)

      if (bytesRead !== offset.blockLength) {
        throw new Error(
          `Failed to read complete block for ${cidStr}: expected ${offset.blockLength} bytes, got ${bytesRead}`
        )
      }

      yield new Uint8Array(buffer)
    } finally {
      // Always close the file descriptor
      await fd.close()
    }
  }

  async finalize(): Promise<void> {
    if (this.finalized) {
      return
    }

    // Throw error if no blocks were written
    if (this.carWriter == null) {
      throw new Error('Cannot finalize CAR blockstore without any blocks written')
    }

    // First close the CAR writer to signal no more data
    if (this.carWriter != null) {
      await this.carWriter.close()
      this.carWriter = null
    }

    // Wait for the pipeline to complete if it exists
    if (this.pipelinePromise != null) {
      try {
        await this.pipelinePromise
      } catch (error: any) {
        // Ignore premature close errors during finalization
        if (error.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
          throw error
        }
      }
    }

    // Clean up the write stream
    if (this.writeStream != null) {
      this.writeStream = null
    }

    this.finalized = true

    this.emit('finalized')
  }

  async cleanup(): Promise<void> {
    // Mark as finalized to prevent further writes
    this.finalized = true

    if (this.carWriter != null) {
      await this.carWriter.close()
    }

    // Wait for pipeline to complete if it exists
    if (this.pipelinePromise != null) {
      try {
        await this.pipelinePromise
      } catch {
        // Ignore pipeline errors during cleanup
      }
    }

    if (this.writeStream != null && !this.writeStream.destroyed) {
      this.writeStream.destroy()
    }

    this.emit('cleanup')
  }
}
