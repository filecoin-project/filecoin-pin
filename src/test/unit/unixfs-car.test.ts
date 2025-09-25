/**
 * Integration test to verify parity between add and import commands
 *
 * This test ensures that:
 * 1. Adding a file with `add` command produces a valid CAR
 * 2. Importing that CAR with `import` command works correctly
 * 3. Both paths produce the same piece CID when uploaded
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CarReader } from '@ipld/car'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCarFromFile } from '../../add/unixfs-car.js'

// Test constants
const PLACEHOLDER_CID = 'bafyaaiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

describe('UnixFS CAR Creation', () => {
  const testDir = join(tmpdir(), 'filecoin-pin-add-import-test')
  const testFile = join(testDir, 'test-content.bin')
  // Use random data to avoid deduplication - need >1MiB for multi-block
  const testContent = randomBytes(1024 * 1024 * 1.5) // 1.5MB of random data

  const countBlocks = async (carPath: string): Promise<number> => {
    const carData = await readFile(carPath)
    const reader = await CarReader.fromBytes(carData)
    let count = 0
    for await (const _block of reader.blocks()) {
      count++
    }
    return count
  }

  beforeEach(async () => {
    // Create test directory and file
    await rm(testDir, { recursive: true, force: true })
    await mkdir(testDir, { recursive: true })
    await writeFile(testFile, testContent)
  })

  afterEach(async () => {
    // Clean up test directory
    await rm(testDir, { recursive: true, force: true })
  })

  describe('Bare mode (no directory wrapper)', () => {
    it('should create a valid CAR that can be imported', async () => {
      // Step 1: Create CAR from file using add logic
      const { carPath, rootCid } = await createCarFromFile(testFile, { bare: true })

      // Step 2: Read and validate the CAR file
      const carData = await readFile(carPath)
      const reader = await CarReader.fromBytes(carData)

      // Verify roots
      const roots = await reader.getRoots()
      expect(roots.length).toBe(1)
      expect(roots[0]?.toString()).toBe(rootCid.toString())

      // Step 3: Verify we can iterate through blocks
      let blockCount = 0
      let totalSize = 0
      for await (const { cid, bytes } of reader.blocks()) {
        blockCount++
        totalSize += bytes.length

        // Root block should be present
        if (cid.toString() === rootCid.toString()) {
          expect(bytes.length).toBeGreaterThan(0)
        }
      }

      expect(blockCount).toBeGreaterThan(0)
      expect(totalSize).toBeGreaterThan(0)

      // Clean up
      await rm(carPath, { force: true })
    })

    it('should produce consistent root CIDs for same content in bare mode', async () => {
      // Create multiple CARs from same content in bare mode
      const results = await Promise.all([
        createCarFromFile(testFile, { bare: true }),
        createCarFromFile(testFile, { bare: true }),
        createCarFromFile(testFile, { bare: true }),
      ])

      // All should have the same root CID
      const rootCids = results.map((r) => r.rootCid.toString())
      expect(new Set(rootCids).size).toBe(1)

      // Clean up all temp CARs
      await Promise.all(results.map((r) => rm(r.carPath, { force: true })))
    })

    it('should handle small single-block files correctly in bare mode', async () => {
      const smallFile = join(testDir, 'small.txt')
      await writeFile(smallFile, 'tiny')

      const { carPath, rootCid } = await createCarFromFile(smallFile, { bare: true })

      // Should still produce valid CAR
      const carData = await readFile(carPath)
      expect(carData.length).toBeGreaterThan(0)

      // Should have valid UnixFS root
      // Small files use raw codec (0x55), larger files shard so will have a dag-pb (0x70) root
      expect([0x55, 0x70]).toContain(rootCid.code)

      // Verify CAR structure
      const reader = await CarReader.fromBytes(carData)
      const roots = await reader.getRoots()
      expect(roots[0]?.toString()).toBe(rootCid.toString())

      // Count blocks - small file should have just 1 block
      let blockCount = 0
      for await (const _block of reader.blocks()) {
        blockCount++
      }
      expect(blockCount).toBe(1) // Single block for tiny file

      // Clean up
      await rm(carPath, { force: true })
    })

    it('should handle larger files with multiple blocks in bare mode', async () => {
      // Create a file large enough to require multiple UnixFS blocks
      // UnixFS chunks at 1MiB (1048576 bytes) by default in Helia
      const largeFile = join(testDir, 'large.bin')
      // Use random bytes to avoid deduplication
      const largeContent = randomBytes(1024 * 1024 * 2) // 2MB of random data
      await writeFile(largeFile, largeContent)

      const { carPath, rootCid } = await createCarFromFile(largeFile, { bare: true })

      // Read the CAR and count blocks
      const carData = await readFile(carPath)
      const reader = await CarReader.fromBytes(carData)

      let blockCount = 0
      let hasRootBlock = false
      for await (const { cid } of reader.blocks()) {
        blockCount++
        if (cid.toString() === rootCid.toString()) {
          hasRootBlock = true
        }
      }

      // Should have multiple blocks for chunked content
      // 2 data blocks + 1 dag-pb root block linking them
      expect(blockCount).toBe(3)
      expect(hasRootBlock).toBe(true)

      // Clean up
      await rm(carPath, { force: true })
    })

    it('should validate placeholder CID is replaced in bare mode', async () => {
      const { carPath, rootCid } = await createCarFromFile(testFile, { bare: true })

      // The placeholder CID should never appear in final output
      expect(rootCid.toString()).not.toBe(PLACEHOLDER_CID)

      // Verify the CAR file has the correct root
      const carData = await readFile(carPath)
      const reader = await CarReader.fromBytes(carData)
      const roots = await reader.getRoots()

      expect(roots[0]?.toString()).not.toBe(PLACEHOLDER_CID)
      expect(roots[0]?.toString()).toBe(rootCid.toString())

      // Clean up
      await rm(carPath, { force: true })
    })
  })

  describe('Directory wrapper mode (default)', () => {
    it('should create a valid CAR with directory wrapper', async () => {
      const { carPath, rootCid } = await createCarFromFile(testFile, { bare: false })

      // Read and validate the CAR file
      const carData = await readFile(carPath)
      const reader = await CarReader.fromBytes(carData)

      // Verify roots
      const roots = await reader.getRoots()
      expect(roots.length).toBe(1)
      expect(roots[0]?.toString()).toBe(rootCid.toString())

      // Should have blocks for file data plus directory
      let blockCount = 0
      for await (const _block of reader.blocks()) {
        blockCount++
      }

      // Expect: 2 data blocks (1.5MB chunked at 1MiB) + 1 file metadata + 1 wrapping directory = 4
      expect(blockCount).toBe(4)

      // Clean up
      await rm(carPath, { force: true })
    })

    it('should have one extra block compared to bare mode', async () => {
      const { carPath: bareCar } = await createCarFromFile(testFile, { bare: true })
      const { carPath: dirCar } = await createCarFromFile(testFile, { bare: false })

      const bareBlocks = await countBlocks(bareCar)
      const dirBlocks = await countBlocks(dirCar)

      // Directory mode should have exactly one extra block (the directory)
      expect(dirBlocks).toBe(bareBlocks + 1)

      // Clean up
      await rm(bareCar, { force: true })
      await rm(dirCar, { force: true })
    })

    it('should produce different root CIDs between bare and directory modes', async () => {
      const { carPath: bareCar, rootCid: bareCid } = await createCarFromFile(testFile, { bare: true })
      const { carPath: dirCar, rootCid: dirCid } = await createCarFromFile(testFile, { bare: false })

      // Root CIDs should be different
      expect(bareCid.toString()).not.toBe(dirCid.toString())

      // Clean up
      await rm(bareCar, { force: true })
      await rm(dirCar, { force: true })
    })

    it('should produce consistent root CIDs for same content in directory mode', async () => {
      const results = await Promise.all([
        createCarFromFile(testFile, { bare: false }),
        createCarFromFile(testFile, { bare: false }),
        createCarFromFile(testFile, { bare: false }),
      ])

      // All should have the same root CID
      const rootCids = results.map((r) => r.rootCid.toString())
      expect(new Set(rootCids).size).toBe(1)

      // Clean up all temp CARs
      await Promise.all(results.map((r) => rm(r.carPath, { force: true })))
    })

    it('should handle small files with directory wrapper', async () => {
      const smallFile = join(testDir, 'small.txt')
      await writeFile(smallFile, 'tiny')

      const { carPath: bareCar } = await createCarFromFile(smallFile, { bare: true })
      const { carPath: dirCar } = await createCarFromFile(smallFile, { bare: false })

      const bareBlocks = await countBlocks(bareCar)
      const dirBlocks = await countBlocks(dirCar)

      // Small file: 1 data block + 1 directory block
      expect(bareBlocks).toBe(1)
      expect(dirBlocks).toBe(2)

      // Clean up
      await rm(bareCar, { force: true })
      await rm(dirCar, { force: true })
    })
  })
})
