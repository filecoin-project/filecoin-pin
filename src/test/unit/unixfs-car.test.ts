/**
 * UnixFS to CAR creation tests.
 *
 * Verifies that createCarFromPath produces valid CAR output under the
 * IPIP-499 unixfs-v1-2025 profile, with no implicit directory wrapping
 * for single files.
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CarReader } from '@ipld/car'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCarFromPath } from '../../core/unixfs/index.js'

const PLACEHOLDER_CID = 'bafyaaiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

describe('UnixFS CAR Creation', () => {
  const testDir = join(tmpdir(), 'filecoin-pin-add-import-test')
  const testFile = join(testDir, 'test-content.bin')
  // Random data avoids dedup; >1 MiB forces multi-block.
  const testContent = randomBytes(1024 * 1024 * 1.5)

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
    await rm(testDir, { recursive: true, force: true })
    await mkdir(testDir, { recursive: true })
    await writeFile(testFile, testContent)
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  describe('Single file', () => {
    it('creates a valid CAR that can be re-read', async () => {
      const result = await createCarFromPath(testFile)

      expect(result.kind).toBe('file')
      expect(result.name).toBe('test-content.bin')

      const carData = await readFile(result.carPath)
      const reader = await CarReader.fromBytes(carData)

      const roots = await reader.getRoots()
      expect(roots.length).toBe(1)
      expect(roots[0]?.toString()).toBe(result.rootCid.toString())

      let blockCount = 0
      let totalSize = 0
      for await (const { cid, bytes } of reader.blocks()) {
        blockCount++
        totalSize += bytes.length
        if (cid.toString() === result.rootCid.toString()) {
          expect(bytes.length).toBeGreaterThan(0)
        }
      }

      expect(blockCount).toBeGreaterThan(0)
      expect(totalSize).toBeGreaterThan(0)

      await rm(result.carPath, { force: true })
    })

    it('produces a deterministic root CID for identical content', async () => {
      const results = await Promise.all([
        createCarFromPath(testFile),
        createCarFromPath(testFile),
        createCarFromPath(testFile),
      ])

      const rootCids = results.map((r) => r.rootCid.toString())
      expect(new Set(rootCids).size).toBe(1)

      await Promise.all(results.map((r) => rm(r.carPath, { force: true })))
    })

    it('emits a single raw block for tiny files', async () => {
      const smallFile = join(testDir, 'small.txt')
      await writeFile(smallFile, 'tiny')

      const result = await createCarFromPath(smallFile)

      const carData = await readFile(result.carPath)
      // Raw leaf for content fitting in a single block.
      expect(result.rootCid.code).toBe(0x55)

      const reader = await CarReader.fromBytes(carData)
      const roots = await reader.getRoots()
      expect(roots[0]?.toString()).toBe(result.rootCid.toString())

      let blockCount = 0
      for await (const _block of reader.blocks()) {
        blockCount++
      }
      expect(blockCount).toBe(1)

      await rm(result.carPath, { force: true })
    })

    it('chunks larger files into multiple blocks under a dag-pb root', async () => {
      const largeFile = join(testDir, 'large.bin')
      const largeContent = randomBytes(1024 * 1024 * 2) // 2 MiB
      await writeFile(largeFile, largeContent)

      const result = await createCarFromPath(largeFile)

      const carData = await readFile(result.carPath)
      const reader = await CarReader.fromBytes(carData)

      let blockCount = 0
      let hasRootBlock = false
      for await (const { cid } of reader.blocks()) {
        blockCount++
        if (cid.toString() === result.rootCid.toString()) {
          hasRootBlock = true
        }
      }

      // 2 raw leaf blocks + 1 dag-pb root linking them.
      expect(blockCount).toBe(3)
      expect(hasRootBlock).toBe(true)
      expect(result.rootCid.code).toBe(0x70)

      await rm(result.carPath, { force: true })
    })

    it('replaces the placeholder CID with the real root', async () => {
      const result = await createCarFromPath(testFile)

      expect(result.rootCid.toString()).not.toBe(PLACEHOLDER_CID)

      const carData = await readFile(result.carPath)
      const reader = await CarReader.fromBytes(carData)
      const roots = await reader.getRoots()
      expect(roots[0]?.toString()).not.toBe(PLACEHOLDER_CID)
      expect(roots[0]?.toString()).toBe(result.rootCid.toString())

      await rm(result.carPath, { force: true })
    })
  })

  describe('Directory', () => {
    it('creates a valid CAR for a directory with multiple files', async () => {
      const testDirPath = join(testDir, 'test-directory')
      await mkdir(testDirPath, { recursive: true })

      await writeFile(join(testDirPath, 'file1.txt'), 'content1')
      await writeFile(join(testDirPath, 'file2.bin'), randomBytes(1024))
      await writeFile(join(testDirPath, 'large.bin'), randomBytes(1024 * 1024 * 2))

      const result = await createCarFromPath(testDirPath)

      expect(result.kind).toBe('directory')
      expect(result.name).toBe('test-directory')

      const carData = await readFile(result.carPath)
      const reader = await CarReader.fromBytes(carData)

      const roots = await reader.getRoots()
      expect(roots.length).toBe(1)
      expect(roots[0]?.toString()).toBe(result.rootCid.toString())

      let blockCount = 0
      for await (const _block of reader.blocks()) {
        blockCount++
      }
      expect(blockCount).toBeGreaterThanOrEqual(5)

      await rm(result.carPath, { force: true })
      await rm(testDirPath, { recursive: true, force: true })
    })

    it('handles nested directory structures', async () => {
      const rootDir = join(testDir, 'nested-test')
      const subDir1 = join(rootDir, 'subdir1')
      const subDir2 = join(rootDir, 'subdir2')
      const deepDir = join(subDir1, 'deep')

      await mkdir(deepDir, { recursive: true })
      await mkdir(subDir2, { recursive: true })

      await writeFile(join(rootDir, 'root.txt'), 'root content')
      await writeFile(join(subDir1, 'sub1.txt'), 'subdir1 content')
      await writeFile(join(subDir2, 'sub2.txt'), 'subdir2 content')
      await writeFile(join(deepDir, 'deep.txt'), 'deep content')

      const result = await createCarFromPath(rootDir)

      const carData = await readFile(result.carPath)
      const reader = await CarReader.fromBytes(carData)

      const roots = await reader.getRoots()
      expect(roots.length).toBe(1)
      expect(roots[0]?.toString()).toBe(result.rootCid.toString())

      let blockCount = 0
      for await (const _block of reader.blocks()) {
        blockCount++
      }
      expect(blockCount).toBeGreaterThan(4)

      await rm(result.carPath, { force: true })
      await rm(rootDir, { recursive: true, force: true })
    })

    it('handles empty directories', async () => {
      const emptyDir = join(testDir, 'empty-dir')
      await mkdir(emptyDir, { recursive: true })

      const result = await createCarFromPath(emptyDir)

      const carData = await readFile(result.carPath)
      const reader = await CarReader.fromBytes(carData)

      let blockCount = 0
      for await (const _block of reader.blocks()) {
        blockCount++
      }
      expect(blockCount).toBe(1)

      await rm(result.carPath, { force: true })
      await rm(emptyDir, { recursive: true, force: true })
    })

    it('handles directories containing only subdirectories', async () => {
      const parentDir = join(testDir, 'dirs-only')
      const subDir1 = join(parentDir, 'sub1')
      const subDir2 = join(parentDir, 'sub2')
      const subSubDir = join(subDir1, 'subsub')

      await mkdir(subSubDir, { recursive: true })
      await mkdir(subDir2, { recursive: true })

      const result = await createCarFromPath(parentDir)

      const blockCount = await countBlocks(result.carPath)
      // Empty directories deduplicate. Expect:
      //   1× shared empty-dir block, 1× sub1 (linking to subsub), 1× root.
      expect(blockCount).toBe(3)

      await rm(result.carPath, { force: true })
      await rm(parentDir, { recursive: true, force: true })
    })

    it('produces 3 blocks for a flat directory with 2 small files', async () => {
      const simpleDir = join(testDir, 'simple-dir')
      await mkdir(simpleDir, { recursive: true })

      await writeFile(join(simpleDir, 'file1.txt'), 'content of file 1')
      await writeFile(join(simpleDir, 'file2.txt'), 'content of file 2')

      const result = await createCarFromPath(simpleDir)

      const blockCount = await countBlocks(result.carPath)
      expect(blockCount).toBe(3)

      await rm(result.carPath, { force: true })
      await rm(simpleDir, { recursive: true, force: true })
    })

    it('deduplicates identical content blocks', async () => {
      const dedupDir = join(testDir, 'dedup-test')
      await mkdir(dedupDir, { recursive: true })

      const identicalContent = 'This is the same content in all files'
      await writeFile(join(dedupDir, 'file1.txt'), identicalContent)
      await writeFile(join(dedupDir, 'file2.txt'), identicalContent)
      await writeFile(join(dedupDir, 'file3.txt'), identicalContent)

      const result = await createCarFromPath(dedupDir)

      const blockCount = await countBlocks(result.carPath)
      expect(blockCount).toBe(2)

      await rm(result.carPath, { force: true })
      await rm(dedupDir, { recursive: true, force: true })
    })

    it('produces deterministic CIDs for identical directory structures', async () => {
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

      expect(result1.rootCid.toString()).toBe(result2.rootCid.toString())

      await rm(result1.carPath, { force: true })
      await rm(result2.carPath, { force: true })
      await rm(dir1, { recursive: true, force: true })
      await rm(dir2, { recursive: true, force: true })
    })

    it('packs an explicitly-targeted hidden root directory and its contents', async () => {
      // Regression: globSource's hidden filter would exclude every match if the
      // root basename starts with `.`. The user selected this dir explicitly,
      // so contents must come along regardless of the dotfile default.
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

    it('excludes hidden entries by default', async () => {
      const hiddenDir = join(testDir, 'hidden-test')
      await mkdir(hiddenDir, { recursive: true })

      await writeFile(join(hiddenDir, 'visible.txt'), 'visible')
      await writeFile(join(hiddenDir, '.hidden'), 'hidden')

      const defaultResult = await createCarFromPath(hiddenDir)
      const includeResult = await createCarFromPath(hiddenDir, { includeHidden: true })

      expect(defaultResult.rootCid.toString()).not.toBe(includeResult.rootCid.toString())

      const defaultBlocks = await countBlocks(defaultResult.carPath)
      const includeBlocks = await countBlocks(includeResult.carPath)
      expect(includeBlocks).toBeGreaterThan(defaultBlocks)

      await rm(defaultResult.carPath, { force: true })
      await rm(includeResult.carPath, { force: true })
      await rm(hiddenDir, { recursive: true, force: true })
    })
  })
})
