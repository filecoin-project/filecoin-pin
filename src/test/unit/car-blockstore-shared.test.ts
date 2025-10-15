import { readFile, rm, stat } from 'node:fs/promises'
import toBuffer from 'it-to-buffer'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CARWritingBlockstore as BrowserCARBlockstore } from '../../core/car/browser-car-blockstore.js'
import { CARWritingBlockstore as NodeCARBlockstore } from '../../core/car/car-blockstore.js'
import type { CARBlockstoreBase } from '../../core/car/car-blockstore-base.js'

interface BlockstoreFactory {
  create(rootCID: CID): CARBlockstoreBase | NodeCARBlockstore | BrowserCARBlockstore
  cleanup(): Promise<void>
  hasEvents: boolean
  hasFileOutput: boolean
  hasBrowserAPI: boolean
  supportsReading: boolean // Can read blocks back after writing
  name: string
}

const testOutputPath = './test-output-shared.car'

const factories: BlockstoreFactory[] = [
  {
    name: 'Node.js (file-based)',
    hasEvents: true,
    hasFileOutput: true,
    hasBrowserAPI: false,
    supportsReading: true,
    create: (rootCID: CID) =>
      new NodeCARBlockstore({
        rootCID,
        outputPath: testOutputPath,
      }),
    cleanup: async () => {
      try {
        await stat(testOutputPath)
        await rm(testOutputPath)
      } catch {
        // File doesn't exist
      }
    },
  },
  {
    name: 'Browser (in-memory)',
    hasEvents: false,
    hasFileOutput: false,
    hasBrowserAPI: true,
    supportsReading: false, // Browser version is write-only
    create: (rootCID: CID) =>
      new BrowserCARBlockstore({
        rootCID,
      }),
    cleanup: async () => {
      // No cleanup needed for in-memory
    },
  },
]

describe.each(factories)('CARWritingBlockstore - $name', (factory) => {
  let blockstore: CARBlockstoreBase | NodeCARBlockstore | BrowserCARBlockstore
  let testCID: CID
  let testBlock: Uint8Array

  beforeEach(async () => {
    // Create a test block and CID
    testBlock = new TextEncoder().encode('Hello, IPFS!')
    const hash = await sha256.digest(testBlock)
    testCID = CID.create(1, raw.code, hash)

    blockstore = factory.create(testCID)
  })

  afterEach(async () => {
    await blockstore.cleanup()
    await factory.cleanup()
    // Add a small delay to ensure file operations complete
    await new Promise((resolve) => setTimeout(resolve, 10))
  })

  describe('Initialization', () => {
    it('should initialize with root CID', () => {
      expect(blockstore).toBeDefined()
      const stats = blockstore.getStats()
      expect(stats.blocksWritten).toBe(0)
      expect(stats.totalSize).toBe(0)
      expect(stats.finalized).toBe(false)
    })

    it.skipIf(!factory.hasEvents)('should emit initialized event', async () => {
      let eventData: any
      ;(blockstore as NodeCARBlockstore).on('initialized', (data) => {
        eventData = data
      })

      await blockstore.initialize()

      expect(eventData).toBeDefined()
      expect(eventData.rootCID).toEqual(testCID)
      expect(eventData.outputPath).toBe(testOutputPath)
    })
  })

  describe('Block Operations', () => {
    it('should put a block and update statistics', async () => {
      const returnedCID = await blockstore.put(testCID, testBlock)

      expect(returnedCID).toEqual(testCID)

      const stats = blockstore.getStats()
      expect(stats.blocksWritten).toBe(1)
      expect(stats.totalSize).toBe(testBlock.length)
    })

    it.skipIf(!factory.hasEvents)('should emit block:stored event when putting blocks', async () => {
      let eventData: any
      ;(blockstore as NodeCARBlockstore).on('block:stored', (data) => {
        eventData = data
      })

      await blockstore.put(testCID, testBlock)

      expect(eventData).toBeDefined()
      expect(eventData.cid).toEqual(testCID)
      expect(eventData.size).toBe(testBlock.length)
    })

    it.skipIf(!factory.supportsReading)('should get a block that was previously put', async () => {
      await blockstore.put(testCID, testBlock)

      // Allow filesystem to settle after write
      await new Promise((resolve) => setTimeout(resolve, 50))

      const result = await toBuffer(blockstore.get(testCID))
      expect(result).toEqual(testBlock)
    })

    it('should throw error when getting non-existent block', async () => {
      const nonExistentHash = await sha256.digest(new TextEncoder().encode('nonexistent'))
      const nonExistentCID = CID.create(1, raw.code, nonExistentHash)

      await expect(async () => {
        for await (const _ of blockstore.get(nonExistentCID)) {
          // Should not reach here
        }
      }).rejects.toThrow('Block not found')
    })

    it.skipIf(!factory.hasEvents)('should emit block:missing event for missing blocks', async () => {
      let eventData: any
      ;(blockstore as NodeCARBlockstore).on('block:missing', (data) => {
        eventData = data
      })

      const nonExistentHash = await sha256.digest(new TextEncoder().encode('nonexistent'))
      const nonExistentCID = CID.create(1, raw.code, nonExistentHash)

      try {
        for await (const _ of blockstore.get(nonExistentCID)) {
          // Should not reach here
        }
      } catch (_error) {
        // Expected to throw
      }

      expect(eventData).toBeDefined()
      expect(eventData.cid).toEqual(nonExistentCID)

      const stats = blockstore.getStats()
      expect(stats.missingBlocks.has(nonExistentCID.toString())).toBe(true)
    })

    it('should check if block exists', async () => {
      expect(await blockstore.has(testCID)).toBe(false)

      await blockstore.put(testCID, testBlock)
      expect(await blockstore.has(testCID)).toBe(true)
    })

    it('should throw error when trying to delete blocks', async () => {
      await blockstore.put(testCID, testBlock)
      expect(await blockstore.has(testCID)).toBe(true)

      await expect(blockstore.delete(testCID)).rejects.toThrow(
        'Delete operation not supported on CAR writing blockstore'
      )
      expect(await blockstore.has(testCID)).toBe(true)
    })
  })

  describe('Batch Operations', () => {
    it('should put many blocks', async () => {
      const blocks = []
      for (let i = 0; i < 3; i++) {
        const bytes = new TextEncoder().encode(`Block ${i}`)
        const hash = await sha256.digest(bytes)
        const cid = CID.create(1, raw.code, hash)
        blocks.push({ cid, bytes })
      }

      const results = []
      for await (const cid of blockstore.putMany(blocks)) {
        results.push(cid)
      }

      expect(results).toHaveLength(3)
      const stats = blockstore.getStats()
      expect(stats.blocksWritten).toBe(3)
    })

    it('should throw error when trying to delete many blocks', async () => {
      const cids: CID[] = []
      for (let i = 0; i < 3; i++) {
        const data = new TextEncoder().encode(`Block ${i}`)
        const hash = await sha256.digest(data)
        const cid = CID.create(1, raw.code, hash)
        cids.push(cid)
        await blockstore.put(cid, data)
      }

      await expect(async () => {
        for await (const _ of blockstore.deleteMany(cids)) {
          // Should not reach here
        }
      }).rejects.toThrow('DeleteMany operation not supported on CAR writing blockstore')
    })

    it.skipIf(!factory.supportsReading)('should get many blocks', async () => {
      const blocks = []
      const cids: CID[] = []
      for (let i = 0; i < 3; i++) {
        const bytes = new TextEncoder().encode(`Block ${i}`)
        const hash = await sha256.digest(bytes)
        const cid = CID.create(1, raw.code, hash)
        blocks.push({ cid, bytes })
        cids.push(cid)
        await blockstore.put(cid, bytes)
      }

      // Allow filesystem to settle after writes
      await new Promise((resolve) => setTimeout(resolve, 50))

      const results = []
      for await (const pair of blockstore.getMany(cids)) {
        results.push(pair)
      }

      expect(results).toHaveLength(3)
      const firstPair = results[0]
      expect(firstPair).toBeDefined()
      if (firstPair != null) {
        const firstBytes = await toBuffer(firstPair.bytes as AsyncIterable<Uint8Array>)
        expect(firstBytes).toEqual(blocks[0]?.bytes)
      }
    })

    it('should get all blocks', async () => {
      for (let i = 0; i < 3; i++) {
        const data = new TextEncoder().encode(`Block ${i}`)
        const hash = await sha256.digest(data)
        const cid = CID.create(1, raw.code, hash)
        await blockstore.put(cid, data)
      }

      const results = []
      for await (const pair of blockstore.getAll()) {
        results.push(pair)
      }

      expect(results).toHaveLength(3)
    })
  })

  describe('Finalization', () => {
    it.skipIf(!factory.hasFileOutput)('should create a CAR file', async () => {
      await blockstore.put(testCID, testBlock)
      await blockstore.finalize()

      const fileExists = await stat(testOutputPath)
        .then(() => true)
        .catch(() => false)
      expect(fileExists).toBe(true)

      const fileContent = await readFile(testOutputPath)
      expect(fileContent.length).toBeGreaterThan(0)
    })

    it('should finalize and return statistics', async () => {
      await blockstore.put(testCID, testBlock)
      const finalStats = await blockstore.finalize()

      expect(finalStats.finalized).toBe(true)
      expect(finalStats.blocksWritten).toBe(1)
      expect(finalStats.totalSize).toBe(testBlock.length)
      expect(finalStats.missingBlocks.size).toBe(0)
    })

    it.skipIf(!factory.hasEvents)('should emit finalized event', async () => {
      let eventData: any
      ;(blockstore as NodeCARBlockstore).on('finalized', (data) => {
        eventData = data
      })

      await blockstore.put(testCID, testBlock)
      await blockstore.finalize()

      expect(eventData).toBeDefined()
      expect(eventData.finalized).toBe(true)
    })

    it('should prevent putting blocks after finalization', async () => {
      await blockstore.put(testCID, testBlock)
      await blockstore.finalize()

      const anotherBlock = new TextEncoder().encode('Another block')
      const anotherHash = await sha256.digest(anotherBlock)
      const anotherCID = CID.create(1, raw.code, anotherHash)

      await expect(blockstore.put(anotherCID, anotherBlock)).rejects.toThrow(
        'Cannot put blocks in finalized CAR blockstore'
      )
    })

    it('should handle multiple finalize calls gracefully', async () => {
      await blockstore.put(testCID, testBlock)
      const stats1 = await blockstore.finalize()
      const stats2 = await blockstore.finalize()

      expect(stats1).toEqual(stats2)
    })

    it.skipIf(!factory.hasBrowserAPI)('should provide CAR bytes after finalization', async () => {
      await blockstore.put(testCID, testBlock)
      await blockstore.finalize()

      const carBytes = (blockstore as BrowserCARBlockstore).getCarBytes()
      expect(carBytes).toBeInstanceOf(Uint8Array)
      expect(carBytes.length).toBeGreaterThan(0)
    })

    it.skipIf(!factory.hasBrowserAPI)('should throw when getting CAR bytes before finalization', () => {
      expect(() => {
        ;(blockstore as BrowserCARBlockstore).getCarBytes()
      }).toThrow('Cannot get CAR bytes before finalization')
    })
  })

  describe('Error Handling', () => {
    it.skipIf(!factory.hasEvents)('should handle cleanup gracefully', async () => {
      let cleanupEmitted = false
      ;(blockstore as NodeCARBlockstore).on('cleanup', () => {
        cleanupEmitted = true
      })

      await blockstore.cleanup()
      expect(cleanupEmitted).toBe(true)
    })

    it.skipIf(!factory.hasFileOutput)('should throw error when finalizing without any blocks', async () => {
      // Only Node.js version checks for empty blockstore
      const emptyBlockstore = factory.create(testCID)

      await expect(emptyBlockstore.finalize()).rejects.toThrow(
        'Cannot finalize CAR blockstore without any blocks written'
      )
    })
  })

  describe('Deduplication', () => {
    it('should deduplicate identical blocks', async () => {
      // Put same block twice
      await blockstore.put(testCID, testBlock)
      await blockstore.put(testCID, testBlock)

      // Allow filesystem to settle after writes
      await new Promise((resolve) => setTimeout(resolve, 50))

      const stats = blockstore.getStats()
      // Should only count once
      expect(stats.blocksWritten).toBe(1)
    })
  })
})
