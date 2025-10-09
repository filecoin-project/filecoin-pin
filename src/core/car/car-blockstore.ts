import { EventEmitter } from 'node:events'
import { createWriteStream, type WriteStream } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { mkdir, open, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { CarWriter } from '@ipld/car'
import type { Blockstore } from 'interface-blockstore'
import type { AbortOptions, AwaitIterable } from 'interface-store'
import { CID } from 'multiformats/cid'
import type { Logger } from 'pino'
import varint from 'varint'

export interface CARBlockstoreStats {
  blocksWritten: number
  missingBlocks: Set<string>
  totalSize: number
  startTime: number
  finalized: boolean
}

export interface CARBlockstoreOptions {
  rootCID: CID
  outputPath: string
  logger?: Logger
}

/**
 * A blockstore that writes blocks directly to a CAR file as they arrive.
 * This eliminates the need for redundant storage during IPFS pinning operations.
 */
interface BlockOffset {
  blockStart: number // Where the actual block data starts (after varint + CID)
  blockLength: number // Length of just the block data
}

export class CARWritingBlockstore extends EventEmitter implements Blockstore {
  private readonly rootCID: CID
  private readonly outputPath: string
  private readonly blockOffsets = new Map<string, BlockOffset>()
  private readonly stats: CARBlockstoreStats
  private readonly logger: Logger | undefined
  private carWriter: any = null
  private writeStream: WriteStream | null = null
  private currentOffset = 0
  private finalized = false
  private pipelinePromise: Promise<void> | null = null

  constructor(options: CARBlockstoreOptions) {
    super()
    this.rootCID = options.rootCID
    this.outputPath = options.outputPath
    this.logger = options.logger
    this.stats = {
      blocksWritten: 0,
      missingBlocks: new Set(),
      totalSize: 0,
      startTime: Date.now(),
      finalized: false,
    }
  }

  async initialize(): Promise<void> {
    // Ensure output directory exists
    await mkdir(dirname(this.outputPath), { recursive: true })

    // Create CAR writer channel
    const { writer, out } = CarWriter.create([this.rootCID])
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

    // Mark header as written and set initial offset
    headerWritten = true
    this.currentOffset = headerSize

    // Force the write stream to flush to ensure file is created on disk
    // This is especially important on Windows and macOS where file creation
    // can be delayed. Windows in particular has different filesystem timing.
    if (this.writeStream != null) {
      await new Promise<void>((resolve, reject) => {
        // Check if stream is already open
        if ((this.writeStream as any).fd != null) {
          resolve()
          return
        }

        // Wait for 'open' event
        this.writeStream?.once('open', () => resolve())
        this.writeStream?.once('error', reject)

        // Set a timeout in case the event doesn't fire
        setTimeout(() => resolve(), 50)
      })
    }

    // Additional wait for filesystem to sync (critical for Windows/macOS)
    await new Promise((resolve) => setTimeout(resolve, 20))

    // Verify file was created
    try {
      await stat(this.outputPath)
    } catch {
      throw new Error(`Failed to create CAR file at ${this.outputPath}`)
    }

    this.emit('initialized', { rootCID: this.rootCID, outputPath: this.outputPath })
  }

  async put(cid: CID, block: Uint8Array, _options?: AbortOptions): Promise<CID> {
    const cidStr = cid.toString()
    this.logger?.debug({ cid: cidStr, blockSize: block.length }, 'CARWritingBlockstore.put() called')

    if (this.finalized) {
      throw new Error('Cannot put blocks in finalized CAR blockstore')
    }

    if (this.carWriter == null) {
      await this.initialize()
    }

    // Calculate the varint that will be written
    const totalSectionLength = cid.bytes.length + block.length
    const varintBytes = varint.encode(totalSectionLength)
    const varintLength = varintBytes.length

    const currentOffset = this.currentOffset

    // Block data starts after the varint and CID
    const blockStart = currentOffset + varintLength + cid.bytes.length

    // Store the offset information BEFORE writing
    this.blockOffsets.set(cidStr, {
      blockStart,
      blockLength: block.length,
    })

    // Update offset for next block
    this.currentOffset = blockStart + block.length

    // Write block to CAR file
    await this.carWriter?.put({ cid, bytes: block })

    this.logger?.debug(
      {
        cid: cidStr,
        currentOffset,
        varintLength,
        cidLength: cid.bytes.length,
        blockStart,
        blockLength: block.length,
      },
      'Block offset calculated'
    )

    // Update statistics
    this.stats.blocksWritten++
    this.stats.totalSize += block.length

    // Emit event for tracking
    this.emit('block:stored', { cid, size: block.length })

    this.logger?.info(
      { cid: cidStr, blocksWritten: this.stats.blocksWritten, totalSize: this.stats.totalSize },
      'Block written to CAR file'
    )

    return cid
  }

  async get(cid: CID, _options?: AbortOptions): Promise<Uint8Array> {
    const cidStr = cid.toString()
    this.logger?.debug({ cid: cidStr }, 'CARWritingBlockstore.get() called')

    const offset = this.blockOffsets.get(cidStr)
    if (offset == null) {
      // Track missing blocks for statistics
      this.stats.missingBlocks.add(cidStr)
      this.emit('block:missing', { cid })
      // Important: Throw a specific error that Bitswap/Helia expects
      const error: Error & { code?: string } = new Error(`Block not found: ${cidStr}`)
      error.code = 'ERR_NOT_FOUND'
      throw error
    }

    // Open the file in read-only mode
    // This will throw ENOENT if file doesn't exist yet
    let fd: FileHandle
    try {
      fd = await open(this.outputPath, 'r')
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // File doesn't exist yet - this can happen in tests
        // Treat it as block not found
        const notFoundError: Error & { code?: string } = new Error(`CAR file not yet created: ${this.outputPath}`)
        notFoundError.code = 'ERR_NOT_FOUND'
        throw notFoundError
      }
      throw error
    }
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

      return new Uint8Array(buffer)
    } finally {
      // Always close the file descriptor
      await fd.close()
    }
  }

  async has(cid: CID, _options?: AbortOptions): Promise<boolean> {
    const cidStr = cid.toString()
    const hasBlock = this.blockOffsets.has(cidStr)
    this.logger?.debug({ cid: cidStr, hasBlock }, 'CARWritingBlockstore.has() called')
    return hasBlock
  }

  async delete(_cid: CID, _options?: AbortOptions): Promise<void> {
    throw new Error('Delete operation not supported on CAR writing blockstore')
  }

  async *putMany(source: AwaitIterable<{ cid: CID; block: Uint8Array }>, _options?: AbortOptions): AsyncIterable<CID> {
    for await (const { cid, block } of source) {
      yield await this.put(cid, block)
    }
  }

  async *getMany(source: AwaitIterable<CID>, _options?: AbortOptions): AsyncIterable<{ cid: CID; block: Uint8Array }> {
    for await (const cid of source) {
      const block = await this.get(cid)
      yield { cid, block }
    }
  }

  // biome-ignore lint/correctness/useYield: This method throws immediately and intentionally never yields
  async *deleteMany(_source: AwaitIterable<CID>, _options?: AbortOptions): AsyncIterable<CID> {
    throw new Error('DeleteMany operation not supported on CAR writing blockstore')
  }

  async *getAll(_options?: AbortOptions): AsyncIterable<{ cid: CID; block: Uint8Array }> {
    for (const [cidStr] of this.blockOffsets.entries()) {
      const cid = CID.parse(cidStr)
      const block = await this.get(cid)
      yield { cid, block }
    }
  }

  /**
   * Finalize the CAR file and return statistics
   */
  async finalize(): Promise<CARBlockstoreStats> {
    if (this.finalized) {
      return this.stats
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
    this.stats.finalized = true

    this.emit('finalized', this.stats)

    return this.stats
  }

  /**
   * Get current statistics
   */
  getStats(): CARBlockstoreStats {
    return {
      ...this.stats,
      missingBlocks: new Set(this.stats.missingBlocks), // Return a copy
    }
  }

  /**
   * Clean up resources (called on errors)
   */
  async cleanup(): Promise<void> {
    try {
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
    } catch (_error) {
      // Ignore cleanup errors
    }

    this.emit('cleanup')
  }
}
