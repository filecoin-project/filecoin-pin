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
import { createCarFromPath } from '../../core/unixfs/index.js'

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
      const { carPath, rootCid } = await createCarFromPath(testFile)

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
        createCarFromPath(testFile),
        createCarFromPath(testFile),
        createCarFromPath(testFile),
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

      const { carPath, rootCid } = await createCarFromPath(smallFile)

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

      const { carPath, rootCid } = await createCarFromPath(largeFile)

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
      const { carPath, rootCid } = await createCarFromPath(testFile)

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

  describe('Directory CAR creation', () => {
    it('should create a valid CAR from a directory with multiple files', async () => {
      // Create a test directory structure
      const testDirPath = join(testDir, 'test-directory')
      await mkdir(testDirPath, { recursive: true })

      // Create multiple files with different sizes
      await writeFile(join(testDirPath, 'file1.txt'), 'content1')
      await writeFile(join(testDirPath, 'file2.bin'), randomBytes(1024))
      await writeFile(join(testDirPath, 'large.bin'), randomBytes(1024 * 1024 * 2)) // 2MB

      const { carPath, rootCid } = await createCarFromPath(testDirPath)

      // Verify the result
      expect(rootCid).toBeDefined()

      // Read and validate the CAR file
      const carData = await readFile(carPath)
      const reader = await CarReader.fromBytes(carData)

      // Verify roots
      const roots = await reader.getRoots()
      expect(roots.length).toBe(1)
      expect(roots[0]?.toString()).toBe(rootCid.toString())

      // Count blocks - should have blocks for:
      // - 3 file data blocks (file1.txt, file2.bin, 2 blocks for large.bin)
      // - 1 file metadata for large.bin (since it's chunked)
      // - 1 root directory
      let blockCount = 0
      for await (const _block of reader.blocks()) {
        blockCount++
      }
      expect(blockCount).toBeGreaterThanOrEqual(5) // At least 5 blocks

      // Clean up
      await rm(carPath, { force: true })
      await rm(testDirPath, { recursive: true, force: true })
    })

    it('should handle nested directory structures correctly', async () => {
      // Create nested directory structure
      const rootDir = join(testDir, 'nested-test')
      const subDir1 = join(rootDir, 'subdir1')
      const subDir2 = join(rootDir, 'subdir2')
      const deepDir = join(subDir1, 'deep')

      await mkdir(deepDir, { recursive: true })
      await mkdir(subDir2, { recursive: true })

      // Add files at different levels
      await writeFile(join(rootDir, 'root.txt'), 'root content')
      await writeFile(join(subDir1, 'sub1.txt'), 'subdir1 content')
      await writeFile(join(subDir2, 'sub2.txt'), 'subdir2 content')
      await writeFile(join(deepDir, 'deep.txt'), 'deep content')

      const { carPath, rootCid } = await createCarFromPath(rootDir)

      // Verify the result
      expect(rootCid).toBeDefined()

      // Verify CAR structure
      const carData = await readFile(carPath)
      const reader = await CarReader.fromBytes(carData)

      const roots = await reader.getRoots()
      expect(roots.length).toBe(1)
      expect(roots[0]?.toString()).toBe(rootCid.toString())

      // Count blocks - should have at least:
      // - 4 file blocks (one per file)
      // - Directory blocks for nested structure
      let blockCount = 0
      for await (const _block of reader.blocks()) {
        blockCount++
      }
      expect(blockCount).toBeGreaterThan(4) // More than just file blocks

      // Clean up
      await rm(carPath, { force: true })
      await rm(rootDir, { recursive: true, force: true })
    })

    it('should handle empty directories correctly', async () => {
      const emptyDir = join(testDir, 'empty-dir')
      await mkdir(emptyDir, { recursive: true })

      const { carPath, rootCid } = await createCarFromPath(emptyDir)

      expect(rootCid).toBeDefined()

      // Verify CAR has at least the directory block
      const carData = await readFile(carPath)
      const reader = await CarReader.fromBytes(carData)

      let blockCount = 0
      for await (const _block of reader.blocks()) {
        blockCount++
      }
      expect(blockCount).toBe(1) // Just the empty directory block

      // Clean up
      await rm(carPath, { force: true })
      await rm(emptyDir, { recursive: true, force: true })
    })

    it('should handle directories with only subdirectories (no files)', async () => {
      const parentDir = join(testDir, 'dirs-only')
      const subDir1 = join(parentDir, 'sub1')
      const subDir2 = join(parentDir, 'sub2')
      const subSubDir = join(subDir1, 'subsub')

      await mkdir(subSubDir, { recursive: true })
      await mkdir(subDir2, { recursive: true })

      const { carPath, rootCid } = await createCarFromPath(parentDir)

      expect(rootCid).toBeDefined()

      // Verify CAR has directory blocks
      const carData = await readFile(carPath)
      const reader = await CarReader.fromBytes(carData)

      let blockCount = 0
      for await (const _block of reader.blocks()) {
        blockCount++
      }
      // Empty directories deduplicate to the same CID, so we expect:
      // 1. Empty directory block (shared by all empty dirs)
      // 2. sub1 directory block (links to subsub)
      // 3. parent directory block (links to sub1 and sub2)
      expect(blockCount).toBe(3)

      // Clean up
      await rm(carPath, { force: true })
      await rm(parentDir, { recursive: true, force: true })
    })

    it('should handle mixed content (files and directories) correctly', async () => {
      const mixedDir = join(testDir, 'mixed-content')
      const subDir = join(mixedDir, 'subdir')
      await mkdir(subDir, { recursive: true })

      // Add various file types and sizes
      await writeFile(join(mixedDir, 'text.txt'), 'text content')
      await writeFile(join(mixedDir, 'binary.bin'), randomBytes(512))
      await writeFile(join(subDir, 'nested.json'), JSON.stringify({ test: true }))
      await writeFile(join(subDir, 'large.dat'), randomBytes(1024 * 1024 * 1.5)) // 1.5MB

      const { carPath, rootCid } = await createCarFromPath(mixedDir)

      expect(rootCid).toBeDefined()

      // Verify the CAR contains all expected content
      const blockCount = await countBlocks(carPath)
      // Should have blocks for: 4 files (large.dat chunked to 2) + file metadata for large.dat + 2 directories
      expect(blockCount).toBeGreaterThanOrEqual(7)

      // Clean up
      await rm(carPath, { force: true })
      await rm(mixedDir, { recursive: true, force: true })
    })

    it('should produce consistent CIDs for identical directory structures', async () => {
      // Create two identical directory structures
      const dir1 = join(testDir, 'consistent1')
      const dir2 = join(testDir, 'consistent2')

      for (const dir of [dir1, dir2]) {
        const subDir = join(dir, 'sub')
        await mkdir(subDir, { recursive: true })
        await writeFile(join(dir, 'file.txt'), 'same content')
        await writeFile(join(subDir, 'nested.txt'), 'nested content')
      }

      const result1 = await createCarFromPath(dir1)
      const result2 = await createCarFromPath(dir2)

      // Should produce identical CIDs for identical content
      expect(result1.rootCid.toString()).toBe(result2.rootCid.toString())

      // Clean up
      await rm(result1.carPath, { force: true })
      await rm(result2.carPath, { force: true })
      await rm(dir1, { recursive: true, force: true })
      await rm(dir2, { recursive: true, force: true })
    })

    it('should handle very deep directory nesting', async () => {
      // Create a deeply nested structure
      let currentPath = testDir
      const depth = 10
      for (let i = 0; i < depth; i++) {
        currentPath = join(currentPath, `level${i}`)
      }
      await mkdir(currentPath, { recursive: true })
      await writeFile(join(currentPath, 'deep-file.txt'), 'very deep')

      const basePath = join(testDir, 'level0')
      const { carPath, rootCid } = await createCarFromPath(basePath)

      expect(rootCid).toBeDefined()

      // Should have blocks for all directory levels plus the file
      const blockCount = await countBlocks(carPath)
      expect(blockCount).toBeGreaterThanOrEqual(depth + 1) // At least one block per level + file

      // Clean up
      await rm(carPath, { force: true })
      await rm(basePath, { recursive: true, force: true })
    })

    it('should create exactly 3 blocks for simple directory with 2 small files', async () => {
      // Create a simple directory with 2 small files
      const simpleDir = join(testDir, 'simple-dir')
      await mkdir(simpleDir, { recursive: true })

      // Create 2 small files (small enough to be single blocks each)
      await writeFile(join(simpleDir, 'file1.txt'), 'content of file 1')
      await writeFile(join(simpleDir, 'file2.txt'), 'content of file 2')

      const { carPath, rootCid } = await createCarFromPath(simpleDir)

      expect(rootCid).toBeDefined()

      // Expected blocks:
      // 1. file1.txt data block (raw)
      // 2. file2.txt data block (raw)
      // 3. directory block (dag-pb) linking to file1 and file2
      const blockCount = await countBlocks(carPath)
      expect(blockCount).toBe(3)

      // Clean up
      await rm(carPath, { force: true })
      await rm(simpleDir, { recursive: true, force: true })
    })

    it('should deduplicate identical content blocks', async () => {
      // Create a directory with multiple files containing identical content
      const dedupDir = join(testDir, 'dedup-test')
      await mkdir(dedupDir, { recursive: true })

      // Create 3 files with identical content - they should deduplicate to one block
      const identicalContent = 'This is the same content in all files'
      await writeFile(join(dedupDir, 'file1.txt'), identicalContent)
      await writeFile(join(dedupDir, 'file2.txt'), identicalContent)
      await writeFile(join(dedupDir, 'file3.txt'), identicalContent)

      const { carPath, rootCid } = await createCarFromPath(dedupDir)

      expect(rootCid).toBeDefined()

      // Expected blocks:
      // 1. Single data block (shared by all 3 files due to deduplication)
      // 2. directory block (dag-pb) linking to the 3 files (which all point to same data block)
      const blockCount = await countBlocks(carPath)
      expect(blockCount).toBe(2) // Only 2 blocks instead of 4 due to deduplication

      // Verify CAR still has correct structure
      const carData = await readFile(carPath)
      const reader = await CarReader.fromBytes(carData)
      const roots = await reader.getRoots()
      expect(roots.length).toBe(1)
      expect(roots[0]?.toString()).toBe(rootCid.toString())

      // Clean up
      await rm(carPath, { force: true })
      await rm(dedupDir, { recursive: true, force: true })
    })
  })

  describe('Hidden files', () => {
    it('excludes dotfiles from a directory by default', async () => {
      const hiddenDir = join(testDir, 'hidden-test')
      await mkdir(hiddenDir, { recursive: true })

      await writeFile(join(hiddenDir, 'visible.txt'), 'visible')
      await writeFile(join(hiddenDir, '.hidden'), 'hidden')

      const defaultResult = await createCarFromPath(hiddenDir)
      const includeResult = await createCarFromPath(hiddenDir, { includeHidden: true })

      // Different DAGs because the dotfile is omitted by default
      expect(defaultResult.rootCid.toString()).not.toBe(includeResult.rootCid.toString())

      const defaultBlocks = await countBlocks(defaultResult.carPath)
      const includeBlocks = await countBlocks(includeResult.carPath)
      expect(includeBlocks).toBeGreaterThan(defaultBlocks)

      await rm(defaultResult.carPath, { force: true })
      await rm(includeResult.carPath, { force: true })
      await rm(hiddenDir, { recursive: true, force: true })
    })

    it('packs an explicitly-targeted hidden root directory and its contents', async () => {
      // Regression: globSource's hidden filter would exclude every match if
      // the root basename starts with `.`. The user selected this dir
      // explicitly, so contents must come along regardless of the dotfile
      // exclusion default.
      const hiddenRoot = join(testDir, '.well-known')
      await mkdir(hiddenRoot, { recursive: true })
      await writeFile(join(hiddenRoot, 'visible.txt'), 'visible content')
      await writeFile(join(hiddenRoot, 'another.json'), '{"k":"v"}')

      const result = await createCarFromPath(hiddenRoot)
      expect(result.kind).toBe('directory')
      expect(result.name).toBe('.well-known')

      const blockCount = await countBlocks(result.carPath)
      // 2 raw leaf blocks + 1 dag-pb root linking them.
      expect(blockCount).toBe(3)

      await rm(result.carPath, { force: true })
      await rm(hiddenRoot, { recursive: true, force: true })
    })
  })
})
