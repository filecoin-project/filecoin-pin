/**
 * Storage backend interface for CAR blockstore implementations.
 * Allows platform-specific storage strategies (memory, filesystem, etc.)
 */

import type { CID } from 'multiformats/cid'

/**
 * Offset information for a stored block
 */
export interface BlockOffset {
  blockStart: number // Where the actual block data starts (after varint + CID)
  blockLength: number // Length of just the block data
}

/**
 * Result of backend initialization
 */
export interface InitializeResult {
  headerSize: number // Size of the CAR header in bytes
}

/**
 * Storage backend interface that handles platform-specific operations
 */
export interface CARStorageBackend {
  /**
   * Initialize the storage backend with a root CID
   */
  initialize(rootCID: CID): Promise<InitializeResult>

  /**
   * Write a block to storage at the calculated offset
   */
  writeBlock(cid: CID, block: Uint8Array, offset: BlockOffset): Promise<void>

  /**
   * Read a block from storage (optional - may throw if not supported)
   */
  readBlock?(cid: CID, offset: BlockOffset): AsyncGenerator<Uint8Array>

  /**
   * Finalize the storage (close streams, flush buffers, etc.)
   */
  finalize(): Promise<void>

  /**
   * Clean up resources (called on errors)
   */
  cleanup(): Promise<void>
}
