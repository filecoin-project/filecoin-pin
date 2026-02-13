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
    // Extract callbacks and metadata from options (support both top-level and options.callbacks)
    const callbacks = options?.onUploadComplete ? options : options?.callbacks
    // Generate mock piece CID with correct CommP prefix (bafkzcib)
    const pieceCidString = `bafkzcib${Math.random().toString(36).substring(2, 15)}`
    const pieceId = Math.floor(Math.random() * 1000)

    // Mock PieceCID object matching SDK's CID structure
    const pieceCid = {
      toString: () => pieceCidString,
    }

    // Simulate callback lifecycle in correct order
    const mockTxHash = Math.random() > 0.5 ? (`0x${Math.random().toString(16).substring(2)}` as const) : undefined
    const dataSetId = (options?.context as { dataSetId?: number })?.dataSetId ?? this.dataSetId
    const pieces = [{ pieceId: BigInt(pieceId), pieceCid }]

    // Upload to PDP server completes
    if (callbacks?.onUploadComplete != null) {
      callbacks.onUploadComplete(pieceCid)
    }

    // Piece addition
    if (callbacks?.onPiecesAdded != null) {
      callbacks.onPiecesAdded(mockTxHash, pieces)
    }
    if (callbacks?.onPieceAdded != null) {
      callbacks.onPieceAdded(mockTxHash)
    }

    // On-chain confirmation
    if (callbacks?.onPiecesConfirmed != null) {
      callbacks.onPiecesConfirmed(BigInt(dataSetId), pieces)
    }
    if (callbacks?.onPieceConfirmed != null) {
      callbacks.onPieceConfirmed([pieceId])
    }

    return { pieceCid, pieceId, size: 1024 }
  }

  async getScheduledRemovals(): Promise<bigint[]> {
    return []
  }
}

// Export mock RPC URLs matching SDK's structure
// Real SDK provides URLs for mainnet and calibration networks
export const RPC_URLS = {
  calibration: {
    websocket: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1',
  },
  mainnet: {
    websocket: 'wss://wss.node.glif.io/apigw/lotus/rpc/v1',
  },
}

// Export mock METADATA_KEYS matching SDK's structure
export const METADATA_KEYS = {
  WITH_IPFS_INDEXING: 'withIPFSIndexing',
  IPFS_ROOT_CID: 'ipfsRootCid',
}

/**
 * Mock PDPVerifier for testing scheduled removals
 */
export class PDPVerifier {
  async getScheduledRemovals(_dataSetId: number): Promise<number[]> {
    return []
  }
}

/**
 * Mock PDPServer for testing piece data from provider
 */
export class PDPServer {
  async getDataSet(_dataSetId: number): Promise<{ pieces: any[] }> {
    return { pieces: [] }
  }
}

// Mock DataSetPieceData type
export type DataSetPieceData = {
  pieceId: number
  pieceCid: string
}

// Export mock permission type hashes (keccak256 hashes of EIP-712 type strings)
// These match the actual values from the SDK
export const CREATE_DATA_SET_TYPEHASH = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
export const ADD_PIECES_TYPEHASH = '0xfedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321'

// Export types for test compatibility
// In real code, import these from '@filoz/synapse-sdk'
export type SynapseOptions = any
export type UploadCallbacks = any
export type ProviderInfo = typeof mockProviderInfo

// Export mock calibration object
export const calibration = { chainId: 314159n, name: 'calibration' as const }

// Export mock parseUnits (viem-style; re-exported by SDK)
export function parseUnits(value: string, decimals: number): bigint {
  const [db, da] = value.split('.')
  const intPart = db ?? '0'
  const fracPart = da?.padEnd(decimals, '0') ?? '0'.padStart(decimals, '0')
  return BigInt(intPart) * 10n ** BigInt(decimals) + BigInt(fracPart)
}

// Export mock formatUnits for payments/formatting
export function formatUnits(value: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals)
  const int = value / divisor
  const frac = value % divisor
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '') || '0'
  return fracStr ? `${int}.${fracStr}` : String(int)
}

// SDK constants used by payments and tests
export const SIZE_CONSTANTS = {
  MIN_UPLOAD_SIZE: 127,
}
export const TIME_CONSTANTS = {
  EPOCHS_PER_DAY: 2880n,
  EPOCHS_PER_MONTH: 86400n,
}
export const TOKENS = {
  USDFC: 'USDFC',
}

// Note: StorageService was the old name, now it's StorageContext
// This alias maintains backward compatibility during migration
export { StorageContext as StorageService }
