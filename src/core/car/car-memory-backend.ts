/**
 * Browser-compatible in-memory storage backend for CAR files.
 * Collects CAR chunks in memory for later retrieval.
 */

import { CarWriter } from '@ipld/car'
import toBuffer from 'it-to-buffer'
import type { CID } from 'multiformats/cid'
import type { BlockOffset, CARStorageBackend, InitializeResult } from './car-storage-backend.js'

/**
 * Memory-based storage backend that collects CAR chunks
 */
export class CARMemoryBackend implements CARStorageBackend {
  private carWriter: any = null
  private carChunks: Uint8Array[] = []

  async initialize(rootCID: CID): Promise<InitializeResult> {
    // Create CAR writer channel
    const { writer, out } = CarWriter.create([rootCID])
    this.carWriter = writer

    // Collect CAR chunks as they're written
    ;(async () => {
      for await (const chunk of out) {
        this.carChunks.push(chunk)
      }
    })().catch(() => {
      // Ignore errors during collection
    })

    // Wait for the header to be written
    await this.carWriter._mutex

    // Calculate header size from what's been written so far
    const headerSize = this.carChunks.reduce((sum, chunk) => sum + chunk.length, 0)

    return { headerSize }
  }

  async writeBlock(cid: CID, block: Uint8Array, _offset: BlockOffset): Promise<void> {
    // Write block to CAR
    await this.carWriter?.put({ cid, bytes: block })
  }

  // biome-ignore lint/correctness/useYield: This method throws immediately and intentionally never yields
  async *readBlock(_cid: CID, _offset: BlockOffset): AsyncGenerator<Uint8Array> {
    throw new Error('Not implemented for CAR blockstore in the browser.')
  }

  async finalize(): Promise<void> {
    // Close the CAR writer to signal no more data
    if (this.carWriter != null) {
      await this.carWriter.close()
      this.carWriter = null
    }

    // Wait a tick for any pending chunks to be collected
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  async cleanup(): Promise<void> {
    if (this.carWriter != null) {
      await this.carWriter.close()
    }

    // Clear chunks to free memory
    this.carChunks.length = 0
  }

  /**
   * Get the complete CAR file as Uint8Array
   * Browser-specific method for retrieving the in-memory CAR
   */
  getCarBytes(): Uint8Array {
    return toBuffer(this.carChunks)
  }
}
