import * as synapseSdk from '@filoz/synapse-sdk'
import { CID } from 'multiformats/cid'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../../config.js'
import { createConfig } from '../../config.js'
import { createLogger } from '../../logger.js'
import { getSynapseService, initializeSynapse, resetSynapseService } from '../../synapse-service.js'
import { uploadToSynapse } from '../../synapse-upload.js'

// Mock the Synapse SDK - vi.mock requires async import for ES modules
vi.mock('@filoz/synapse-sdk', async () => await import('../mocks/synapse-sdk.js'))

// Test CID for upload tests
const TEST_CID = CID.parse('bafkreia5fn4rmshmb7cl7fufkpcw733b5anhuhydtqstnglpkzosqln5kq')

describe('synapse-service', () => {
  let config: Config
  let logger: ReturnType<typeof createLogger>

  beforeEach(() => {
    // Create test config with Synapse enabled
    config = {
      ...createConfig(),
      privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001', // Fake test key
      rpcUrl: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1',
    }
    logger = createLogger(config)

    // Reset the service instances
    resetSynapseService()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('initializeSynapse', () => {
    it('should throw error when private key is not configured', async () => {
      config.privateKey = undefined

      await expect(initializeSynapse(config, logger)).rejects.toThrow('PRIVATE_KEY environment variable is required')
    })

    it('should initialize Synapse when private key is configured', async () => {
      const result = await initializeSynapse(config, logger)

      expect(result).not.toBeNull()
      expect(result?.synapse).toBeDefined()
      expect(result?.storage).toBeDefined()
    })

    it('should log initialization events', async () => {
      const infoSpy = vi.spyOn(logger, 'info')

      await initializeSynapse(config, logger)

      // Check that initialization logs were called
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          hasPrivateKey: true,
          rpcUrl: config.rpcUrl,
        }),
        'Initializing Synapse'
      )

      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'synapse.init' }),
        'Initializing Synapse SDK'
      )
    })

    it('should call provider selection callback', async () => {
      const callbacks: any[] = []
      const originalCreate = synapseSdk.Synapse.create

      // Capture callbacks
      vi.mocked(originalCreate).mockImplementationOnce(async (options) => {
        const synapse = await originalCreate(options)
        const originalCreateContext = synapse.storage.createContext.bind(synapse.storage)

        synapse.storage.createContext = async (opts: any) => {
          if (opts?.callbacks?.onProviderSelected != null) {
            callbacks.push(opts.callbacks.onProviderSelected)
          }
          return await originalCreateContext(opts)
        }

        return synapse
      })

      await initializeSynapse(config, logger)

      expect(callbacks.length).toBeGreaterThan(0)
    })
  })

  describe('getSynapseService', () => {
    it('should return null when not initialized', () => {
      // Ensure service is reset
      resetSynapseService()

      const result = getSynapseService()
      expect(result).toBeNull()
    })

    it('should return service after initialization', async () => {
      await initializeSynapse(config, logger)

      const result = getSynapseService()
      expect(result).not.toBeNull()
      expect(result?.synapse).toBeDefined()
      expect(result?.storage).toBeDefined()
    })
  })

  describe('uploadToSynapse', () => {
    let service: any

    beforeEach(async () => {
      service = await initializeSynapse(config, logger)
    })

    it('should upload data successfully', async () => {
      const data = new Uint8Array([1, 2, 3])
      const contextId = 'pin-123'

      const result = await uploadToSynapse(service, data, TEST_CID, logger, { contextId })

      expect(result).toHaveProperty('pieceCid')
      expect(result).toHaveProperty('pieceId')
      expect(result).toHaveProperty('dataSetId')
      expect(result.pieceCid).toMatch(/^bafkzcib/)
      expect(result.dataSetId).toBe('123')
    })

    it('should log upload events', async () => {
      const infoSpy = vi.spyOn(logger, 'info')
      const data = new Uint8Array([1, 2, 3])
      const contextId = 'pin-456'

      await uploadToSynapse(service, data, TEST_CID, logger, { contextId })

      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'synapse.upload.piece_uploaded',
          contextId,
        }),
        'Upload to PDP server complete'
      )

      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'synapse.upload.success',
          contextId,
        }),
        'Successfully uploaded to Filecoin with Synapse'
      )
    })

    it('should call upload callbacks', async () => {
      let uploadCompleteCallbackCalled = false
      let pieceAddedCallbackCalled = false

      const data = new Uint8Array([1, 2, 3])
      await uploadToSynapse(service, data, TEST_CID, logger, {
        contextId: 'pin-789',
        callbacks: {
          onUploadComplete: () => {
            uploadCompleteCallbackCalled = true
          },
          onPieceAdded: () => {
            pieceAddedCallbackCalled = true
          },
        },
      })

      expect(uploadCompleteCallbackCalled).toBe(true)
      expect(pieceAddedCallbackCalled).toBe(true)
    })
  })

  describe('Provider Information', () => {
    it('should capture provider info during initialization', async () => {
      const mockConfig: Config = {
        privateKey: 'test-private-key',
        rpcUrl: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1',
        port: 3000,
        host: '127.0.0.1',
        databasePath: ':memory:',
        carStoragePath: './cars',
        logLevel: 'info',
        warmStorageAddress: undefined,
      }

      const service = await initializeSynapse(mockConfig, logger)

      // Check that provider info was captured
      expect(service.providerInfo).toBeDefined()
      expect(service.providerInfo?.id).toBe(1)
      expect(service.providerInfo?.name).toBe('Mock Provider')
      expect(service.providerInfo?.products?.PDP?.data?.serviceURL).toBe('http://localhost:8888/pdp')
    })

    it('should include provider info in upload result', async () => {
      // Ensure synapse is initialized with provider info
      const mockConfig: Config = {
        privateKey: 'test-private-key',
        rpcUrl: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1',
        port: 3000,
        host: '127.0.0.1',
        databasePath: ':memory:',
        carStoragePath: './cars',
        logLevel: 'info',
        warmStorageAddress: undefined,
      }

      const service = await initializeSynapse(mockConfig, logger)

      // Now test the upload with synapse-upload.ts
      const data = new Uint8Array([1, 2, 3])
      const result = await uploadToSynapse(service, data, TEST_CID, logger, {
        contextId: 'test-upload',
      })

      // Verify provider info is included in result
      expect(result.providerInfo).toBeDefined()
      expect(result.providerInfo?.id).toBe(1)
      expect(result.providerInfo?.name).toBe('Mock Provider')
      expect(result.providerInfo?.serviceURL).toBe('http://localhost:8888/pdp')

      // Verify download URL is correctly constructed
      expect(result.providerInfo?.downloadURL).toBe(`http://localhost:8888/pdp/piece/${result.pieceCid}`)
    })

    it('should handle missing provider info gracefully', async () => {
      // Initialize without provider info being set
      const mockConfig: Config = {
        privateKey: 'test-private-key',
        rpcUrl: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1',
        port: 3000,
        host: '127.0.0.1',
        databasePath: ':memory:',
        carStoragePath: './cars',
        logLevel: 'info',
        warmStorageAddress: undefined,
      }

      // Create a service without provider info by manipulating after init
      const service = await initializeSynapse(mockConfig, logger)
      // Manually clear provider info to test the fallback
      ;(service as any).providerInfo = undefined

      const data = new Uint8Array([1, 2, 3])
      const result = await uploadToSynapse(service, data, TEST_CID, logger, {
        contextId: 'test-upload',
      })

      // Verify upload still works but provider info is undefined
      expect(result.pieceCid).toBeDefined()
      expect(result.providerInfo).toBeUndefined()
    })

    it('should handle provider without serviceURL gracefully', async () => {
      const mockConfig: Config = {
        privateKey: 'test-private-key',
        rpcUrl: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1',
        port: 3000,
        host: '127.0.0.1',
        databasePath: ':memory:',
        carStoragePath: './cars',
        logLevel: 'info',
        warmStorageAddress: undefined,
      }

      const service = await initializeSynapse(mockConfig, logger)

      // Modify provider info to not have serviceURL
      if (service.providerInfo) {
        ;(service.providerInfo as any).products = {
          PDP: {
            data: {
              // No serviceURL
            },
          },
        }
      }

      const data = new Uint8Array([1, 2, 3])
      const result = await uploadToSynapse(service, data, TEST_CID, logger, {
        contextId: 'test-upload',
      })

      // Verify upload works but provider info is not included
      expect(result.pieceCid).toBeDefined()
      expect(result.providerInfo).toBeUndefined()
    })
  })
})
