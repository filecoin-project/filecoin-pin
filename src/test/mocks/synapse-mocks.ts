import { EventEmitter } from 'node:events'
import type { PDPProvider } from '@filoz/synapse-sdk'

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
export const mockProviderInfo: PDPProvider = {
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
    minProvingPeriodInEpochs: 1n,
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
  public readonly dataSetId = 123 // Simulated on-chain data set ID
  public readonly serviceProvider = mockProviderInfo.serviceProvider
  public readonly provider = mockProviderInfo

  async upload(_data: ArrayBuffer | Uint8Array, options?: any): Promise<any> {
    // Extract callbacks from options (handle both old and new API)
    const callbacks = options?.onUploadComplete ? options : options?.callbacks || options
    // Simulate network delay for realistic testing
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Generate mock CommP (piece commitment) with correct prefix
    // Real CommP: bafkzcib... (raw multibase + CID with CommP codec)
    const pieceCid = `bafkzcib${Math.random().toString(36).substring(2, 15)}`
    const pieceId = Math.floor(Math.random() * 1000) // Piece index in data set

    // Simulate callback sequence
    if (callbacks?.onUploadComplete != null) {
      callbacks.onUploadComplete(pieceCid)
    }
    const txHash = `0x${Math.random().toString(16).substring(2)}` as const
    const pieces = [{ pieceId: BigInt(pieceId), pieceCid }]
    if (callbacks?.onPiecesAdded != null) {
      callbacks.onPiecesAdded(txHash, pieces)
    }
    if (callbacks?.onPieceAdded != null) {
      callbacks.onPieceAdded(txHash)
    }
    if (callbacks?.onPiecesConfirmed != null) {
      callbacks.onPiecesConfirmed(BigInt(Number(this.dataSetId)), pieces)
    }
    if (callbacks?.onPieceConfirmed != null) {
      callbacks.onPieceConfirmed([pieceId])
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
    upload: (data: any, options: any) => this._storageContext?.upload(data, options),
  }

  /** Mock chain (matches new SDK API) */
  readonly chain = { chainId: 314159n, name: 'calibration' as const }

  /**
   * Mock client (viem-style with account)
   */
  readonly client = {
    account: { address: '0x1234567890123456789012345678901234567890' },
    getAddress: async () => '0x1234567890123456789012345678901234567890' as const,
  }

  /** @deprecated Use chain.name */
  getNetwork(): string {
    return this.chain.name
  }

  /** @deprecated Use client */
  getClient() {
    return this.client
  }

  /**
   * Mock session key creation
   */
  createSessionKey(_sessionWallet: any): any {
    const now = Math.floor(Date.now() / 1000)
    const oneYear = 365 * 24 * 60 * 60 // One year from now

    return {
      /**
       * Fetch expiries for various permission types
       * Returns a map of typehash -> expiry timestamp
       *
       * By default, mock both CREATE_DATA_SET and ADD_PIECES with valid future expiries
       * Tests can override this to simulate different scenarios:
       * - CREATE_DATA_SET = 0: No permission to create datasets
       * - CREATE_DATA_SET < now + 30min: Expired/expiring soon
       */
      fetchExpiries: async (typehashes: string[]) => {
        const expiries: Record<string, bigint> = {}
        for (const typehash of typehashes) {
          // By default, all permissions valid for one year
          expiries[typehash] = BigInt(now + oneYear)
        }
        return expiries
      },
    }
  }

  /**
   * Mock session key setter
   */
  setSession(_sessionKey: any): void {
    // No-op in mock
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
        dataSetId: 123n,
        isExisting: false,
        provider: mockProviderInfo,
      })
    }

    this._storageContext = new MockStorageContext()
    return this._storageContext
  }
}

// Add calibration export directly to the module to match @filoz/synapse-sdk exports
export const calibration = { chainId: 314159n, name: 'calibration' as const }

// Mock parseUnits from viem/ethers as exported by synapse-sdk
export function parseUnits(value: string, decimals: number): bigint {
  const [db, da] = value.split('.')
  const v = BigInt(db ?? '0') * 10n ** BigInt(decimals) + BigInt(da?.padEnd(decimals, '0') || 0)
  return v
}
