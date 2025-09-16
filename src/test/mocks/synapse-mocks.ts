import { EventEmitter } from 'node:events'
import type { ProviderInfo } from '@filoz/synapse-sdk'

// Mock provider info for testing
export const mockProviderInfo: ProviderInfo = {
  id: 1,
  serviceProvider: '0x78bF4d833fC2ba1Abd42Bc772edbC788EC76A28F',
  payee: '0x78bF4d833fC2ba1Abd42Bc772edbC788EC76A28F',
  name: 'Mock Provider',
  description: 'Mock provider for testing',
  active: true,
  products: {
    PDP: {
      type: 'PDP',
      isActive: true,
      capabilities: {},
      data: {
        serviceURL: 'http://localhost:8888/pdp',
        minPieceSizeInBytes: 127n,
        maxPieceSizeInBytes: 34359738368n,
        ipniPiece: false,
        ipniHttp: false,
        ipniBitswap: false,
        storagePricePerTibPerMonth: 5000000000000000000n,
        location: 'Test Location',
        bandwidth: 1000,
        throughput: 100,
        storageCapacity: 1000n,
        storageAvailable: 800n,
      } as any,
    },
  },
}

// Mock storage context that simulates successful uploads
export class MockStorageContext extends EventEmitter {
  public readonly dataSetId = 123
  public readonly serviceProvider = mockProviderInfo.serviceProvider

  async upload(_data: ArrayBuffer | Uint8Array, callbacks?: any): Promise<any> {
    // Simulate upload delay
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Generate a mock PieceCID based on data size
    const pieceCid = `bafkzcib${Math.random().toString(36).substring(2, 15)}`
    const pieceId = Math.floor(Math.random() * 1000)

    // Call callbacks if provided
    if (callbacks?.onUploadComplete != null) {
      callbacks.onUploadComplete(pieceCid)
    }
    if (callbacks?.onPieceAdded != null) {
      callbacks.onPieceAdded()
    }

    return { pieceCid, pieceId, size: 1024 }
  }
}

// Mock Synapse instance
export class MockSynapse extends EventEmitter {
  private _storageContext: MockStorageContext | null = null

  public readonly storage = {
    createContext: this.createStorageContext.bind(this),
  }

  getNetwork(): any {
    return { chainId: 314159n, name: 'calibration' }
  }

  async createStorageContext(options?: any): Promise<any> {
    // Simulate provider selection
    if (options?.callbacks?.onProviderSelected != null) {
      options.callbacks.onProviderSelected(mockProviderInfo)
    }

    // Simulate data set resolution
    if (options?.callbacks?.onDataSetResolved != null) {
      options.callbacks.onDataSetResolved({
        dataSetId: 123,
        isExisting: false,
      })
    }

    this._storageContext = new MockStorageContext()
    return this._storageContext
  }
}
