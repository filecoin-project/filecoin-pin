/**
 * Test to verify browser CAR builder generates same CID and CAR bytes as Node.js implementation
 */

import { randomBytes } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCarFromFile, createCarFromFileList, createCarFromFiles } from '../../core/unixfs/browser-car-builder.js'
import { cleanupTempCar, createCarFromPath } from '../../core/unixfs/car-builder.js'

describe('Browser CAR Builder', () => {
  const testFiles: string[] = []

  afterEach(async () => {
    // Clean up temporary files
    for (const file of testFiles) {
      try {
        await rm(file)
      } catch {
        // Ignore cleanup errors
      }
    }
    testFiles.length = 0
  })

  describe('Node.js Compatibility', () => {
    it('should generate same root CID as Node.js createCarFromPath', async () => {
      // Create test data
      const testContent = 'Hello, IPFS! This is a test file.'
      const testData = new TextEncoder().encode(testContent)
      const fileName = 'test.txt' // Use consistent filename for both implementations

      // Write to temp file for Node.js version
      const tempPath = join(tmpdir(), fileName)
      await writeFile(tempPath, testData)
      testFiles.push(tempPath)

      // Node.js implementation
      const nodeResult = await createCarFromPath(tempPath)
      testFiles.push(nodeResult.carPath)
      const nodeCarBytes = await readFile(nodeResult.carPath)

      // Browser implementation with same data and same filename
      const file = new File([testData], fileName, { type: 'text/plain' })
      const browserResult = await createCarFromFile(file)

      // Compare CIDs - they should be identical!
      expect(browserResult.rootCid.toString()).toBe(nodeResult.rootCid.toString())

      // Compare CAR sizes
      expect(browserResult.carBytes.length).toBe(nodeCarBytes.length)

      // Compare actual bytes
      expect(browserResult.carBytes.length).toBe(nodeCarBytes.length)
      expect(Buffer.from(browserResult.carBytes).equals(nodeCarBytes)).toBe(true)

      // Cleanup
      await cleanupTempCar(nodeResult.carPath)
    })

    it('exposes the source filename and kind', async () => {
      const testData = new TextEncoder().encode('payload')
      const file = new File([testData], 'example.txt', { type: 'text/plain' })
      const result = await createCarFromFile(file)

      expect(result.kind).toBe('file')
      expect(result.name).toBe('example.txt')
    })

    it('produces identical root CID and CAR bytes for chunked files across runtimes', async () => {
      // Profile-conformance regression guard: the same input must yield
      // the same root CID and byte-identical CAR in Node and browser
      // builders. Use >1 MiB random data so the importer must chunk and
      // emit a multi-block dag-pb root, exercising the profile beyond
      // the raw-leaf fast path.
      const testData = new Uint8Array(randomBytes(1024 * 1024 * 1.5))
      const fileName = 'chunked.bin'

      const tempPath = join(tmpdir(), `cross-runtime-${Date.now()}-${fileName}`)
      await writeFile(tempPath, testData)
      testFiles.push(tempPath)

      const nodeResult = await createCarFromPath(tempPath)
      testFiles.push(nodeResult.carPath)
      const nodeCarBytes = await readFile(nodeResult.carPath)

      const file = new File([testData], fileName)
      const browserResult = await createCarFromFile(file)

      expect(browserResult.rootCid.toString()).toBe(nodeResult.rootCid.toString())
      expect(browserResult.carBytes.length).toBe(nodeCarBytes.length)
      expect(Buffer.from(browserResult.carBytes).equals(nodeCarBytes)).toBe(true)

      await cleanupTempCar(nodeResult.carPath)
    })

    it('should produce valid CAR that can be read back', async () => {
      const testContent = 'CAR validation test'
      const testData = new TextEncoder().encode(testContent)

      // Browser version
      const file = new File([testData], 'test.txt')
      const browserResult = await createCarFromFile(file)

      // Verify the CAR is valid by reading it back
      const { CarBlockIterator } = await import('@ipld/car')
      const carReader = await CarBlockIterator.fromBytes(browserResult.carBytes)

      // Check roots
      const roots = await carReader.getRoots()
      expect(roots.length).toBe(1)
      expect(roots[0]?.toString()).toBe(browserResult.rootCid.toString())

      // Verify we can read blocks
      const blocks = []
      for await (const { cid, bytes } of carReader) {
        blocks.push({ cid, bytes })
      }
      expect(blocks.length).toBeGreaterThan(0)
    })

    it('should handle multiple files with createCarFromFiles', async () => {
      const file1 = new File([new TextEncoder().encode('File 1 content')], 'file1.txt')
      const file2 = new File([new TextEncoder().encode('File 2 content')], 'file2.txt')

      const result = await createCarFromFiles([file1, file2])

      expect(result.rootCid).toBeDefined()
      expect(result.carBytes).toBeInstanceOf(Uint8Array)
      expect(result.carBytes.length).toBeGreaterThan(0)
    })

    it('should handle FileList with createCarFromFileList', async () => {
      const file1 = new File([new TextEncoder().encode('A')], 'a.txt')
      const file2 = new File([new TextEncoder().encode('B')], 'b.txt')

      // Test with array
      const result = await createCarFromFileList([file1, file2])

      expect(result.rootCid).toBeDefined()
      expect(result.carBytes).toBeInstanceOf(Uint8Array)
    })

    it('should handle directory structure with webkitRelativePath same as Node.js directory', async () => {
      const { mkdir } = await import('node:fs/promises')

      // Create test files with data
      const file1Data = new TextEncoder().encode('File 1 content')
      const file2Data = new TextEncoder().encode('File 2 content')

      // Create actual directory structure for Node.js
      const testDirName = `test-dir-${Date.now()}`
      const testDirPath = join(tmpdir(), testDirName)
      await mkdir(testDirPath, { recursive: true })

      const file1Path = join(testDirPath, 'file1.txt')
      const file2Path = join(testDirPath, 'file2.txt')
      await writeFile(file1Path, file1Data)
      await writeFile(file2Path, file2Data)
      testFiles.push(file1Path, file2Path, testDirPath)

      // Node.js directory processing
      const nodeResult = await createCarFromPath(testDirPath, { isDirectory: true })
      testFiles.push(nodeResult.carPath)
      const nodeCarBytes = await readFile(nodeResult.carPath)

      // Browser version with webkitRelativePath
      const browserFile1 = new File([file1Data], 'file1.txt')
      const browserFile2 = new File([file2Data], 'file2.txt')

      // Add webkitRelativePath to simulate directory upload
      Object.defineProperty(browserFile1, 'webkitRelativePath', {
        value: `${testDirName}/file1.txt`,
        writable: false,
      })
      Object.defineProperty(browserFile2, 'webkitRelativePath', {
        value: `${testDirName}/file2.txt`,
        writable: false,
      })

      const browserResult = await createCarFromFileList([browserFile1, browserFile2])

      // Compare CIDs - they should be identical (most important!)
      expect(browserResult.rootCid.toString()).toBe(nodeResult.rootCid.toString())

      /**
       * Note: CAR file sizes differ due to an extra block in the nodejs car
       * @see https://github.com/filecoin-project/filecoin-pin/pull/83#discussion_r2415372437
       */
      expect(browserResult.carBytes).toBeInstanceOf(Uint8Array)
      expect(browserResult.carBytes.length).toBeLessThanOrEqual(nodeCarBytes.length)

      // Cleanup
      await cleanupTempCar(nodeResult.carPath)
      await rm(testDirPath, { recursive: true })
    })
  })

  describe('Progress Callback', () => {
    it('should call progress callback during file processing', async () => {
      const testData = new Uint8Array(1024 * 256) // 256KB
      const file = new File([testData], 'large.bin')

      let progressCalled = false
      let lastProgress = 0

      const result = await createCarFromFile(file, {
        onProgress: (processed, total) => {
          progressCalled = true
          expect(processed).toBeGreaterThanOrEqual(0)
          expect(processed).toBeLessThanOrEqual(total)
          expect(total).toBe(file.size)
          lastProgress = processed
        },
      })

      expect(progressCalled).toBe(true)
      expect(lastProgress).toBe(file.size)
      expect(result.rootCid).toBeDefined()
    })
  })

  describe('Error Handling', () => {
    it('should handle empty file', async () => {
      const emptyFile = new File([], 'empty.txt')

      const result = await createCarFromFile(emptyFile)

      expect(result.rootCid).toBeDefined()
      expect(result.carBytes).toBeInstanceOf(Uint8Array)
    })

    it('should reject when no files provided to createCarFromFiles', async () => {
      await expect(createCarFromFiles([])).rejects.toThrow('At least one file is required')
    })
  })
})
