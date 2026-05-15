import { EventEmitter } from 'node:events'
import type { PDPProvider } from '@filoz/synapse-sdk'
import type { SynapseUploadData } from '../../core/upload/index.js'

/**
 * Test utilities for mocking Synapse SDK components
 *
 * This file provides realistic mock implementations for testing Synapse integrations.
 * It simulates the key SDK behaviors including:
 * - Provider discovery and selection
 * - Data set creation and management
 * - Upload lifecycle with proper callback ordering
 * - Network identification
 */

// Mock provider info matching real PDP provider structure
export const mockPDPProvider: PDPProvider = {
  id: 1n,
  serviceProvider: '0x78bF4d833fC2ba1Abd42Bc772edbC788EC76A28F',
  payee: '0x78bF4d833fC2ba1Abd42Bc772edbC788EC76A28F',
  name: 'Mock Provider',
  description: 'Mock provider for testing',
  isActive: true,
  pdp: {
    serviceURL: 'http://localhost:8888/pdp',
    minPieceSizeInBytes: 127n,
    maxPieceSizeInBytes: 34359738368n,
    storagePricePerTibPerDay: 5000000000000000000n,
    minProvingPeriodInEpochs: 240n,
    location: 'Test Location',
    paymentTokenAddress: '0x0000000000000000000000000000000000000000',
    ipniPiece: false,
    ipniIpfs: false,
  },
}

/**
 * Mock storage context that simulates SDK's storage operations
 *
 * In production, StorageContext manages:
 * - Communication with PDP servers
 * - On-chain data set operations
 * - Upload lifecycle and retries
 * - Provider health monitoring
 */
export class MockStorageContext extends EventEmitter {
  public readonly dataSetId = 123n
  public readonly provider = mockPDPProvider
  public readonly serviceProvider = mockPDPProvider.serviceProvider

  async upload(_data: SynapseUploadData, options?: any): Promise<any> {
    // Check if already aborted
    options?.signal?.throwIfAborted()

    // Simulate network delay for realistic testing
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Check if aborted during delay
    options?.signal?.throwIfAborted()

    // Generate mock CommP (piece commitment) with correct prefix
    const pieceCid = `bafkzcib${Math.random().toString(36).substring(2, 15)}`
    const pieceId = BigInt(Math.floor(Math.random() * 1000))
    const providerId = mockPDPProvider.id

    // Simulate callback sequence matching real SDK behavior.
    // StorageManagerUploadOptions nests callbacks under `callbacks`.
    const callbacks = options?.callbacks
    if (callbacks?.onProgress != null) {
      callbacks.onProgress(getUploadSize(_data))
    }
    if (callbacks?.onStored != null) {
      callbacks.onStored(providerId, pieceCid)
    }
    if (callbacks?.onPiecesAdded != null) {
      callbacks.onPiecesAdded('0x1234', providerId, [{ pieceCid }])
    }
    if (callbacks?.onPiecesConfirmed != null) {
      callbacks.onPiecesConfirmed(123n, providerId, [{ pieceId, pieceCid }])
    }

    return {
      pieceCid,
      size: 1024,
      requestedCopies: 1,
      complete: true,
      copies: [
        {
          providerId,
          dataSetId: 123n,
          pieceId,
          role: 'primary' as const,
          retrievalUrl: `http://localhost:8888/pdp/piece/${pieceCid}`,
          isNewDataSet: false,
        },
      ],
      failedAttempts: [],
    }
  }
}

function getUploadSize(data: SynapseUploadData): number {
  if (data instanceof Uint8Array) {
    return data.byteLength
  }

  return 1024
}

/**
 * Mock Synapse instance simulating the main SDK class
 *
 * Real Synapse manages:
 * - Wallet and transaction signing
 * - Network configuration and RPC communication
 * - Contract interactions
 * - Storage context factory
 */
export class MockSynapse extends EventEmitter {
  private _storageContext: MockStorageContext | null = null

  // Chain info matches SDK structure
  public readonly chain = {
    id: 314159,
    name: 'calibration',
  }

  // Client info
  public readonly client = {
    account: {
      address: '0x1234567890123456789012345678901234567890' as const,
    },
  }

  // Providers namespace
  public readonly providers = {
    getProvider: async (_opts: { providerId: bigint }) => mockPDPProvider,
    getAllActiveProviders: async () => [mockPDPProvider],
  }

  // Storage namespace matches SDK structure
  public readonly storage = {
    source: null as string | null,
    createContext: this.createStorageContext.bind(this),
    upload: async (data: any, options: any) => {
      if (this._storageContext == null) {
        this._storageContext = new MockStorageContext()
      }
      return this._storageContext.upload(data, options)
    },
    getStorageInfo: async () => ({
      pricing: {
        noCDN: {
          perTiBPerEpoch: 1000000000000000n,
          perTiBPerMonth: 86400000000000000000n,
        },
      },
    }),
  }

  /**
   * Create a storage context
   */
  async createStorageContext(_options?: any): Promise<MockStorageContext> {
    this._storageContext = new MockStorageContext()
    return this._storageContext
  }
}
