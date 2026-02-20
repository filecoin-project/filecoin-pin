import * as synapseSdk from '@filoz/synapse-sdk'
import { CID } from 'multiformats/cid'
import type { Logger } from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConfig } from '../../config.js'
import {
  getSynapseService,
  initializeSynapse,
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

    it('should initialize Synapse in read-only mode when requested', async () => {
      const readOnlyConfig: SynapseSetupConfig = {
        walletAddress: '0x0000000000000000000000000000000000000002',
        readOnly: true,
        rpcUrl: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1',
      }

      const infoSpy = vi.spyOn(logger, 'info')

      const synapse = await initializeSynapse(readOnlyConfig, logger)

      expect(synapse).toBeDefined()
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'synapse.init',
          authMode: 'read-only',
          rpcUrl: readOnlyConfig.rpcUrl,
        }),
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
        onProgress(event) {
          switch (event.type) {
            case 'onUploadComplete': {
              uploadCompleteCallbackCalled = true
              break
            }
            case 'onPieceAdded': {
              pieceAddedCallbackCalled = true
              break
            }
          }
        },
      })

      expect(uploadCompleteCallbackCalled).toBe(true)
      expect(pieceAddedCallbackCalled).toBe(true)
    })

    it('should throw immediately when signal is already aborted', async () => {
      const data = new Uint8Array([1, 2, 3])
      const abortController = new AbortController()
      abortController.abort()

      await expect(
        uploadToSynapse(service, data, TEST_CID, logger, {
          contextId: 'pin-abort',
          signal: abortController.signal,
        })
      ).rejects.toThrow('This operation was aborted')
    })

    it('should pass signal to synapse.storage.upload', async () => {
      const data = new Uint8Array([1, 2, 3])
      const abortController = new AbortController()
      const uploadSpy = vi.spyOn(service.synapse.storage, 'upload')

      await uploadToSynapse(service, data, TEST_CID, logger, {
        contextId: 'pin-signal',
        signal: abortController.signal,
      })

      expect(uploadSpy).toHaveBeenCalledWith(
        data,
        expect.objectContaining({
          signal: abortController.signal,
        })
      )
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

  describe('Session Key Authentication', () => {
    it('should accept session key with valid ADD_PIECES permission even without CREATE_DATA_SET', async () => {
      const mockConfig = {
        walletAddress: '0x1234567890123456789012345678901234567890',
        sessionKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
        rpcUrl: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1',
      }

      // Mock session key with no CREATE_DATA_SET permission (expiry = 0)
      const mockCreateSessionKey = vi.fn(() => {
        const now = Math.floor(Date.now() / 1000)
        const oneYear = 365 * 24 * 60 * 60

        return {
          fetchExpiries: async (typehashes: string[]) => {
            const expiries: Record<string, bigint> = {}
            for (const typehash of typehashes) {
              // CREATE_DATA_SET has no permission (0)
              // ADD_PIECES has valid future expiry
              if (typehash.includes('1234567890abcdef')) {
                // This is CREATE_DATA_SET_TYPEHASH
                expiries[typehash] = 0n
              } else {
                // This is ADD_PIECES_TYPEHASH
                expiries[typehash] = BigInt(now + oneYear)
              }
            }
            return expiries
          },
        }
      })

      // Override the mock
      const originalCreate = synapseSdk.Synapse.create
      vi.mocked(synapseSdk.Synapse.create).mockImplementationOnce(async (options) => {
        const synapse = await originalCreate(options)
        ;(synapse as any).createSessionKey = mockCreateSessionKey
        ;(synapse as any).setSession = vi.fn()
        return synapse
      })

      // Should not throw - session key with only ADD_PIECES is valid for reusing datasets
      const service = await setupSynapse(mockConfig as any, logger)
      expect(service).toBeDefined()
      expect(mockCreateSessionKey).toHaveBeenCalled()
    })

    it('should reject session key with expired CREATE_DATA_SET permission', async () => {
      const mockConfig = {
        walletAddress: '0x1234567890123456789012345678901234567890',
        sessionKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
        rpcUrl: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1',
      }

      // Mock session key with expired CREATE_DATA_SET permission
      const mockCreateSessionKey = vi.fn(() => {
        const now = Math.floor(Date.now() / 1000)
        const oneYear = 365 * 24 * 60 * 60

        return {
          fetchExpiries: async (typehashes: string[]) => {
            const expiries: Record<string, bigint> = {}
            for (const typehash of typehashes) {
              // CREATE_DATA_SET expired 1 hour ago
              // ADD_PIECES has valid future expiry
              if (typehash.includes('1234567890abcdef')) {
                // This is CREATE_DATA_SET_TYPEHASH - expired
                expiries[typehash] = BigInt(now - 3600)
              } else {
                // This is ADD_PIECES_TYPEHASH - valid
                expiries[typehash] = BigInt(now + oneYear)
              }
            }
            return expiries
          },
        }
      })

      // Override the mock
      const originalCreate = synapseSdk.Synapse.create
      vi.mocked(synapseSdk.Synapse.create).mockImplementationOnce(async (options) => {
        const synapse = await originalCreate(options)
        ;(synapse as any).createSessionKey = mockCreateSessionKey
        return synapse
      })

      // Should throw - expired CREATE_DATA_SET permission
      await expect(setupSynapse(mockConfig as any, logger)).rejects.toThrow('Session key expired or expiring soon')
    })

    it('should reject session key with expired ADD_PIECES permission', async () => {
      const mockConfig = {
        walletAddress: '0x1234567890123456789012345678901234567890',
        sessionKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
        rpcUrl: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1',
      }

      // Mock session key with expired ADD_PIECES permission
      const mockCreateSessionKey = vi.fn(() => {
        const now = Math.floor(Date.now() / 1000)
        const oneYear = 365 * 24 * 60 * 60

        return {
          fetchExpiries: async (typehashes: string[]) => {
            const expiries: Record<string, bigint> = {}
            for (const typehash of typehashes) {
              // CREATE_DATA_SET has valid permission
              // ADD_PIECES expired 1 hour ago
              if (typehash.includes('1234567890abcdef')) {
                // This is CREATE_DATA_SET_TYPEHASH - valid
                expiries[typehash] = BigInt(now + oneYear)
              } else {
                // This is ADD_PIECES_TYPEHASH - expired
                expiries[typehash] = BigInt(now - 3600)
              }
            }
            return expiries
          },
        }
      })

      // Override the mock
      const originalCreate = synapseSdk.Synapse.create
      vi.mocked(synapseSdk.Synapse.create).mockImplementationOnce(async (options) => {
        const synapse = await originalCreate(options)
        ;(synapse as any).createSessionKey = mockCreateSessionKey
        return synapse
      })

      // Should throw - expired ADD_PIECES permission (always required)
      await expect(setupSynapse(mockConfig as any, logger)).rejects.toThrow('Session key expired or expiring soon')
    })
  })
})
