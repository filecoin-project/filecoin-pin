/**
 * Mock implementation of @filoz/synapse-sdk for testing
 */

import { vi } from 'vitest'
import { MockSynapse, mockProviderInfo } from './synapse-mocks.js'

// Mock the Synapse class
export const Synapse = {
  create: vi.fn(async () => new MockSynapse()),
}

// Mock storage context class
export class StorageContext {
  dataSetId = 123
  serviceProvider = mockProviderInfo.serviceProvider

  async upload(_data: ArrayBuffer | Uint8Array, callbacks?: any): Promise<any> {
    const pieceCidString = `bafkzcib${Math.random().toString(36).substring(2, 15)}`
    const pieceId = Math.floor(Math.random() * 1000)

    // Mock PieceCID object with toString method
    const pieceCid = {
      toString: () => pieceCidString,
    }

    if (callbacks?.onUploadComplete != null) {
      callbacks.onUploadComplete(pieceCid)
    }
    if (callbacks?.onPieceAdded != null) {
      // Mock transaction object for new servers
      const mockTransaction = Math.random() > 0.5 ? { hash: `0x${Math.random().toString(16).substring(2)}` } : undefined
      callbacks.onPieceAdded(mockTransaction)
    }
    if (callbacks?.onPieceConfirmed != null) {
      // Mock piece IDs for new servers
      callbacks.onPieceConfirmed([pieceId])
    }

    return { pieceCid, pieceId, size: 1024 }
  }
}

// Export mock RPC URLs
export const RPC_URLS = {
  calibration: {
    websocket: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1',
  },
}

// Export types (these will be overridden by the actual types in tests)
export type SynapseOptions = any
export type UploadCallbacks = any
export type ProviderInfo = typeof mockProviderInfo
export { StorageContext as StorageService } // Backward compatibility alias
