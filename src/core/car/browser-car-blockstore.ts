/**
 * Browser-compatible CAR Blockstore
 * Writes blocks to an in-memory CAR structure instead of a file
 */

import type { CID } from 'multiformats/cid'
import { CARBlockstoreBase, type CARBlockstoreStats } from './car-blockstore-base.js'
import { CARMemoryBackend } from './car-memory-backend.js'

export type { CARBlockstoreStats }

export interface CARBlockstoreOptions {
  rootCID: CID
}

/**
 * A blockstore that writes blocks to an in-memory CAR structure
 * This eliminates the need for redundant storage during IPFS operations in the browser
 *
 * @example
 * ```ts
 * import { CARWritingBlockstore } from './browser-car-blockstore.js'
 * import { CID } from 'multiformats/cid'
 *
 * // Create with a placeholder or actual root CID
 * const blockstore = new CARWritingBlockstore({
 *   rootCID: someCID,
 * })
 *
 * await blockstore.initialize()
 *
 * // Add blocks (same as Node.js version)
 * await blockstore.put(cid, blockData)
 *
 * // Finalize when done
 * await blockstore.finalize()
 *
 * // Get the complete CAR file
 * const carBytes = blockstore.getCarBytes() // Uint8Array ready for upload
 * ```
 */
export class CARWritingBlockstore extends CARBlockstoreBase {
  private readonly memoryBackend: CARMemoryBackend

  constructor(options: CARBlockstoreOptions) {
    const backend = new CARMemoryBackend()
    super(options.rootCID, backend)
    this.memoryBackend = backend
  }

  /**
   * Get the complete CAR file as Uint8Array
   * Can only be called after finalize()
   */
  getCarBytes(): Uint8Array {
    if (!this.finalized) {
      throw new Error('Cannot get CAR bytes before finalization')
    }

    return this.memoryBackend.getCarBytes()
  }
}
