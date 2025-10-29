import * as synapseSdk from '@filoz/synapse-sdk'
import { CID } from 'multiformats/cid'
import type { Logger } from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConfig } from '../../config.js'
import {
  getSynapseService,
  resetSynapseService,
  type SynapseSetupConfig,
  setupSynapse,
} from '../../core/synapse/index.js'
import { uploadToSynapse } from '../../core/upload/index.js'
import { createLogger } from '../../logger.js'

// Mock the Synapse SDK - vi.mock requires async import for ES modules
vi.mock('@filoz/synapse-sdk', async () => await import('../mocks/synapse-sdk.js'))

// Test CID for upload tests
const TEST_CID = CID.parse('bafkreia5fn4rmshmb7cl7fufkpcw733b5anhuhydtqstnglpkzosqln5kq')

describe('synapse-service', () => {
  let config: SynapseSetupConfig
  let logger: Logger

  beforeEach(() => {
    // Create test config with Synapse enabled
    config = {
      ...createConfig(),
      privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001', // Fake test key
      rpcUrl: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1',
    }
    logger = createLogger({ logLevel: 'info' })

    // Reset the service instances
    resetSynapseService()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('setupSynapse', () => {
    it('should throw error when no authentication is provided', async () => {
      // Create an invalid config with no authentication
      const invalidConfig = {
        rpcUrl: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1',
      } as any

      await expect(setupSynapse(invalidConfig, logger)).rejects.toThrow('Authentication required')
    })

    it('should initialize Synapse when private key is configured', async () => {
      const result = await setupSynapse(config, logger)

      expect(result).not.toBeNull()
      expect(result?.synapse).toBeDefined()
      expect(result?.storage).toBeDefined()
    })

    it('should log initialization events', async () => {
      const infoSpy = vi.spyOn(logger, 'info')

      await setupSynapse(config, logger)

      // Check that initialization logs were called
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'synapse.init',
          authMode: 'standard',
          rpcUrl: config.rpcUrl,
        }),
        'Initializing Synapse SDK'
      )

      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'synapse.init.success' }),
        'Synapse SDK initialized'
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

      await setupSynapse(config, logger)

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
      await setupSynapse(config, logger)

      const result = getSynapseService()
      expect(result).not.toBeNull()
      expect(result?.synapse).toBeDefined()
      expect(result?.storage).toBeDefined()
    })
  })

  describe('uploadToSynapse', () => {
    let service: any

    beforeEach(async () => {
      service = await setupSynapse(config, logger)
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
      const mockConfig: SynapseSetupConfig = {
        privateKey: 'test-private-key',
        rpcUrl: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1',
      }

      const service = await setupSynapse(mockConfig, logger)

      // Check that provider info was captured
      expect(service.providerInfo).toBeDefined()
      expect(service.providerInfo?.id).toBe(1)
      expect(service.providerInfo?.name).toBe('Mock Provider')
      expect(service.providerInfo?.products?.PDP?.data?.serviceURL).toBe('http://localhost:8888/pdp')
    })

    it('should include provider info in upload result', async () => {
      // Ensure synapse is initialized with provider info
      const mockConfig: SynapseSetupConfig = {
        privateKey: 'test-private-key',
        rpcUrl: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1',
      }

      const service = await setupSynapse(mockConfig, logger)

      // Now test the upload with synapse-upload.ts
      const data = new Uint8Array([1, 2, 3])
      const result = await uploadToSynapse(service, data, TEST_CID, logger, {
        contextId: 'test-upload',
      })

      // Verify provider info is included in result
      expect(result.providerInfo).toBeDefined()
      expect(result.providerInfo?.id).toBe(1)
      expect(result.providerInfo?.name).toBe('Mock Provider')
      expect(result.providerInfo?.products?.PDP?.data?.serviceURL).toBe('http://localhost:8888/pdp')
    })

    it('should always include provider info', async () => {
      // Initialize with provider info
      const mockConfig: SynapseSetupConfig = {
        privateKey: 'test-private-key',
        rpcUrl: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1',
      }

      const service = await setupSynapse(mockConfig, logger)

      const data = new Uint8Array([1, 2, 3])
      const result = await uploadToSynapse(service, data, TEST_CID, logger, {
        contextId: 'test-upload',
      })

      // Verify upload includes provider info
      expect(result.pieceCid).toBeDefined()
      expect(result.providerInfo).toBeDefined()
      expect(result.providerInfo.id).toBe(1)
      expect(result.providerInfo.name).toBe('Mock Provider')
    })

    it('should handle provider without serviceURL gracefully', async () => {
      const mockConfig: SynapseSetupConfig = {
        privateKey: 'test-private-key',
        rpcUrl: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1',
      }

      const service = await setupSynapse(mockConfig, logger)

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

      // Verify upload works with provider info (serviceURL is empty)
      expect(result.pieceCid).toBeDefined()
      expect(result.providerInfo).toBeDefined()
      expect(result.providerInfo.products?.PDP?.data?.serviceURL).toBeUndefined()
    })
  })
})
