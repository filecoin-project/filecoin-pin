/**
 * Unit tests for add command functionality
 *
 * Tests the add command's ability to:
 * - Create UnixFS CAR files from regular files
 * - Clean up temporary files
 * - Handle errors properly
 * - Integrate with Synapse upload flow
 */

import { randomBytes } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAdd } from '../../add/add.js'

// Mock the external dependencies at module level
vi.mock('../../common/upload-flow.js', () => ({
  validatePaymentSetup: vi.fn(),
  performUpload: vi.fn().mockResolvedValue({
    pieceCid: 'bafkzcibtest1234567890',
    pieceId: 789,
    dataSetId: '456',
    network: 'calibration',
    transactionHash: '0xabc123',
    providerInfo: {
      id: 1,
      name: 'Test Provider',
      serviceURL: 'http://test.provider',
    },
  }),
  displayUploadResults: vi.fn(),
}))

vi.mock('../../synapse/service.js', () => ({
  initializeSynapse: vi.fn().mockResolvedValue({
    getNetwork: () => 'calibration',
  }),
  createStorageContext: vi.fn().mockResolvedValue({
    storage: {},
    providerInfo: {
      id: 1,
      name: 'Test Provider',
      serviceURL: 'http://test.provider',
    },
  }),
  cleanupSynapseService: vi.fn(),
}))

vi.mock('../../add/unixfs-car.js', () => ({
  createCarFromFile: vi.fn().mockResolvedValue({
    carPath: '/tmp/test.car',
    rootCid: {
      toString: () => 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    },
  }),
  cleanupTempCar: vi.fn(),
}))

vi.mock('../../utils/cli-helpers.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  createSpinner: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    message: vi.fn(),
  })),
  formatFileSize: vi.fn((size: number) => `${size} bytes`),
}))

// We need to partially mock fs/promises to keep real file operations for test setup
// but mock readFile for the CAR reading part
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    readFile: vi.fn((path: string) => {
      // If it's reading the temp CAR, return mock data
      if (path === '/tmp/test.car') {
        return Promise.resolve(Buffer.from('mock-car-data'))
      }
      // Otherwise use real readFile
      return actual.readFile(path)
    }),
  }
})

describe('Add Command', () => {
  const testDir = join(process.cwd(), 'test-add-files')
  const testFile = join(testDir, 'test.bin')
  // Use random bytes to avoid deduplication and ensure multi-block CAR (>1MiB)
  const testContent = randomBytes(1024 * 1024 * 1.5) // 1.5MB of random data

  beforeEach(async () => {
    // Create test directory and file
    await mkdir(testDir, { recursive: true })
    await writeFile(testFile, testContent)
  })

  afterEach(async () => {
    // Clean up test directory
    await rm(testDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  describe('runAdd command', () => {
    it('should successfully add a file', async () => {
      const result = await runAdd({
        filePath: testFile,
        privateKey: 'test-private-key',
        rpcUrl: 'wss://test.rpc.url',
      })

      // Verify the result structure
      expect(result).toMatchObject({
        filePath: testFile,
        fileSize: expect.any(Number),
        rootCid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
        pieceCid: 'bafkzcibtest1234567890',
        pieceId: 789,
        dataSetId: '456',
        transactionHash: '0xabc123',
        providerInfo: {
          id: 1,
          name: 'Test Provider',
        },
      })
    })

    it('should reject when file does not exist', async () => {
      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called')
      })

      await expect(
        runAdd({
          filePath: '/non/existent/file.txt',
          privateKey: 'test-key',
        })
      ).rejects.toThrow('process.exit called')

      expect(mockExit).toHaveBeenCalledWith(1)
      mockExit.mockRestore()
    })

    it('should reject when private key is missing', async () => {
      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called')
      })

      await expect(
        runAdd({
          filePath: testFile,
          // No private key
        })
      ).rejects.toThrow('process.exit called')

      expect(mockExit).toHaveBeenCalledWith(1)
      mockExit.mockRestore()
    })

    it('should reject non-file paths (directories)', async () => {
      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called')
      })

      await expect(
        runAdd({
          filePath: testDir, // Directory, not a file
          privateKey: 'test-key',
        })
      ).rejects.toThrow('process.exit called')

      expect(mockExit).toHaveBeenCalledWith(1)
      mockExit.mockRestore()
    })
  })
})
