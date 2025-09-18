/**
 * Mock implementation of @filoz/synapse-sdk for testing
 *
 * This file demonstrates how to create test mocks for Synapse SDK integration.
 * Key testing patterns:
 * 1. Mock the async SDK creation process
 * 2. Simulate storage context callbacks for lifecycle testing
 * 3. Generate realistic piece CIDs and IDs for verification
 * 4. Provide deterministic behavior for unit tests
 */

import { vi } from 'vitest'
import { MockSynapse, mockProviderInfo } from './synapse-mocks.js'

// Mock the Synapse class creation
// The create method is async in the real SDK, so we maintain that pattern
export const Synapse = {
  create: vi.fn(async () => new MockSynapse()),
}

/**
 * Mock StorageContext that simulates the real SDK's storage interface
 *
 * In production, this manages:
 * - Data set creation and tracking
 * - Provider selection and communication
 * - Upload lifecycle with callbacks
 * - On-chain transaction coordination
 */
export class StorageContext {
  // Simulate a data set ID that would be created on-chain
  dataSetId = 123
  // Mock provider address from our test data
  serviceProvider = mockProviderInfo.serviceProvider

  /**
   * Mock upload method that simulates the full upload lifecycle
   *
   * Real SDK upload process:
   * 1. Upload data to PDP server
   * 2. Server calculates CommP (piece commitment)
   * 3. Piece gets added to data set (on-chain transaction)
   * 4. Transaction confirmation triggers callbacks
   */
  async upload(_data: ArrayBuffer | Uint8Array, options?: any): Promise<any> {
    // Extract callbacks and metadata from options
    const callbacks = options?.onUploadComplete ? options : options?.callbacks
    // Generate mock piece CID with correct CommP prefix (bafkzcib)
    const pieceCidString = `bafkzcib${Math.random().toString(36).substring(2, 15)}`
    const pieceId = Math.floor(Math.random() * 1000)

    // Mock PieceCID object matching SDK's CID structure
    const pieceCid = {
      toString: () => pieceCidString,
    }

    // Simulate callback lifecycle in correct order

    // 1. Upload to PDP server completes
    if (callbacks?.onUploadComplete != null) {
      callbacks.onUploadComplete(pieceCid)
    }

    // 2. Piece addition (may or may not require transaction)
    if (callbacks?.onPieceAdded != null) {
      const mockTransaction = Math.random() > 0.5 ? { hash: `0x${Math.random().toString(16).substring(2)}` } : undefined
      callbacks.onPieceAdded(mockTransaction)
    }

    // 3. On-chain confirmation (only for new pieces)
    if (callbacks?.onPieceConfirmed != null) {
      callbacks.onPieceConfirmed([pieceId])
    }

    return { pieceCid, pieceId, size: 1024 }
  }
}

// Export mock RPC URLs matching SDK's structure
// Real SDK provides URLs for mainnet and calibration networks
export const RPC_URLS = {
  calibration: {
    websocket: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1',
  },
}

// Export mock METADATA_KEYS matching SDK's structure
export const METADATA_KEYS = {
  WITH_IPFS_INDEXING: 'withIPFSIndexing',
  IPFS_ROOT_CID: 'ipfsRootCid',
}

// Export types for test compatibility
// In real code, import these from '@filoz/synapse-sdk'
export type SynapseOptions = any
export type UploadCallbacks = any
export type ProviderInfo = typeof mockProviderInfo

// Note: StorageService was the old name, now it's StorageContext
// This alias maintains backward compatibility during migration
export { StorageContext as StorageService }
