/**
 * Tests for dataset management in multi-tenant scenarios
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConfig } from '../../config.js'
import {
  createStorageContext,
  initializeSynapse,
  resetSynapseService,
  type SynapseSetupConfig,
  setupSynapse,
} from '../../core/synapse/index.js'
import { createLogger } from '../../logger.js'

// Mock the Synapse SDK
vi.mock('@filoz/synapse-sdk', async () => await import('../mocks/synapse-sdk.js'))

describe('Dataset Management', () => {
  let config: SynapseSetupConfig
  let logger: ReturnType<typeof createLogger>

  beforeEach(() => {
    config = {
      ...createConfig(),
      privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
      rpcUrl: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1',
    }
    logger = createLogger(config)
    resetSynapseService()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('Default behavior (reuse dataset)', () => {
    it('should reuse existing dataset by default', async () => {
      const service = await setupSynapse(config, logger)

      expect(service.storage).toBeDefined()
      expect(service.storage.dataSetId).toBeDefined()
    })

    it('should not force create dataset without explicit option', async () => {
      const synapse = await initializeSynapse(config, logger)
      const createContextSpy = vi.spyOn(synapse.storage, 'createContext')

      await createStorageContext(synapse, logger)

      // Should NOT have forceCreateDataSet or dataSetId set
      const callArgs = createContextSpy.mock.calls[0]?.[0]
      expect(callArgs).toBeDefined()
      expect(callArgs?.forceCreateDataSet).toBeUndefined()
      expect(callArgs?.dataSetId).toBeUndefined()
    })
  })

  describe('Create new dataset (multi-user scenario)', () => {
    it('should force create new dataset when createNew is true', async () => {
      const synapse = await initializeSynapse(config, logger)
      const createContextSpy = vi.spyOn(synapse.storage, 'createContext')

      await createStorageContext(synapse, logger, {
        dataset: { createNew: true },
      })

      expect(createContextSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          forceCreateDataSet: true,
        })
      )
    })

    it('should create new dataset via setupSynapse', async () => {
      const service = await setupSynapse(config, logger, {
        dataset: { createNew: true },
      })

      expect(service.storage).toBeDefined()
      expect(service.storage.dataSetId).toBeDefined()
    })

    it('should log dataset creation', async () => {
      const infoSpy = vi.spyOn(logger, 'info')
      const synapse = await initializeSynapse(config, logger)

      await createStorageContext(synapse, logger, {
        dataset: { createNew: true },
      })

      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'synapse.storage.dataset.create_new',
        }),
        'Forcing creation of new dataset'
      )
    })

    it('should support custom metadata for new datasets', async () => {
      const synapse = await initializeSynapse(config, logger)
      const createContextSpy = vi.spyOn(synapse.storage, 'createContext')

      await createStorageContext(synapse, logger, {
        dataset: {
          createNew: true,
          metadata: {
            userId: 'user-123',
            sessionId: 'session-456',
          },
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
  })

  describe('Connect to existing dataset', () => {
    it('should connect to specific dataset by ID', async () => {
      const synapse = await initializeSynapse(config, logger)
      const createContextSpy = vi.spyOn(synapse.storage, 'createContext')
      const datasetId = 456

      await createStorageContext(synapse, logger, {
        dataset: { useExisting: datasetId },
      })

      expect(createContextSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          dataSetId: datasetId,
        })
      )
    })

    it('should log connection to existing dataset', async () => {
      const infoSpy = vi.spyOn(logger, 'info')
      const synapse = await initializeSynapse(config, logger)
      const datasetId = 789

      await createStorageContext(synapse, logger, {
        dataset: { useExisting: datasetId },
      })

      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'synapse.storage.dataset.existing',
          dataSetId: datasetId,
        }),
        'Connecting to existing dataset'
      )
    })

    it('useExisting should take precedence over createNew', async () => {
      const synapse = await initializeSynapse(config, logger)
      const createContextSpy = vi.spyOn(synapse.storage, 'createContext')
      const datasetId = 999

      await createStorageContext(synapse, logger, {
        dataset: {
          useExisting: datasetId,
          createNew: true, // This should be ignored
        },
      })

      // Should have dataSetId set but NOT forceCreateDataSet
      const callArgs = createContextSpy.mock.calls[0]?.[0]
      expect(callArgs).toBeDefined()
      expect(callArgs?.dataSetId).toBe(datasetId)
      expect(callArgs?.forceCreateDataSet).toBeUndefined()
    })
  })

  describe('Progress callbacks', () => {
    it('should call onDataSetResolved callback', async () => {
      const onDataSetResolved = vi.fn()
      const synapse = await initializeSynapse(config, logger)

      await createStorageContext(synapse, logger, {
        callbacks: { onDataSetResolved },
      })

      // Mock SDK fires this callback, our wrapper should pass it through
      expect(onDataSetResolved).toHaveBeenCalledWith(
        expect.objectContaining({
          dataSetId: expect.any(Number),
          isExisting: expect.any(Boolean),
        })
      )
    })

    it('should call onProviderSelected callback', async () => {
      const onProviderSelected = vi.fn()
      const synapse = await initializeSynapse(config, logger)

      await createStorageContext(synapse, logger, {
        callbacks: { onProviderSelected },
      })

      expect(onProviderSelected).toHaveBeenCalledWith(
        expect.objectContaining({
          id: expect.any(Number),
          serviceProvider: expect.any(String),
        })
      )
    })
  })
})
