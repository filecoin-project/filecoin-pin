import { readFile, rm, stat } from 'node:fs/promises'
import toBuffer from 'it-to-buffer'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CARWritingBlockstore } from '../../core/car/index.js'

describe('CARWritingBlockstore', () => {
  let blockstore: CARWritingBlockstore
  let testCID: CID
  let testBlock: Uint8Array
  const testOutputPath = './test-output.car'

  beforeEach(async () => {
    // Create a test block and CID
    testBlock = new TextEncoder().encode('Hello, IPFS!')
    const hash = await sha256.digest(testBlock)
    testCID = CID.create(1, raw.code, hash)

    blockstore = new CARWritingBlockstore({
      rootCID: testCID,
      outputPath: testOutputPath,
    })
  })

  afterEach(async () => {
    // Clean up test files
    await blockstore.cleanup()
    try {
      await stat(testOutputPath)
      await rm(testOutputPath)
    } catch {
      // File doesn't exist, nothing to clean up
    }
  })

  describe('Initialization', () => {
    it('should initialize with root CID and output path', () => {
      expect(blockstore).toBeDefined()
      const stats = blockstore.getStats()
      expect(stats.blocksWritten).toBe(0)
      expect(stats.totalSize).toBe(0)
      expect(stats.finalized).toBe(false)
    })

    it('should emit initialized event', async () => {
      let eventData: any
      blockstore.on('initialized', (data) => {
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

    it('should emit block:stored event when putting blocks', async () => {
      let eventData: any
      blockstore.on('block:stored', (data) => {
        eventData = data
      })

      await blockstore.put(testCID, testBlock)

      expect(eventData).toBeDefined()
      expect(eventData.cid).toEqual(testCID)
      expect(eventData.size).toBe(testBlock.length)
    })

    it('should get a block that was previously put', async () => {
      await blockstore.put(testCID, testBlock)

      // Consume the async generator to get the bytes
      const result = await toBuffer(blockstore.get(testCID))
      expect(result).toEqual(testBlock)
    })

    it('should throw error when getting non-existent block', async () => {
      const nonExistentHash = await sha256.digest(new TextEncoder().encode('nonexistent'))
      const nonExistentCID = CID.create(1, raw.code, nonExistentHash)

      // Need to consume the generator to trigger the error
      await expect(async () => {
        for await (const _ of blockstore.get(nonExistentCID)) {
          // Should not reach here
        }
      }).rejects.toThrow('Block not found')
    })

    it('should emit block:missing event for missing blocks', async () => {
      let eventData: any
      blockstore.on('block:missing', (data) => {
        eventData = data
      })

      const nonExistentHash = await sha256.digest(new TextEncoder().encode('nonexistent'))
      const nonExistentCID = CID.create(1, raw.code, nonExistentHash)

      try {
        // Consume the generator to trigger the error and event
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
      // Block should still exist after failed delete
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
      // Put some blocks first
      const cids: CID[] = []
      for (let i = 0; i < 3; i++) {
        const data = new TextEncoder().encode(`Block ${i}`)
        const hash = await sha256.digest(data)
        const cid = CID.create(1, raw.code, hash)
        cids.push(cid)
        await blockstore.put(cid, data)
      }

      // deleteMany should throw an error
      await expect(async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of blockstore.deleteMany(cids)) {
          // Should not reach here
        }
      }).rejects.toThrow('DeleteMany operation not supported on CAR writing blockstore')
    })

    it('should get many blocks', async () => {
      // Put some blocks first
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

      const results = []
      for await (const pair of blockstore.getMany(cids)) {
        results.push(pair)
      }

      expect(results).toHaveLength(3)
      // Consume the generator to get the actual bytes and compare all blocks
      for (let i = 0; i < results.length; i++) {
        const resultBytes = await toBuffer(results[i]?.bytes || [])
        expect(resultBytes).toEqual(blocks[i]?.bytes)
      }
    })

    it('should get all blocks', async () => {
      // Put some blocks first
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

  describe('CAR File Operations', () => {
    it('should create a CAR file', async () => {
      await blockstore.put(testCID, testBlock)
      await blockstore.finalize()

      // Verify file was created
      const fileExists = await stat(testOutputPath)
        .then(() => true)
        .catch(() => false)
      expect(fileExists).toBe(true)

      // Verify file is not empty
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

    it('should emit finalized event', async () => {
      let eventData: any
      blockstore.on('finalized', (data) => {
        eventData = data
      })

      await blockstore.put(testCID, testBlock)
      await blockstore.finalize()

      expect(eventData).toBeDefined()
      expect(eventData.finalized).toBe(true)
    })

    it('should prevent putting blocks after finalization', async () => {
      // Write at least one block before finalizing
      await blockstore.put(testCID, testBlock)
      await blockstore.finalize()

      // Now try to put another block - this should fail
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
  })

  describe('Error Handling', () => {
    it('should handle cleanup gracefully', async () => {
      await blockstore.put(testCID, testBlock)

      let cleanupEmitted = false
      blockstore.on('cleanup', () => {
        cleanupEmitted = true
      })

      await blockstore.cleanup()
      expect(cleanupEmitted).toBe(true)
    })

    it('should throw error when finalizing without any blocks', async () => {
      // Create a fresh blockstore that hasn't written any blocks
      const emptyBlockstore = new CARWritingBlockstore({
        rootCID: testCID,
        outputPath: './test-empty.car',
      })

      await expect(emptyBlockstore.finalize()).rejects.toThrow(
        'Cannot finalize CAR blockstore without any blocks written'
      )
    })
  })
})
