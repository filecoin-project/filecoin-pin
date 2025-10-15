/**
 * Shared base class for CAR blockstore implementations.
 * Contains all platform-agnostic blockstore logic.
 */

import type { Blockstore, InputPair, Pair } from 'interface-blockstore'
import type { AbortOptions, AwaitIterable } from 'interface-store'
import toBuffer from 'it-to-buffer'
import { CID } from 'multiformats/cid'
import varint from 'varint'
import type { BlockOffset, CARStorageBackend } from './car-storage-backend.js'

/**
 * Statistics about CAR blockstore operations
 */
export interface CARBlockstoreStats {
  blocksWritten: number
  missingBlocks: Set<string>
  totalSize: number
  startTime: number
  finalized: boolean
}

/**
 * Optional event emitter for blockstore events
 */
export interface BlockstoreEvents {
  emit(event: string, ...args: any[]): void
}

/**
 * Base CAR blockstore with pluggable storage backend
 */
export abstract class CARBlockstoreBase implements Blockstore {
  protected readonly rootCID: CID
  protected readonly backend: CARStorageBackend
  protected readonly blockOffsets = new Map<string, BlockOffset>()
  protected readonly stats: CARBlockstoreStats
  protected readonly events: BlockstoreEvents | undefined
  protected currentOffset = 0
  protected finalized = false
  protected initialized = false

  constructor(rootCID: CID, backend: CARStorageBackend, events?: BlockstoreEvents) {
    this.rootCID = rootCID
    this.backend = backend
    this.events = events
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

    const { headerSize } = await this.backend.initialize(this.rootCID)
    this.currentOffset = headerSize
    this.initialized = true
  }

  async put(cid: CID, block: Uint8Array, _options?: AbortOptions): Promise<CID> {
    if (this.finalized) {
      throw new Error('Cannot put blocks in finalized CAR blockstore')
    }

    if (!this.initialized) {
      await this.initialize()
    }

    // Skip if already stored (deduplication)
    const cidStr = cid.toString()
    if (this.blockOffsets.has(cidStr)) {
      return cid
    }

    // Calculate the varint that will be written
    const totalSectionLength = cid.bytes.length + block.length
    const varintBytes = varint.encode(totalSectionLength)
    const varintLength = varintBytes.length

    const currentOffset = this.currentOffset

    // Block data starts after the varint and CID
    const blockStart = currentOffset + varintLength + cid.bytes.length

    // Store the offset information BEFORE writing
    const offset: BlockOffset = {
      blockStart,
      blockLength: block.length,
    }
    this.blockOffsets.set(cidStr, offset)

    // Update offset for next block
    this.currentOffset = blockStart + block.length

    // Write block to storage backend
    await this.backend.writeBlock(cid, block, offset)

    // Update statistics
    this.stats.blocksWritten++
    this.stats.totalSize += block.length

    return cid
  }

  async *get(cid: CID, options?: AbortOptions): AsyncGenerator<Uint8Array> {
    const cidStr = cid.toString()
    const offset = this.blockOffsets.get(cidStr)

    if (offset == null) {
      this.stats.missingBlocks.add(cidStr)
      this.events?.emit('block:missing', { cid })
      const error: Error & { code?: string } = new Error(`Block not found: ${cidStr}`)
      error.code = 'ERR_NOT_FOUND'
      throw error
    }

    if (this.backend.readBlock == null) {
      throw new Error('Read operation not supported by this blockstore')
    }

    // Check abort signal before starting
    options?.signal?.throwIfAborted()

    // Stream chunks directly from backend
    for await (const chunk of this.backend.readBlock(cid, offset)) {
      options?.signal?.throwIfAborted()
      yield chunk
    }
  }

  async has(cid: CID, _options?: AbortOptions): Promise<boolean> {
    const cidStr = cid.toString()
    return this.blockOffsets.has(cidStr)
  }

  async delete(_cid: CID, _options?: AbortOptions): Promise<void> {
    throw new Error('Delete operation not supported on CAR writing blockstore')
  }

  async *putMany(source: AwaitIterable<InputPair>, _options?: AbortOptions): AsyncGenerator<CID> {
    for await (const { cid, bytes } of source) {
      const block = bytes instanceof Uint8Array ? bytes : await toBuffer(bytes)
      yield await this.put(cid, block)
    }
  }

  async *getMany(source: AwaitIterable<CID>, options?: AbortOptions): AsyncGenerator<Pair> {
    for await (const cid of source) {
      options?.signal?.throwIfAborted()
      const bytes = this.get(cid, options)
      yield { cid, bytes }
    }
  }

  // biome-ignore lint/correctness/useYield: This method throws immediately and intentionally never yields
  async *deleteMany(_source: AwaitIterable<CID>, _options?: AbortOptions): AsyncGenerator<CID> {
    throw new Error('DeleteMany operation not supported on CAR writing blockstore')
  }

  async *getAll(options?: AbortOptions): AsyncGenerator<Pair> {
    for (const [cidStr] of this.blockOffsets.entries()) {
      options?.signal?.throwIfAborted()
      const cid = CID.parse(cidStr)
      const bytes = this.get(cid, options)
      yield { cid, bytes }
    }
  }

  async finalize(): Promise<CARBlockstoreStats> {
    if (this.finalized) {
      return this.stats
    }

    // Backend finalize will throw appropriate error if needed
    await this.backend.finalize()

    this.finalized = true
    this.stats.finalized = true

    return this.stats
  }

  getStats(): CARBlockstoreStats {
    return {
      ...this.stats,
      missingBlocks: new Set(this.stats.missingBlocks), // Return a copy
    }
  }

  async cleanup(): Promise<void> {
    try {
      this.finalized = true
      await this.backend.cleanup()
    } catch {
      // Ignore cleanup errors
    }
  }
}
