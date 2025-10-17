/**
 * Browser-compatible CAR Blockstore
 * Writes blocks to an in-memory CAR structure instead of a file
 */

import { CarWriter } from '@ipld/car'
import type { Blockstore } from 'interface-blockstore'
import type { AbortOptions, AwaitIterable } from 'interface-store'
import toBuffer from 'it-to-buffer'
import type { CID } from 'multiformats/cid'
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
}

/**
 * A blockstore that writes blocks to an in-memory CAR structure
 * This eliminates the need for redundant storage during IPFS operations in the browser
 */
interface BlockOffset {
  blockStart: number // Where the actual block data starts (after varint + CID)
  blockLength: number // Length of just the block data
}

/**
 *
 * @example
 * ```ts
 * import { CARWritingBlockstore } from './browser-car-blockstore.js'
 * import { CID } from 'multiformats/cid'
 * import varint from 'varint'

 * // Create with a placeholder or actual root CID
 * const blockstore = new CARWritingBlockstore({
 *   rootCID: someCID,
 * })

 * await blockstore.initialize()

 * // Add blocks (same as Node.js version)
 * await blockstore.put(cid, blockData)

 * // Finalize when done
 * await blockstore.finalize()

 * // Get the complete CAR file
 * const carBytes = blockstore.getCarBytes() // Uint8Array ready for upload
 * ```
 */
export class CARWritingBlockstore implements Blockstore {
  private readonly rootCID: CID
  private readonly blockOffsets = new Map<string, BlockOffset>()
  private readonly stats: CARBlockstoreStats
  private carWriter: any = null
  private carChunks: Uint8Array[] = []
  private currentOffset = 0
  private finalized = false
  private initialized = false

  constructor(options: CARBlockstoreOptions) {
    this.rootCID = options.rootCID
    this.stats = {
      blocksWritten: 0,
      missingBlocks: new Set(),
      totalSize: 0,
      startTime: Date.now(),
      finalized: false,
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return

    // Create CAR writer channel
    const { writer, out } = CarWriter.create([this.rootCID])
    this.carWriter = writer

    // Collect CAR chunks as they're written
    ;(async () => {
      for await (const chunk of out) {
        this.carChunks.push(chunk)
      }
    })().catch(() => {
      // Ignore errors during collection
    })

    // Track header size by calculating it from the first chunk
    // Wait for the header to be written
    await this.carWriter._mutex

    // Calculate header size from what's been written so far
    const headerSize = this.carChunks.reduce((sum, chunk) => sum + chunk.length, 0)
    this.currentOffset = headerSize

    this.initialized = true
  }

  async put(cid: CID, block: Uint8Array, _options?: AbortOptions): Promise<CID> {
    if (await this.has(cid)) {
      return cid
    }
    const cidStr = cid.toString()

    if (this.finalized) {
      throw new Error('Cannot put blocks in finalized CAR blockstore')
    }

    if (!this.initialized) {
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

    // Write block to CAR
    await this.carWriter?.put({ cid, bytes: block })

    // Update statistics
    this.stats.blocksWritten++
    this.stats.totalSize += block.length

    return cid
  }

  // biome-ignore lint/correctness/useYield: This method throws immediately and intentionally never yields
  async *get(_cid: CID, _options?: AbortOptions): AsyncGenerator<Uint8Array> {
    throw new Error('Not implemented for CAR blockstore in the browser.')
  }

  async has(cid: CID, _options?: AbortOptions): Promise<boolean> {
    const cidStr = cid.toString()
    return this.blockOffsets.has(cidStr)
  }

  async delete(_cid: CID, _options?: AbortOptions): Promise<void> {
    throw new Error('Delete operation not supported on CAR writing blockstore')
  }

  async *putMany(
    source: AwaitIterable<{ cid: CID; bytes: Uint8Array | AwaitIterable<Uint8Array> }>,
    _options?: AbortOptions
  ): AsyncGenerator<CID> {
    for await (const { cid, bytes } of source) {
      const block = bytes instanceof Uint8Array ? bytes : await toBuffer(bytes)
      yield await this.put(cid, block)
    }
  }

  // biome-ignore lint/correctness/useYield: This method throws immediately and intentionally never yields
  async *getMany(
    _source: AwaitIterable<CID>,
    _options?: AbortOptions
  ): AsyncGenerator<{ cid: CID; bytes: AsyncGenerator<Uint8Array> }> {
    throw new Error('Not implemented for CAR blockstore in the browser.')
  }

  // biome-ignore lint/correctness/useYield: This method throws immediately and intentionally never yields
  async *deleteMany(_source: AwaitIterable<CID>, _options?: AbortOptions): AsyncGenerator<CID> {
    throw new Error('DeleteMany operation not supported on CAR writing blockstore')
  }

  // biome-ignore lint/correctness/useYield: This method throws immediately and intentionally never yields
  async *getAll(_options?: AbortOptions): AsyncGenerator<{ cid: CID; bytes: AsyncGenerator<Uint8Array> }> {
    throw new Error('Not implemented for CAR blockstore in the browser.')
  }

  /**
   * Finalize the CAR and return statistics
   */
  async finalize(): Promise<CARBlockstoreStats> {
    if (this.finalized) {
      return this.stats
    }

    if (!this.initialized) {
      throw new Error('Cannot finalize CAR blockstore without initialization')
    }

    // Close the CAR writer to signal no more data
    if (this.carWriter != null) {
      await this.carWriter.close()
      this.carWriter = null
    }

    // Wait a tick for any pending chunks to be collected
    await new Promise((resolve) => setTimeout(resolve, 0))

    this.finalized = true
    this.stats.finalized = true

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
   * Get the complete CAR file as Uint8Array
   * Can only be called after finalize()
   */
  getCarBytes(): Uint8Array {
    if (!this.finalized) {
      throw new Error('Cannot get CAR bytes before finalization')
    }

    // Combine all chunks into a single Uint8Array
    const totalLength = this.carChunks.reduce((sum, chunk) => sum + chunk.length, 0)
    const result = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of this.carChunks) {
      result.set(chunk, offset)
      offset += chunk.length
    }

    return result
  }

  /**
   * Clean up resources (called on errors)
   */
  async cleanup(): Promise<void> {
    try {
      this.finalized = true

      if (this.carWriter != null) {
        await this.carWriter.close()
      }

      // Clear chunks to free memory
      this.carChunks.length = 0
    } catch {
      // Ignore cleanup errors
    }
  }
}
