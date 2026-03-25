import { CID } from 'multiformats/cid'
import type { Logger } from 'pino'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  })
})
