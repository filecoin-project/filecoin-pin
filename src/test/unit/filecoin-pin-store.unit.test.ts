import { mkdir, rm, writeFile } from 'node:fs/promises'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConfig } from '../../config.js'
import { FilecoinPinStore } from '../../filecoin-pin-store.js'
import { createLogger } from '../../logger.js'

const mocks = vi.hoisted(() => ({
  createPinningHeliaNode: vi.fn(),
  uploadToSynapse: vi.fn(),
  unlink: vi.fn().mockResolvedValue(undefined),
}))

// Minimal mock since unit tests don't test background processing
const mockSynapse = {} as any

// Mock the heavy dependencies
vi.mock('../../create-pinning-helia.js', () => ({
  createPinningHeliaNode: mocks.createPinningHeliaNode,
}))

vi.mock('../../core/upload/index.js', () => ({
  uploadToSynapse: mocks.uploadToSynapse,
}))

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    unlink: mocks.unlink,
  }
})

describe('FilecoinPinStore (Unit)', () => {
  let pinStore: FilecoinPinStore
  let testCID: CID
  let testUser: any
  let mockHelia: {
    pins: { add: ReturnType<typeof vi.fn> }
    stop: ReturnType<typeof vi.fn>
    blockstore: { get: ReturnType<typeof vi.fn> }
  }
  let mockBlockstore: {
    on: ReturnType<typeof vi.fn>
    getStats: ReturnType<typeof vi.fn>
    finalize: ReturnType<typeof vi.fn>
    cleanup: ReturnType<typeof vi.fn>
  }

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.clearAllMocks()

    // Create test data
    const testBlock = new TextEncoder().encode('Test block')
    const hash = await sha256.digest(testBlock)
    testCID = CID.create(1, raw.code, hash)
    testUser = { id: 'test-user', name: 'Test User' }

    mockHelia = {
      blockstore: {
        get: vi.fn(),
      },
      pins: {
        add: vi.fn(async function* () {
          // No pinned blocks are yielded in this unit-test mock.
        }),
      },
      stop: vi.fn().mockResolvedValue(undefined),
    }

    mockBlockstore = {
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
      cleanup: vi.fn().mockResolvedValue(undefined),
    }

    await mkdir('./test-output', { recursive: true })

    mocks.createPinningHeliaNode.mockImplementation(async ({ outputPath }: { outputPath: string }) => {
      await writeFile(outputPath, new Uint8Array([1, 2, 3]))
      return {
        helia: mockHelia,
        blockstore: mockBlockstore,
      }
    })

    mocks.uploadToSynapse.mockResolvedValue({
      pieceCid: 'bafkzcibtest1234567890',
      size: 3,
      requestedCopies: 1,
      complete: true,
      copies: [
        {
          providerId: 1n,
          dataSetId: 123n,
          pieceId: 789n,
          role: 'primary',
          retrievalUrl: 'https://provider.example/piece/test',
          isNewDataSet: false,
        },
      ],
      failedAttempts: [],
    })

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
      synapse: mockSynapse,
    })

    await pinStore.start()
  })

  afterEach(async () => {
    vi.clearAllTimers()
    await pinStore.stop()
    await rm('./test-output', { recursive: true, force: true })
    vi.useRealTimers()
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

    it('streams the finalized CAR file into Synapse upload', async () => {
      vi.useFakeTimers()

      const pinResult = await pinStore.pin(testUser, testCID, { name: 'Streaming Test' })

      await vi.advanceTimersByTimeAsync(100)
      await vi.waitFor(async () => {
        expect((await pinStore.get(testUser, pinResult.id))?.status).toBe('pinned')
      })

      const uploadCall = mocks.uploadToSynapse.mock.calls.find((call) => call[4]?.contextId === pinResult.id)
      const uploadData = uploadCall?.[1]
      const finalPin = await pinStore.get(testUser, pinResult.id)

      expect(uploadData).toBeInstanceOf(ReadableStream)
      expect(uploadCall).toEqual([
        mockSynapse,
        expect.any(ReadableStream),
        testCID,
        expect.anything(),
        expect.objectContaining({
          contextId: pinResult.id,
        }),
      ])
      expect(finalPin?.status).toBe('pinned')
    })

    it('preserves rollback cleanup when Synapse upload fails', async () => {
      vi.useFakeTimers()
      mocks.uploadToSynapse.mockRejectedValueOnce(new Error('upload failed'))

      const pinResult = await pinStore.pin(testUser, testCID, { name: 'Failure Test' })

      await vi.advanceTimersByTimeAsync(100)
      await vi.waitFor(async () => {
        expect((await pinStore.get(testUser, pinResult.id))?.status).toBe('failed')
      })

      const finalPin = await pinStore.get(testUser, pinResult.id)
      const uploadCall = mocks.uploadToSynapse.mock.calls.find((call) => call[4]?.contextId === pinResult.id)

      expect(finalPin?.status).toBe('failed')
      expect(uploadCall?.[1]).toBeInstanceOf(ReadableStream)
      expect(mockBlockstore.cleanup).toHaveBeenCalledTimes(1)
      expect(mocks.unlink).toHaveBeenCalledWith(expect.stringContaining(`${testCID.toString()}-`))
      expect(mockHelia.stop).toHaveBeenCalledTimes(1)
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
        synapse: mockSynapse,
      })

      await expect(newPinStore.start()).resolves.not.toThrow()
      await expect(newPinStore.stop()).resolves.not.toThrow()
    })
  })
})
