/**
 * Mock implementation of @filoz/synapse-sdk for testing
 *
 * Key testing patterns:
 * 1. Mock the sync SDK creation process (Synapse.create is sync in 0.38+)
 * 2. Simulate storage context callbacks for lifecycle testing
 * 3. Generate realistic piece CIDs and IDs for verification
 * 4. Provide deterministic behavior for unit tests
 */

import { vi } from 'vitest'
import { MockSynapse, mockPDPProvider } from './synapse-mocks.js'

// Mock the Synapse class creation - sync in 0.38+
export const Synapse = {
  create: vi.fn(() => new MockSynapse()),
}

// Re-export chain definitions for tests that reference them
export const calibration = {
  id: 314159,
  name: 'calibration',
  rpcUrls: {
    default: {
      http: ['https://api.calibration.node.glif.io/rpc/v1'],
      webSocket: ['wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1'],
    },
  },
}

export const mainnet = {
  id: 314,
  name: 'mainnet',
  rpcUrls: {
    default: {
      http: ['https://api.node.glif.io/rpc/v1'],
      webSocket: ['wss://wss.node.glif.io/apigw/lotus/rpc/v1'],
    },
  },
}

// Export mock METADATA_KEYS matching SDK's structure
export const METADATA_KEYS = {
  WITH_CDN: 'withCDN',
  WITH_IPFS_INDEXING: 'withIPFSIndexing',
  IPFS_ROOT_CID: 'ipfsRootCid',
  SOURCE: 'source',
}

// Export mock permission type hashes (keccak256 hashes of EIP-712 type strings)
export const CREATE_DATA_SET_TYPEHASH = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
export const ADD_PIECES_TYPEHASH = '0xfedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321'

// Export types for test compatibility
export type SynapseOptions = any
export type UploadCallbacks = any
export type PDPProvider = typeof mockPDPProvider
export type PieceCID = string
export type FailedAttempt = any

export { mockPDPProvider }
