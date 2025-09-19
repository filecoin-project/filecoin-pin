import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createConfig } from '../../config.js'
import { FilecoinPinStore } from '../../filecoin-pin-store.js'
import { createLogger } from '../../logger.js'

// Mock Synapse service - minimal mock since unit tests don't test background processing
const mockSynapseService = {
  synapse: {} as any,
  storage: {} as any,
  providerInfo: {
    id: 1,
    name: 'Mock Provider',
    serviceProvider: '0x1234567890123456789012345678901234567890',
  } as any,
}

// Mock the heavy dependencies
vi.mock('../../create-pinning-helia.js', () => ({
  createPinningHeliaNode: vi.fn().mockResolvedValue({
    helia: {
      blockstore: {
        get: vi.fn(),
      },
      pins: {
        add: vi.fn(),
      },
      stop: vi.fn(),
    },
    blockstore: {
      on: vi.fn(),
      getStats: vi.fn().mockReturnValue({
        blocksWritten: 1,
        missingBlocks: new Set(),
        totalSize: 100,
        startTime: Date.now(),
        finalized: false,
      }),
      finalize: vi.fn().mockResolvedValue({
        blocksWritten: 1,
        missingBlocks: new Set(),
        totalSize: 100,
        startTime: Date.now(),
        finalized: true,
      }),
      cleanup: vi.fn(),
    },
  }),
}))

describe('FilecoinPinStore (Unit)', () => {
  let pinStore: FilecoinPinStore
  let testCID: CID
  let testUser: any

  beforeEach(async () => {
    // Create test data
    const testBlock = new TextEncoder().encode('Test block')
    const hash = await sha256.digest(testBlock)
    testCID = CID.create(1, raw.code, hash)
    testUser = { id: 'test-user', name: 'Test User' }

    // Create test config
    const config = {
      ...createConfig(),
      carStoragePath: './test-output',
      privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001', // Fake test key
    }
    const logger = createLogger(config)

    // Create pin store
    pinStore = new FilecoinPinStore({
      config,
      logger,
      synapseService: mockSynapseService,
    })

    await pinStore.start()
  })

  describe('Pin Operations', () => {
    it('should create a pin with queued status immediately', async () => {
      const pinResult = await pinStore.pin(testUser, testCID, {
        name: 'Test Pin',
        meta: { test: 'metadata' },
      })

      expect(pinResult).toBeDefined()
      expect(pinResult.id).toBeDefined()
      expect(pinResult.status).toBe('queued')
      expect(pinResult.pin.cid).toBe(testCID.toString())
      expect(pinResult.pin.name).toBe('Test Pin')
      expect(pinResult.filecoin).toBeDefined()
      expect(pinResult.filecoin?.carFilePath).toContain(testCID.toString())
    })

    it('should handle pin updates synchronously', async () => {
      const pinResult = await pinStore.pin(testUser, testCID, { name: 'Original' })

      const updated = await pinStore.update(testUser, pinResult.id, {
        name: 'Updated Name',
        meta: { updated: 'true' },
      })

      expect(updated).toBeDefined()
      expect(updated?.pin.name).toBe('Updated Name')
      expect(updated?.pin.meta?.updated).toBe('true')
    })

    it('should retrieve pin by ID', async () => {
      const pinResult = await pinStore.pin(testUser, testCID, { name: 'Test' })

      const retrieved = await pinStore.get(testUser, pinResult.id)

      expect(retrieved).toBeDefined()
      expect(retrieved?.id).toBe(pinResult.id)
      expect(retrieved?.pin.cid).toBe(testCID.toString())
    })

    it('should cancel pins', async () => {
      const pinResult = await pinStore.pin(testUser, testCID, { name: 'Cancel Test' })

      await pinStore.cancel(testUser, pinResult.id)

      const retrieved = await pinStore.get(testUser, pinResult.id)
      expect(retrieved).toBeUndefined()
    })

    it('should list pins with filters', async () => {
      const pin1 = await pinStore.pin(testUser, testCID, { name: 'Pin 1' })

      const hash2 = await sha256.digest(new TextEncoder().encode('second'))
      const cid2 = CID.create(1, raw.code, hash2)
      const pin2 = await pinStore.pin(testUser, cid2, { name: 'Pin 2' })

      // List all
      const listAll = await pinStore.list(testUser)
      expect(listAll.count).toBe(2)
      expect(listAll.results).toHaveLength(2)

      // List by CID
      const listByCid = await pinStore.list(testUser, { cid: testCID.toString() })
      expect(listByCid.count).toBe(1)
      expect(listByCid.results[0]?.id).toBe(pin1.id)

      // List by name
      const listByName = await pinStore.list(testUser, { name: 'Pin 2' })
      expect(listByName.count).toBe(1)
      expect(listByName.results[0]?.id).toBe(pin2.id)

      // List with limit
      const listWithLimit = await pinStore.list(testUser, { limit: 1 })
      expect(listWithLimit.results).toHaveLength(1)
    })
  })

  describe('Statistics', () => {
    it('should start with empty active pins', () => {
      const stats = pinStore.getActivePinStats()
      expect(stats).toHaveLength(0)
    })
  })

  describe('Lifecycle', () => {
    it('should handle start/stop', async () => {
      const config = {
        ...createConfig(),
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001', // Fake test key
      }

      const newPinStore = new FilecoinPinStore({
        config,
        logger: createLogger(config),
        synapseService: mockSynapseService,
      })

      await expect(newPinStore.start()).resolves.not.toThrow()
      await expect(newPinStore.stop()).resolves.not.toThrow()
    })
  })
})
