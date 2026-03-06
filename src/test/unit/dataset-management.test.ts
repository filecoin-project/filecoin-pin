/**
 * Tests for dataset management via Synapse SDK integration
 *
 * Verifies that initializeSynapse produces a Synapse instance whose
 * storage.createContext() can be called with various options for
 * dataset selection, creation, and metadata.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initializeSynapse, type SynapseSetupConfig } from '../../core/synapse/index.js'
import { createLogger } from '../../logger.js'

// Mock the Synapse SDK
vi.mock('@filoz/synapse-sdk', async () => await import('../mocks/synapse-sdk.js'))

describe('Dataset Management', () => {
  let config: SynapseSetupConfig
  let logger: ReturnType<typeof createLogger>

  beforeEach(() => {
    config = {
      privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
      rpcUrl: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1',
    }
    logger = createLogger({ logLevel: 'info' })
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('Storage context creation', () => {
    it('should create a storage context with default options', async () => {
      const synapse = await initializeSynapse(config, logger)
      const storage = await synapse.storage.createContext({})

      expect(storage).toBeDefined()
      expect(storage.dataSetId).toBeDefined()
      expect(storage.provider).toBeDefined()
    })

    it('should pass dataSetId to createContext', async () => {
      const synapse = await initializeSynapse(config, logger)
      const createContextSpy = vi.spyOn(synapse.storage, 'createContext')

      await synapse.storage.createContext({ dataSetId: 456n })

      expect(createContextSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          dataSetId: 456n,
        })
      )
    })

    it('should pass metadata to createContext', async () => {
      const synapse = await initializeSynapse(config, logger)
      const createContextSpy = vi.spyOn(synapse.storage, 'createContext')

      await synapse.storage.createContext({
        metadata: {
          userId: 'user-123',
          sessionId: 'session-456',
        },
      })

      expect(createContextSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            userId: 'user-123',
            sessionId: 'session-456',
          }),
        })
      )
    })

    it('should return provider info from storage context', async () => {
      const synapse = await initializeSynapse(config, logger)
      const storage = await synapse.storage.createContext({})

      expect(storage.provider).toBeDefined()
      expect(storage.provider.id).toBe(1n)
      expect(storage.provider.name).toBe('Mock Provider')
      expect(storage.provider.pdp?.serviceURL).toBe('http://localhost:8888/pdp')
    })
  })
})
