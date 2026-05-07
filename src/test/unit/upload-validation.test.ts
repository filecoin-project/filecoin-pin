import { METADATA_KEYS } from '@filoz/synapse-sdk'
import { CID } from 'multiformats/cid'
import type { Logger } from 'pino'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { APPLICATION_SOURCE } from '../../core/synapse/constants.js'
import { executeUpload } from '../../core/upload/index.js'
import { uploadToSynapse } from '../../core/upload/synapse.js'
import { createLogger } from '../../logger.js'
import { MockSynapse } from '../mocks/synapse-mocks.js'

vi.mock('@filoz/synapse-sdk', async () => await import('../mocks/synapse-sdk.js'))

const TEST_CID = CID.parse('bafkreia5fn4rmshmb7cl7fufkpcw733b5anhuhydtqstnglpkzosqln5kq')

// Lightweight logger for validation-only tests (never reaches SDK internals)
const noop = () => undefined
const noopLogger = { info: noop, debug: noop, warn: noop, error: noop } as unknown as Logger

describe('upload option validation', () => {
  describe('executeUpload', () => {
    it('rejects contexts combined with providerIds', async () => {
      await expect(
        executeUpload({} as any, new Uint8Array(), TEST_CID, {
          logger: noopLogger,
          contexts: [{} as any],
          providerIds: [1n],
        } as any)
      ).rejects.toThrow("Cannot combine 'contexts'")
    })

    it('rejects contexts combined with dataSetIds', async () => {
      await expect(
        executeUpload({} as any, new Uint8Array(), TEST_CID, {
          logger: noopLogger,
          contexts: [{} as any],
          dataSetIds: [1n],
        } as any)
      ).rejects.toThrow("Cannot combine 'contexts'")
    })

    it('rejects contexts combined with copies', async () => {
      await expect(
        executeUpload({} as any, new Uint8Array(), TEST_CID, {
          logger: noopLogger,
          contexts: [{} as any],
          copies: 2,
        } as any)
      ).rejects.toThrow("Cannot combine 'contexts'")
    })

    it('rejects contexts combined with excludeProviderIds', async () => {
      await expect(
        executeUpload({} as any, new Uint8Array(), TEST_CID, {
          logger: noopLogger,
          contexts: [{} as any],
          excludeProviderIds: [1n],
        } as any)
      ).rejects.toThrow("Cannot combine 'contexts'")
    })

    it('rejects providerIds combined with dataSetIds', async () => {
      await expect(
        executeUpload({} as any, new Uint8Array(), TEST_CID, {
          logger: noopLogger,
          providerIds: [1n],
          dataSetIds: [1n],
        } as any)
      ).rejects.toThrow("Cannot specify both 'providerIds' and 'dataSetIds'")
    })
  })

  describe('uploadToSynapse', () => {
    it('rejects contexts combined with providerIds', async () => {
      await expect(
        uploadToSynapse({} as any, new Uint8Array(), TEST_CID, noopLogger, {
          contexts: [{} as any],
          providerIds: [1n],
        })
      ).rejects.toThrow("Cannot combine 'contexts'")
    })

    it('rejects contexts combined with copies', async () => {
      await expect(
        uploadToSynapse({} as any, new Uint8Array(), TEST_CID, noopLogger, {
          contexts: [{} as any],
          copies: 2,
        })
      ).rejects.toThrow("Cannot combine 'contexts'")
    })

    it('rejects contexts combined with excludeProviderIds', async () => {
      await expect(
        uploadToSynapse({} as any, new Uint8Array(), TEST_CID, noopLogger, {
          contexts: [{} as any],
          excludeProviderIds: [1n],
        })
      ).rejects.toThrow("Cannot combine 'contexts'")
    })

    it('rejects providerIds combined with dataSetIds', async () => {
      await expect(
        uploadToSynapse({} as any, new Uint8Array(), TEST_CID, noopLogger, {
          providerIds: [1n],
          dataSetIds: [1n],
        })
      ).rejects.toThrow("Cannot specify both 'providerIds' and 'dataSetIds'")
    })
  })

  describe('option pass-through', () => {
    let mockSynapse: MockSynapse
    let logger: Logger

    beforeEach(async () => {
      logger = createLogger({ logLevel: 'info' })
      mockSynapse = new MockSynapse()
      await mockSynapse.createStorageContext()
      vi.clearAllMocks()
    })

    it('forwards contexts to storage.upload', async () => {
      const uploadSpy = vi.spyOn(mockSynapse.storage, 'upload')
      const fakeContexts = [{} as any]

      await uploadToSynapse(mockSynapse as any, new Uint8Array([1]), TEST_CID, logger, {
        contexts: fakeContexts,
      })

      expect(uploadSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ contexts: fakeContexts }))
    })

    it('does not forward targeting options when contexts is set', async () => {
      const uploadSpy = vi.spyOn(mockSynapse.storage, 'upload')

      await uploadToSynapse(mockSynapse as any, new Uint8Array([1]), TEST_CID, logger, {
        contexts: [{} as any],
      })

      const passedOptions = uploadSpy.mock.calls[0]?.[1]
      expect(passedOptions).toHaveProperty('contexts')
      expect(passedOptions).not.toHaveProperty('providerIds')
      expect(passedOptions).not.toHaveProperty('dataSetIds')
      expect(passedOptions).not.toHaveProperty('copies')
      expect(passedOptions).not.toHaveProperty('excludeProviderIds')
    })

    it('forwards providerIds and copies when contexts is not set', async () => {
      const uploadSpy = vi.spyOn(mockSynapse.storage, 'upload')

      await uploadToSynapse(mockSynapse as any, new Uint8Array([1]), TEST_CID, logger, {
        providerIds: [1n],
        copies: 3,
      })

      const passedOptions = uploadSpy.mock.calls[0]?.[1]
      expect(passedOptions).not.toHaveProperty('contexts')
      expect(passedOptions?.providerIds).toEqual([1n])
      expect(passedOptions?.copies).toBe(3)
    })

    it('forwards ReadableStream data through executeUpload', async () => {
      const uploadSpy = vi.spyOn(mockSynapse.storage, 'upload')
      const data = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]))
          controller.close()
        },
      })

      await executeUpload(mockSynapse as any, data, TEST_CID, {
        logger,
        ipniValidation: { enabled: false },
      })

      expect(uploadSpy).toHaveBeenCalledWith(data, expect.anything())
    })
  })

  describe('source metadata resolution', () => {
    let mockSynapse: MockSynapse
    let logger: Logger

    beforeEach(async () => {
      logger = createLogger({ logLevel: 'info' })
      mockSynapse = new MockSynapse()
      await mockSynapse.createStorageContext()
      vi.clearAllMocks()
    })

    it('injects filecoin-pin source when no caller source exists', async () => {
      const uploadSpy = vi.spyOn(mockSynapse.storage, 'upload')
      mockSynapse.storage.source = null

      await uploadToSynapse(mockSynapse as any, new Uint8Array([1]), TEST_CID, logger)

      const metadata = uploadSpy.mock.calls[0]?.[1]?.metadata
      expect(metadata?.[METADATA_KEYS.SOURCE]).toBe(APPLICATION_SOURCE)
      expect(metadata?.[METADATA_KEYS.WITH_IPFS_INDEXING]).toBe('')
    })

    it('does not inject source when Synapse instance has one', async () => {
      const uploadSpy = vi.spyOn(mockSynapse.storage, 'upload')
      mockSynapse.storage.source = 'dealbot'

      await uploadToSynapse(mockSynapse as any, new Uint8Array([1]), TEST_CID, logger)

      const metadata = uploadSpy.mock.calls[0]?.[1]?.metadata
      expect(metadata?.[METADATA_KEYS.SOURCE]).toBeUndefined()
      expect(metadata?.[METADATA_KEYS.WITH_IPFS_INDEXING]).toBe('')
    })

    it('does not inject source when caller metadata has one', async () => {
      const uploadSpy = vi.spyOn(mockSynapse.storage, 'upload')
      mockSynapse.storage.source = null

      await uploadToSynapse(mockSynapse as any, new Uint8Array([1]), TEST_CID, logger, {
        metadata: { [METADATA_KEYS.SOURCE]: 'myapp' },
      })

      const metadata = uploadSpy.mock.calls[0]?.[1]?.metadata
      expect(metadata?.[METADATA_KEYS.SOURCE]).toBe('myapp')
      expect(metadata?.[METADATA_KEYS.WITH_IPFS_INDEXING]).toBe('')
    })

    it('does not inject source when context carries one', async () => {
      const uploadSpy = vi.spyOn(mockSynapse.storage, 'upload')
      mockSynapse.storage.source = null
      const ctxWithSource = { dataSetMetadata: { [METADATA_KEYS.SOURCE]: 'ctx-app' } } as any

      await uploadToSynapse(mockSynapse as any, new Uint8Array([1]), TEST_CID, logger, {
        contexts: [ctxWithSource],
      })

      const metadata = uploadSpy.mock.calls[0]?.[1]?.metadata
      expect(metadata?.[METADATA_KEYS.SOURCE]).toBeUndefined()
    })

    it('caller metadata source overrides filecoin-pin default', async () => {
      const uploadSpy = vi.spyOn(mockSynapse.storage, 'upload')
      mockSynapse.storage.source = null

      await uploadToSynapse(mockSynapse as any, new Uint8Array([1]), TEST_CID, logger, {
        metadata: { [METADATA_KEYS.SOURCE]: 'custom' },
      })

      const metadata = uploadSpy.mock.calls[0]?.[1]?.metadata
      expect(metadata?.[METADATA_KEYS.SOURCE]).toBe('custom')
    })

    it('always includes withIPFSIndexing regardless of source', async () => {
      const uploadSpy = vi.spyOn(mockSynapse.storage, 'upload')
      mockSynapse.storage.source = 'whatever'

      await uploadToSynapse(mockSynapse as any, new Uint8Array([1]), TEST_CID, logger, {
        metadata: { custom: 'value' },
      })

      const metadata = uploadSpy.mock.calls[0]?.[1]?.metadata
      expect(metadata?.[METADATA_KEYS.WITH_IPFS_INDEXING]).toBe('')
      expect(metadata?.custom).toBe('value')
    })
  })
})
