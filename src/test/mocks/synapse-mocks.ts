import { EventEmitter } from 'node:events'
import type { ProviderInfo } from '@filoz/synapse-sdk'

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
export const mockProviderInfo: ProviderInfo = {
  id: 1,
  serviceProvider: '0x78bF4d833fC2ba1Abd42Bc772edbC788EC76A28F', // Provider's contract address
  payee: '0x78bF4d833fC2ba1Abd42Bc772edbC788EC76A28F', // Payment recipient
  name: 'Mock Provider',
  description: 'Mock provider for testing',
  active: true, // Provider is accepting new data
  products: {
    PDP: {
      // Proof of Data Possession service
      type: 'PDP',
      isActive: true,
      capabilities: {},
      data: {
        // PDP-specific configuration
        serviceURL: 'http://localhost:8888/pdp', // Where to upload data
        minPieceSizeInBytes: 127n, // Minimum piece size (127 bytes)
        maxPieceSizeInBytes: 34359738368n, // Maximum piece size (32 GiB)
        ipniPiece: false, // IPNI indexing capabilities
        ipniHttp: false,
        ipniBitswap: false,
        storagePricePerTibPerMonth: 5000000000000000000n, // Price in attoFIL
        location: 'Test Location',
        bandwidth: 1000, // Mbps
        throughput: 100, // MB/s
        storageCapacity: 1000n, // TiB total capacity
        storageAvailable: 800n, // TiB available
      } as any,
    },
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
  public readonly dataSetId = 123 // Simulated on-chain data set ID
  public readonly serviceProvider = mockProviderInfo.serviceProvider

  async upload(_data: ArrayBuffer | Uint8Array, options?: any): Promise<any> {
    // Extract callbacks from options (handle both old and new API)
    const callbacks = options?.onUploadComplete ? options : options?.callbacks || options
    // Simulate network delay for realistic testing
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Generate mock CommP (piece commitment) with correct prefix
    // Real CommP: bafkzcib... (raw multibase + CID with CommP codec)
    const pieceCid = `bafkzcib${Math.random().toString(36).substring(2, 15)}`
    const pieceId = Math.floor(Math.random() * 1000) // Piece index in data set

    // Simulate callback sequence matching real SDK behavior
    if (callbacks?.onUploadComplete != null) {
      // First: data uploaded to PDP server
      callbacks.onUploadComplete(pieceCid)
    }
    if (callbacks?.onPieceAdded != null) {
      // Second: piece registered (may require transaction)
      callbacks.onPieceAdded()
    }

    return { pieceCid, pieceId, size: 1024 }
  }
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

  // Storage namespace matches SDK structure
  public readonly storage = {
    createContext: this.createStorageContext.bind(this),
  }

  /**
   * Mock network identification
   * Real networks: 314 (mainnet), 314159 (calibration testnet)
   */
  getNetwork(): any {
    return { chainId: 314159n, name: 'calibration' }
  }

  /**
   * Mock provider getter - returns a mock provider with destroy method
   */
  getProvider(): any {
    return {
      destroy: async () => {
        // Mock provider cleanup
      },
    }
  }

  /**
   * Mock signer getter
   */
  getSigner(): any {
    return {
      getAddress: async () => '0x1234567890123456789012345678901234567890',
    }
  }

  /**
   * Mock client getter (returns owner wallet)
   */
  getClient(): any {
    return {
      getAddress: async () => '0x1234567890123456789012345678901234567890',
    }
  }

  /**
   * Create a storage context with lifecycle callbacks
   *
   * Real process:
   * 1. Query on-chain registry for active providers
   * 2. Select best provider based on criteria
   * 3. Check for existing data set or create new one
   * 4. Initialize upload session
   */
  async createStorageContext(options?: any): Promise<any> {
    // Simulate provider discovery and selection
    if (options?.callbacks?.onProviderSelected != null) {
      options.callbacks.onProviderSelected(mockProviderInfo)
    }

    // Simulate data set creation or reuse
    if (options?.callbacks?.onDataSetResolved != null) {
      options.callbacks.onDataSetResolved({
        dataSetId: 123,
        isExisting: false, // false = new data set created
      })
    }

    this._storageContext = new MockStorageContext()
    return this._storageContext
  }
}
