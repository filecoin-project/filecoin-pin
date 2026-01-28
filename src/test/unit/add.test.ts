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

vi.mock('../../core/synapse/index.js', () => ({
  initializeSynapse: vi.fn().mockImplementation(async (config: any) => {
    // Validate auth config (mirrors validateAuthConfig in actual code)
    const hasStandardAuth = config.privateKey != null
    const hasSessionKeyAuth = config.walletAddress != null && config.sessionKey != null
    const hasViewOnlyAuth = config.readOnly === true && config.walletAddress != null

    if (!hasStandardAuth && !hasSessionKeyAuth && !hasViewOnlyAuth) {
      throw new Error(
        'Authentication required: provide either privateKey, walletAddress + sessionKey, view-address, or signer'
      )
    }

    return {
      getNetwork: () => 'calibration',
    }
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

vi.mock('../../core/unixfs/index.js', () => ({
  createCarFromPath: vi.fn((_filePath: string, options: any) => {
    const bare = options?.bare || false
    // Different CIDs for bare vs directory mode
    const cid = bare
      ? 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
      : 'bafybeihw4ytkqxrq7q7e3p2l5s5di7zjzkhxdmfwvqfylkdamdg3xybpbq'
    return Promise.resolve({
      carPath: '/tmp/test.car',
      rootCid: {
        toString: () => cid,
      },
    })
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
// but mock readFile/stat for the CAR handling part
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    stat: vi.fn((path: string) => {
      if (path === '/tmp/test.car') {
        return Promise.resolve({
          size: 1024,
        } as any)
      }
      return actual.stat(path as any)
    }),
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

// Test CID constants (defined after vi.mock calls due to hoisting)
const TEST_BARE_CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const TEST_DIR_WRAPPED_CID = 'bafybeihw4ytkqxrq7q7e3p2l5s5di7zjzkhxdmfwvqfylkdamdg3xybpbq'
const TEST_PIECE_CID = 'bafkzcibtest1234567890'

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
    it('should successfully add a file with directory wrapper by default', async () => {
      const result = await runAdd({
        filePath: testFile,
        privateKey: 'test-private-key',
        rpcUrl: 'wss://test.rpc.url',
      })

      // Verify the result structure (should use directory wrapper CID by default)
      expect(result).toMatchObject({
        filePath: testFile,
        fileSize: expect.any(Number),
        rootCid: TEST_DIR_WRAPPED_CID, // Directory wrapper CID
        pieceCid: TEST_PIECE_CID,
        pieceId: 789,
        dataSetId: '456',
        transactionHash: '0xabc123',
        providerInfo: {
          id: 1,
          name: 'Test Provider',
        },
      })

      // Verify createCarFromPath was called without bare flag
      const { createCarFromPath } = await import('../../core/unixfs/index.js')
      expect(vi.mocked(createCarFromPath)).toHaveBeenCalledWith(
        testFile,
        expect.objectContaining({
          logger: expect.any(Object),
          // bare is not passed when undefined, due to spread operator
        })
      )
    })

    it('should successfully add a file in bare mode when specified', async () => {
      const result = await runAdd({
        filePath: testFile,
        privateKey: 'test-private-key',
        rpcUrl: 'wss://test.rpc.url',
        bare: true,
      })

      // Verify the result structure (should use bare mode CID)
      expect(result).toMatchObject({
        filePath: testFile,
        fileSize: expect.any(Number),
        rootCid: TEST_BARE_CID, // Bare mode CID
        pieceCid: TEST_PIECE_CID,
        pieceId: 789,
        dataSetId: '456',
        transactionHash: '0xabc123',
        providerInfo: {
          id: 1,
          name: 'Test Provider',
        },
      })

      // Verify createCarFromPath was called with bare flag
      const { createCarFromPath } = await import('../../core/unixfs/index.js')
      expect(vi.mocked(createCarFromPath)).toHaveBeenCalledWith(
        testFile,
        expect.objectContaining({
          logger: expect.any(Object),
          bare: true,
        })
      )
    })

    it('passes metadata options through to upload and storage context', async () => {
      await runAdd({
        filePath: testFile,
        privateKey: 'test-private-key',
        rpcUrl: 'wss://test.rpc.url',
        pieceMetadata: { region: 'us-west', note: '' },
        dataSetMetadata: { purpose: 'erc8004' },
      })
      const { createStorageContext, initializeSynapse } = await import('../../core/synapse/index.js')

      expect(vi.mocked(initializeSynapse)).toHaveBeenCalledWith(
        expect.objectContaining({
          dataSetMetadata: { purpose: 'erc8004' },
        }),
        expect.anything()
      )

      expect(vi.mocked(createStorageContext)).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          dataset: {
            metadata: { purpose: 'erc8004' },
          },
          logger: expect.anything(),
        })
      )

      const { performUpload } = await import('../../common/upload-flow.js')
      expect(vi.mocked(performUpload)).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          metadata: { region: 'us-west', note: '' },
        })
      )
    })

    it('should reject when file does not exist', async () => {
      const mockExit = vi.spyOn(process, 'exit')

      await expect(
        runAdd({
          filePath: '/non/existent/file.txt',
          privateKey: 'test-key',
        })
      ).rejects.toThrow('Path not found')

      expect(mockExit).not.toHaveBeenCalled()
      mockExit.mockRestore()
    })

    it('should reject when private key is missing', async () => {
      const mockExit = vi.spyOn(process, 'exit')

      await expect(
        runAdd({
          filePath: testFile,
          // No private key
        })
      ).rejects.toThrow()

      expect(mockExit).not.toHaveBeenCalled()
      mockExit.mockRestore()
    })

    it('should reject --bare flag with directories', async () => {
      const mockExit = vi.spyOn(process, 'exit')

      await expect(
        runAdd({
          filePath: testDir, // Directory
          privateKey: 'test-key',
          bare: true, // --bare flag should not work with directories
        })
      ).rejects.toThrow('--bare flag is not supported for directories')

      expect(mockExit).not.toHaveBeenCalled()
      mockExit.mockRestore()
    })
  })
})
