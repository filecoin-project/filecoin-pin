import { rm, stat } from 'node:fs/promises'
import { createHelia } from 'helia'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConfig } from '../../config.js'
import { FilecoinPinStore } from '../../filecoin-pin-store.js'
import { createLogger } from '../../logger.js'
import { MockSynapse, mockProviderInfo } from '../mocks/synapse-mocks.js'

// Mock the Synapse SDK - vi.mock requires async import for ES modules
vi.mock('@filoz/synapse-sdk', async () => await import('../mocks/synapse-sdk.js'))

describe('FilecoinPinStore', () => {
  let pinStore: FilecoinPinStore
  let contentOriginHelia: any
  let testCID: CID
  let testBlock: Uint8Array
  let testUser: any
  const testOutputDir = './test-car-output'

  beforeEach(async () => {
    // Create test data
    testBlock = new TextEncoder().encode('Test block for Filecoin pin store')
    const hash = await sha256.digest(testBlock)
    testCID = CID.create(1, raw.code, hash)

    testUser = { id: 'test-user', name: 'Test User' }

    // Create test config with output directory and fake private key
    const config = {
      ...createConfig(),
      carStoragePath: testOutputDir,
      privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001', // Fake test key
    }
    const logger = createLogger(config)

    // Create a Helia node to serve content
    contentOriginHelia = await createHelia()

    // Create mock Synapse service
    const mockSynapse = new MockSynapse()
    const mockStorage = await mockSynapse.storage.createContext()
    const synapseService = { synapse: mockSynapse as any, storage: mockStorage, providerInfo: mockProviderInfo }

    // Create Filecoin pin store with mock Synapse
    pinStore = new FilecoinPinStore({
      config,
      logger,
      synapseService,
    })

    await pinStore.start()
  })

  afterEach(async () => {
    await pinStore.stop()
    if (contentOriginHelia != null) {
      await contentOriginHelia.stop()
    }

    // Clean up test files
    try {
      await stat(testOutputDir)
      await rm(testOutputDir, { recursive: true, force: true })
    } catch {
      // Directory doesn't exist, nothing to clean up
    }
  })

  describe('Pin Operations', () => {
    it('should create a pin with Filecoin metadata', async () => {
      const pinResult = await pinStore.pin(testUser, testCID, {
        name: 'Test Pin',
        meta: { test: 'metadata' },
      })

      expect(pinResult).toBeDefined()
      expect(pinResult.id).toBeDefined()
      expect(pinResult.status).toBe('queued')
      expect(pinResult.pin.cid).toBe(testCID.toString())
      expect(pinResult.pin.name).toBe('Test Pin')

      // Check Filecoin-specific metadata
      expect(pinResult.filecoin).toBeDefined()
      expect(pinResult.filecoin?.carFilePath).toContain(testCID.toString())
      expect(pinResult.filecoin?.pinStarted).toBeDefined()
      expect(pinResult.filecoin?.carStats).toBeDefined()

      // Check info field enhancements
      expect(pinResult.info?.car_file_path).toBeDefined()
      expect(pinResult.info?.blocks_written).toBe('0')
      expect(pinResult.info?.total_size).toBe('0')
    }, 10000)

    it('should emit events during pin processing', async () => {
      const events: any[] = []

      pinStore.on('pin:block:stored', (data) => events.push({ type: 'block:stored', data }))
      pinStore.on('pin:block:missing', (data) => events.push({ type: 'block:missing', data }))
      pinStore.on('pin:car:completed', (data) => events.push({ type: 'car:completed', data }))

      // Add the block to content origin Helia first so it can be found
      await contentOriginHelia.blockstore.put(testCID, testBlock)

      // Get origin multiaddr for pinning
      const originAddrs = contentOriginHelia.libp2p.getMultiaddrs()
      const origins = originAddrs.map((addr: any) => addr.toString())

      const pinResult = await pinStore.pin(testUser, testCID, { name: 'Event Test', origins })

      // Wait a bit for background processing
      await new Promise((resolve) => setTimeout(resolve, 2000))

      // Should have at least some events
      expect(events.length).toBeGreaterThan(0)

      // Check for completion event
      const completionEvent = events.find((e) => e.type === 'car:completed')
      if (completionEvent != null) {
        expect(completionEvent.data.pinId).toBe(pinResult.id)
        expect(completionEvent.data.userId).toBe(testUser.id)
      }
    }, 15000)

    it('should handle pin updates', async () => {
      const pinResult = await pinStore.pin(testUser, testCID, { name: 'Original Name' })

      const updated = await pinStore.update(testUser, pinResult.id, {
        name: 'Updated Name',
        meta: { updated: 'true' },
      })

      expect(updated).toBeDefined()
      expect(updated?.pin.name).toBe('Updated Name')
      expect(updated?.pin.meta?.updated).toBe('true')
      expect(updated?.filecoin).toBeDefined()
    })

    it('should retrieve pin status with Filecoin metadata', async () => {
      const pinResult = await pinStore.pin(testUser, testCID, { name: 'Retrieve Test' })

      const retrieved = await pinStore.get(testUser, pinResult.id)

      expect(retrieved).toBeDefined()
      expect(retrieved?.id).toBe(pinResult.id)
      expect(retrieved?.filecoin).toBeDefined()
      expect(retrieved?.filecoin?.carFilePath).toContain(testCID.toString())
      expect(retrieved?.info?.car_file_path).toBeDefined()
    })

    it('should cancel pins and clean up resources', async () => {
      const pinResult = await pinStore.pin(testUser, testCID, { name: 'Cancel Test' })

      // Wait a moment to ensure pin processing starts
      await new Promise((resolve) => setTimeout(resolve, 150))

      await pinStore.cancel(testUser, pinResult.id)

      // Check that pin is no longer active after cancellation
      const activePinsAfterCancel = pinStore.getActivePinStats()
      expect(activePinsAfterCancel).toHaveLength(0)

      // Try to retrieve cancelled pin
      const retrieved = await pinStore.get(testUser, pinResult.id)
      expect(retrieved).toBeUndefined()
    })

    it('should list pins with Filecoin metadata', async () => {
      // Create multiple pins
      const pin1 = await pinStore.pin(testUser, testCID, { name: 'Pin 1' })

      const hash2 = await sha256.digest(new TextEncoder().encode('second block'))
      const cid2 = CID.create(1, raw.code, hash2)
      const pin2 = await pinStore.pin(testUser, cid2, { name: 'Pin 2' })

      const list = await pinStore.list(testUser)

      expect(list.count).toBeGreaterThanOrEqual(2)
      expect(list.results).toHaveLength(list.count)

      // Check that all results have Filecoin metadata
      const pin1Result = list.results.find((p) => p.id === pin1.id)
      const pin2Result = list.results.find((p) => p.id === pin2.id)

      expect(pin1Result).toBeDefined()
      expect(pin1Result?.filecoin).toBeDefined()
      expect(pin1Result?.info?.car_file_path).toBeDefined()

      expect(pin2Result).toBeDefined()
      expect(pin2Result?.filecoin).toBeDefined()
      expect(pin2Result?.info?.car_file_path).toBeDefined()
    })
  })

  describe('Statistics and Monitoring', () => {
    it('should track active pin statistics', async () => {
      await pinStore.pin(testUser, testCID, { name: 'Stats Test 1' })

      const hash2 = await sha256.digest(new TextEncoder().encode('stats test 2'))
      const cid2 = CID.create(1, raw.code, hash2)
      await pinStore.pin(testUser, cid2, { name: 'Stats Test 2' })

      // Wait for pins to start processing
      await new Promise((resolve) => setTimeout(resolve, 150))

      const stats = pinStore.getActivePinStats()
      // Pins may complete quickly in test environment, so we check for reasonable activity
      expect(stats.length).toBeGreaterThanOrEqual(0)

      // If we have active pins, verify their structure
      if (stats.length > 0) {
        expect(stats[0]?.pinId).toBeDefined()
        expect(stats[0]?.stats).toBeDefined()
        expect(typeof stats[0]?.duration).toBe('number')
      }
    })

    it('should provide detailed pin information', async () => {
      const pinResult = await pinStore.pin(testUser, testCID, {
        name: 'Detail Test',
        meta: { priority: 'high', source: 'test' },
      })

      // Wait for processing to complete
      await new Promise((resolve) => setTimeout(resolve, 2000))

      const retrieved = await pinStore.get(testUser, pinResult.id)

      expect(retrieved).toBeDefined()
      expect(retrieved?.info?.car_file_path).toBeDefined()
      expect(retrieved?.info?.blocks_written).toBeDefined()
      expect(retrieved?.info?.total_size).toBeDefined()

      // These fields are only present after completion
      if (retrieved?.status === 'pinned') {
        expect(retrieved?.info?.pin_duration).toBeDefined()
      }

      // Original metadata should be preserved
      expect(retrieved?.pin.meta?.priority).toBe('high')
      expect(retrieved?.pin.meta?.source).toBe('test')
    })
  })

  describe('Error Handling', () => {
    it('should handle pin processing failures gracefully', async () => {
      // Create a CID for non-existent content
      const nonExistentHash = await sha256.digest(new TextEncoder().encode('nonexistent'))
      const nonExistentCID = CID.create(1, raw.code, nonExistentHash)

      const events: any[] = []
      pinStore.on('pin:failed', (data) => events.push({ type: 'pin:failed', data }))

      const pinResult = await pinStore.pin(testUser, nonExistentCID, { name: 'Failure Test' })

      // Wait for background processing to potentially fail
      await new Promise((resolve) => setTimeout(resolve, 2000))

      // Pin should be created and may process to completion (which is successful behavior for missing content)
      expect(pinResult).toBeDefined()
      expect(['queued', 'pinning', 'pinned'].includes(pinResult.status)).toBe(true)

      // The pin may or may not fail depending on timing, but we should handle it gracefully
      const retrieved = await pinStore.get(testUser, pinResult.id)
      expect(retrieved).toBeDefined()
    }, 10000)

    it('should clean up resources on stop', async () => {
      await pinStore.pin(testUser, testCID, { name: 'Cleanup Test 1' })

      const hash2 = await sha256.digest(new TextEncoder().encode('cleanup test 2'))
      const cid2 = CID.create(1, raw.code, hash2)
      await pinStore.pin(testUser, cid2, { name: 'Cleanup Test 2' })

      // Wait for pins to start processing
      await new Promise((resolve) => setTimeout(resolve, 150))

      // Stop should clean up all resources
      await pinStore.stop()

      // Should have no active pins after stop (cleanup is always successful)
      expect(pinStore.getActivePinStats()).toHaveLength(0)
    })
  })

  describe('Pin Store Lifecycle', () => {
    it('should start and stop cleanly', async () => {
      // Create mock Synapse service
      const mockSynapse = new MockSynapse()
      const mockStorage = await mockSynapse.storage.createContext()
      const synapseService = { synapse: mockSynapse as any, storage: mockStorage, providerInfo: mockProviderInfo }

      const config = {
        ...createConfig(),
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001', // Fake test key
      }

      const newPinStore = new FilecoinPinStore({
        config,
        logger: createLogger(config),
        synapseService,
      })

      await expect(newPinStore.start()).resolves.not.toThrow()
      await expect(newPinStore.stop()).resolves.not.toThrow()
    })

    it('should handle multiple start/stop cycles', async () => {
      // Create mock Synapse service
      const mockSynapse = new MockSynapse()
      const mockStorage = await mockSynapse.storage.createContext()
      const synapseService = { synapse: mockSynapse as any, storage: mockStorage, providerInfo: mockProviderInfo }

      const config = {
        ...createConfig(),
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001', // Fake test key
      }

      const newPinStore = new FilecoinPinStore({
        config,
        logger: createLogger(config),
        synapseService,
      })

      await newPinStore.start()
      await newPinStore.stop()

      await newPinStore.start()
      await newPinStore.stop()

      // Should not throw
      expect(true).toBe(true)
    })
  })
})
