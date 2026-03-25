import { CID } from 'multiformats/cid'
import type { Logger } from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initializeSynapse, type SynapseSetupConfig } from '../../core/synapse/index.js'
import { executeUpload, uploadToSynapse } from '../../core/upload/index.js'
import { createLogger } from '../../logger.js'
import { MockSynapse } from '../mocks/synapse-mocks.js'

// Mock the Synapse SDK
vi.mock('@filoz/synapse-sdk', async () => await import('../mocks/synapse-sdk.js'))

// Test CID for upload tests
const TEST_CID = CID.parse('bafkreia5fn4rmshmb7cl7fufkpcw733b5anhuhydtqstnglpkzosqln5kq')

describe('synapse-service', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createLogger({ logLevel: 'info' })
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('initializeSynapse', () => {
    it('should initialize Synapse with private key config', async () => {
      const config: SynapseSetupConfig = {
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
        rpcUrl: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1',
      }

      const synapse = await initializeSynapse(config, logger)
      expect(synapse).toBeDefined()
    })

    it('should log initialization events', async () => {
      const infoSpy = vi.spyOn(logger, 'info')
      const config: SynapseSetupConfig = {
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
        rpcUrl: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1',
      }

      await initializeSynapse(config, logger)

      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'synapse.init', mode: 'private-key' }),
        'Initializing Synapse'
      )

      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'synapse.init.success' }),
        'Synapse initialized'
      )
    })

    it('should initialize Synapse in read-only mode', async () => {
      const config: SynapseSetupConfig = {
        walletAddress: '0x0000000000000000000000000000000000000002',
        readOnly: true,
        rpcUrl: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1',
      }

      const infoSpy = vi.spyOn(logger, 'info')
      const synapse = await initializeSynapse(config, logger)

      expect(synapse).toBeDefined()
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'synapse.init', mode: 'read-only' }),
        'Initializing Synapse (read-only)'
      )
    })
  })

  describe('uploadToSynapse', () => {
    let mockSynapse: MockSynapse

    beforeEach(async () => {
      mockSynapse = new MockSynapse()
      // Ensure internal storage context is created
      await mockSynapse.createStorageContext()
    })

    it('should upload data successfully', async () => {
      const data = new Uint8Array([1, 2, 3])
      const contextId = 'pin-123'

      const result = await uploadToSynapse(mockSynapse as any, data, TEST_CID, logger, { contextId })

      expect(result).toHaveProperty('pieceCid')
      expect(result).toHaveProperty('copies')
      expect(result).toHaveProperty('failedAttempts')
      expect(result.pieceCid).toMatch(/^bafkzcib/)
      expect(result.copies).toHaveLength(1)
      expect(result.failedAttempts).toHaveLength(0)
    })

    it('should log upload events', async () => {
      const infoSpy = vi.spyOn(logger, 'info')
      const data = new Uint8Array([1, 2, 3])
      const contextId = 'pin-456'

      await uploadToSynapse(mockSynapse as any, data, TEST_CID, logger, { contextId })

      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'synapse.upload.stored',
          contextId,
        }),
        'Piece stored on provider'
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
      let storedCallbackCalled = false
      let piecesAddedCallbackCalled = false

      const data = new Uint8Array([1, 2, 3])
      await uploadToSynapse(mockSynapse as any, data, TEST_CID, logger, {
        contextId: 'pin-789',
        onProgress(event) {
          switch (event.type) {
            case 'onStored': {
              storedCallbackCalled = true
              break
            }
            case 'onPiecesAdded': {
              piecesAddedCallbackCalled = true
              break
            }
          }
        },
      })

      expect(storedCallbackCalled).toBe(true)
      expect(piecesAddedCallbackCalled).toBe(true)
    })

    it('should throw immediately when signal is already aborted', async () => {
      const data = new Uint8Array([1, 2, 3])
      const abortController = new AbortController()
      abortController.abort()

      await expect(
        uploadToSynapse(mockSynapse as any, data, TEST_CID, logger, {
          contextId: 'pin-abort',
          signal: abortController.signal,
        })
      ).rejects.toThrow('This operation was aborted')
    })

    it('should pass signal to storage.upload', async () => {
      const data = new Uint8Array([1, 2, 3])
      const abortController = new AbortController()
      const uploadSpy = vi.spyOn(mockSynapse.storage, 'upload')

      await uploadToSynapse(mockSynapse as any, data, TEST_CID, logger, {
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

  describe('Multi-copy Results', () => {
    it('should return copies array in upload result', async () => {
      const mockSynapse = new MockSynapse()
      await mockSynapse.createStorageContext()

      const data = new Uint8Array([1, 2, 3])
      const result = await uploadToSynapse(mockSynapse as any, data, TEST_CID, logger, {
        contextId: 'test-upload',
      })

      expect(result.copies).toBeDefined()
      expect(result.copies).toHaveLength(1)
      const primaryCopy = result.copies[0]
      expect(primaryCopy).toBeDefined()
      expect(primaryCopy?.role).toBe('primary')
      expect(primaryCopy?.providerId).toBe(1n)
      expect(primaryCopy?.dataSetId).toBe(123n)
      expect(primaryCopy?.retrievalUrl).toContain('/pdp/piece/')
    })

    it('should return empty failedAttempts array on success', async () => {
      const mockSynapse = new MockSynapse()
      await mockSynapse.createStorageContext()

      const data = new Uint8Array([1, 2, 3])
      const result = await uploadToSynapse(mockSynapse as any, data, TEST_CID, logger, {
        contextId: 'test-upload',
      })

      expect(result.failedAttempts).toBeDefined()
      expect(result.failedAttempts).toHaveLength(0)
    })
  })

  describe('executeUpload targeting validation', () => {
    const noopLogger = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as unknown as Logger

    it('should reject contexts combined with providerIds', async () => {
      await expect(
        executeUpload({} as any, new Uint8Array(), TEST_CID, {
          logger: noopLogger,
          contexts: [{} as any],
          providerIds: [1n],
        } as any)
      ).rejects.toThrow("Cannot combine 'contexts'")
    })

    it('should reject contexts combined with dataSetIds', async () => {
      await expect(
        executeUpload({} as any, new Uint8Array(), TEST_CID, {
          logger: noopLogger,
          contexts: [{} as any],
          dataSetIds: [1n],
        } as any)
      ).rejects.toThrow("Cannot combine 'contexts'")
    })

    it('should reject contexts combined with copies', async () => {
      await expect(
        executeUpload({} as any, new Uint8Array(), TEST_CID, {
          logger: noopLogger,
          contexts: [{} as any],
          copies: 2,
        } as any)
      ).rejects.toThrow("Cannot combine 'contexts'")
    })

    it('should reject providerIds combined with dataSetIds', async () => {
      await expect(
        executeUpload({} as any, new Uint8Array(), TEST_CID, {
          logger: noopLogger,
          providerIds: [1n],
          dataSetIds: [1n],
        } as any)
      ).rejects.toThrow("Cannot specify both 'providerIds' and 'dataSetIds'")
    })
  })

  describe('uploadToSynapse contexts pass-through', () => {
    it('should pass contexts to storage.upload', async () => {
      const mockSynapse = new MockSynapse()
      await mockSynapse.createStorageContext()
      const uploadSpy = vi.spyOn(mockSynapse.storage, 'upload')
      const fakeContexts = [{} as any]

      await uploadToSynapse(mockSynapse as any, new Uint8Array([1]), TEST_CID, logger, {
        contexts: fakeContexts,
      })

      expect(uploadSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ contexts: fakeContexts })
      )
    })

    it('should not pass providerIds or copies when contexts is set', async () => {
      const mockSynapse = new MockSynapse()
      await mockSynapse.createStorageContext()
      const uploadSpy = vi.spyOn(mockSynapse.storage, 'upload')

      await uploadToSynapse(mockSynapse as any, new Uint8Array([1]), TEST_CID, logger, {
        contexts: [{} as any],
      })

      const passedOptions = uploadSpy.mock.calls[0]?.[1]
      expect(passedOptions?.contexts).toBeDefined()
      expect(passedOptions?.providerIds).toBeUndefined()
      expect(passedOptions?.dataSetIds).toBeUndefined()
      expect(passedOptions?.copies).toBeUndefined()
    })
  })
})
