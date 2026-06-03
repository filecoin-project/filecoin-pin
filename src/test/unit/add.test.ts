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
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAdd, runAddFromCli } from '../../add/add.js'

const { mockCarPath, mockFindDataSets } = vi.hoisted(() => ({
  mockCarPath: 'test-add-files/mock.car',
  mockFindDataSets: vi.fn().mockResolvedValue([]),
}))

// Mock the external dependencies at module level
vi.mock('../../common/upload-flow.js', () => ({
  validatePaymentSetup: vi.fn(),
  performAutoFunding: vi.fn(),
  performUpload: vi.fn().mockResolvedValue({
    pieceCid: 'bafkzcibtest1234567890',
    size: 1024,
    copies: [
      {
        providerId: 1n,
        dataSetId: 123n,
        pieceId: 789n,
        role: 'primary',
        retrievalUrl: 'http://test.provider/pdp/piece/bafkzcibtest1234567890',
        isNewDataSet: false,
      },
    ],
    failedAttempts: [],
    network: 'calibration',
  }),
  displayUploadResults: vi.fn(),
}))

vi.mock('../../core/synapse/index.js', () => ({
  getClientAddress: vi.fn(() => '0x1234567890123456789012345678901234567890'),
  initializeSynapse: vi.fn().mockImplementation((config: any) => {
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
      chain: { name: 'calibration', id: 314159, filbeam: { retrievalDomain: 'calibration.filbeam.io' } },
      client: { account: { address: '0x1234567890123456789012345678901234567890' } },
      storage: {
        upload: vi.fn(),
        findDataSets: mockFindDataSets,
      },
    }
  }),
}))

vi.mock('../../core/unixfs/index.js', () => ({
  createCarFromPath: vi.fn((filePath: string, options: any) => {
    const isDirectory = options?.isDirectory === true
    const cid = isDirectory
      ? 'bafybeihw4ytkqxrq7q7e3p2l5s5di7zjzkhxdmfwvqfylkdamdg3xybpbq'
      : 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
    const name = basename(filePath)
    return Promise.resolve({
      carPath: mockCarPath,
      rootCid: {
        toString: () => cid,
      },
      name,
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
    clear: vi.fn(),
  })),
  formatFileSize: vi.fn((size: number) => `${size} bytes`),
}))

// Test CID constants (defined after vi.mock calls due to hoisting)
const TEST_FILE_CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const TEST_PIECE_CID = 'bafkzcibtest1234567890'
const TEST_CAR_CONTENT = Buffer.from('mock-car-data')

describe('Add Command', () => {
  const testDir = join(process.cwd(), 'test-add-files')
  const testFile = join(testDir, 'test.bin')
  // Use random bytes to avoid deduplication and ensure multi-block CAR (>1MiB)
  const testContent = randomBytes(1024 * 1024 * 1.5) // 1.5MB of random data

  beforeEach(async () => {
    // Create test directory and file
    await mkdir(testDir, { recursive: true })
    await writeFile(testFile, testContent)
    await writeFile(join(process.cwd(), mockCarPath), TEST_CAR_CONTENT)
  })

  afterEach(async () => {
    // Clean up test directory
    await rm(testDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  describe('runAdd command', () => {
    it('should successfully add a file (no directory wrapper)', async () => {
      const result = await runAdd({
        filePath: testFile,
        privateKey: 'test-private-key',
        rpcUrl: 'wss://test.rpc.url',
      })

      // Verify the result structure (multi-copy format)
      expect(result).toMatchObject({
        filePath: testFile,
        fileSize: expect.any(Number),
        rootCid: TEST_FILE_CID,
        pieceCid: TEST_PIECE_CID,
        size: 1024,
      })
      expect(result.copies).toHaveLength(1)
      expect(result.copies[0]?.role).toBe('primary')
      expect(result.failedAttempts).toHaveLength(0)

      const { createCarFromPath } = await import('../../core/unixfs/index.js')
      expect(vi.mocked(createCarFromPath)).toHaveBeenCalledWith(
        testFile,
        expect.objectContaining({
          logger: expect.any(Object),
        })
      )

      const { performUpload } = await import('../../common/upload-flow.js')
      const uploadData = vi.mocked(performUpload).mock.calls[0]?.[1]
      const uploadOptions = vi.mocked(performUpload).mock.calls[0]?.[3]
      expect(uploadData).toBeInstanceOf(ReadableStream)
      expect(uploadOptions?.fileSize).toBe(TEST_CAR_CONTENT.length)
    })

    it('routes the source basename into piece metadata under "name"', async () => {
      await runAdd({
        filePath: testFile,
        privateKey: 'test-private-key',
        rpcUrl: 'wss://test.rpc.url',
      })

      const { performUpload } = await import('../../common/upload-flow.js')
      expect(vi.mocked(performUpload)).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          pieceMetadata: expect.objectContaining({ name: 'test.bin' }),
        })
      )
    })

    it('preserves user-supplied name over the derived basename', async () => {
      await runAdd({
        filePath: testFile,
        privateKey: 'test-private-key',
        rpcUrl: 'wss://test.rpc.url',
        pieceMetadata: { name: 'custom-name.bin' },
      })

      const { performUpload } = await import('../../common/upload-flow.js')
      expect(vi.mocked(performUpload)).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          pieceMetadata: expect.objectContaining({ name: 'custom-name.bin' }),
        })
      )
    })

    it('passes metadata options through to upload', async () => {
      await runAdd({
        filePath: testFile,
        privateKey: 'test-private-key',
        rpcUrl: 'wss://test.rpc.url',
        pieceMetadata: { region: 'us-west', note: '' },
        dataSetMetadata: { purpose: 'erc8004' },
      })
      const { initializeSynapse } = await import('../../core/synapse/index.js')
      const { performUpload } = await import('../../common/upload-flow.js')

      expect(vi.mocked(initializeSynapse)).toHaveBeenCalledWith(
        expect.objectContaining({
          dataSetMetadata: { purpose: 'erc8004' },
        }),
        expect.anything()
      )

      // pieceMetadata goes through to performUpload
      expect(vi.mocked(performUpload)).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          pieceMetadata: { region: 'us-west', note: '', name: 'test.bin' },
          metadata: { purpose: 'erc8004' },
        })
      )
    })

    it('passes data set selection options to performUpload', async () => {
      await runAdd({
        filePath: testFile,
        privateKey: 'test-private-key',
        rpcUrl: 'wss://test.rpc.url',
        dataSetId: ['123'],
      })

      const { performUpload } = await import('../../common/upload-flow.js')

      // --data-set-id is parsed and passed through to performUpload
      expect(vi.mocked(performUpload)).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          dataSetIds: [123n],
          copies: 1,
        })
      )
    })

    it('resolves --data-set-metadata to dataSetIds and drops metadata when subset matches', async () => {
      mockFindDataSets.mockResolvedValueOnce([
        {
          pdpVerifierDataSetId: 13260n,
          providerId: 2n,
          isLive: true,
          metadata: { source: 'storacha-migration', 'space-did': 'did:key:abc', withIPFSIndexing: '' },
        },
        {
          pdpVerifierDataSetId: 13261n,
          providerId: 4n,
          isLive: true,
          metadata: { source: 'storacha-migration', 'space-did': 'did:key:abc', withIPFSIndexing: '' },
        },
      ])

      await runAdd({
        filePath: testFile,
        privateKey: 'test-private-key',
        rpcUrl: 'wss://test.rpc.url',
        dataSetMetadata: { source: 'storacha-migration', 'space-did': 'did:key:abc' },
      })

      const { performUpload } = await import('../../common/upload-flow.js')
      expect(vi.mocked(performUpload)).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          dataSetIds: [13260n, 13261n],
        })
      )
      const lastCall = vi.mocked(performUpload).mock.calls.at(-1)
      expect(lastCall?.[3]).not.toHaveProperty('metadata')
    })

    it('throws when --data-set-metadata matches too many data sets', async () => {
      mockFindDataSets.mockResolvedValueOnce([
        { pdpVerifierDataSetId: 1n, providerId: 1n, isLive: true, metadata: { source: 'storacha-migration' } },
        { pdpVerifierDataSetId: 2n, providerId: 2n, isLive: true, metadata: { source: 'storacha-migration' } },
        { pdpVerifierDataSetId: 3n, providerId: 3n, isLive: true, metadata: { source: 'storacha-migration' } },
        { pdpVerifierDataSetId: 4n, providerId: 4n, isLive: true, metadata: { source: 'storacha-migration' } },
      ])

      await expect(
        runAdd({
          filePath: testFile,
          privateKey: 'test-private-key',
          rpcUrl: 'wss://test.rpc.url',
          dataSetMetadata: { source: 'storacha-migration' },
        })
      ).rejects.toThrow(/matched 4 data sets.*expected 2/)
    })

    it('throws when --data-set-metadata matches too few data sets', async () => {
      mockFindDataSets.mockResolvedValueOnce([
        { pdpVerifierDataSetId: 1n, providerId: 1n, isLive: true, metadata: { source: 'storacha-migration' } },
      ])

      await expect(
        runAdd({
          filePath: testFile,
          privateKey: 'test-private-key',
          rpcUrl: 'wss://test.rpc.url',
          dataSetMetadata: { source: 'storacha-migration' },
        })
      ).rejects.toThrow(/matched only 1 data set.*expected 2/)
    })

    it('passes upload targeting options through to auto-funding', async () => {
      await runAdd({
        filePath: testFile,
        privateKey: 'test-private-key',
        rpcUrl: 'wss://test.rpc.url',
        autoFund: true,
        providerId: ['7', '8'],
        dataSetMetadata: { purpose: 'erc8004' },
      })

      const { performAutoFunding } = await import('../../common/upload-flow.js')

      expect(vi.mocked(performAutoFunding)).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Number),
        expect.anything(),
        expect.objectContaining({
          providerIds: [7n, 8n],
          copies: 2,
          metadata: { purpose: 'erc8004' },
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

    it('passes filbeamUrl to displayUploadResults when withCDN is true and chain.filbeam is set', async () => {
      await runAdd({
        filePath: testFile,
        privateKey: 'test-private-key',
        rpcUrl: 'wss://test.rpc.url',
        egressProvider: 'beam',
      })
      const { displayUploadResults } = await import('../../common/upload-flow.js')
      expect(vi.mocked(displayUploadResults)).toHaveBeenCalledWith(
        expect.anything(),
        'Add',
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          filbeamUrl: expect.stringMatching(
            /^https:\/\/0x[0-9a-fA-F]+\.calibration\.filbeam\.io\/bafkzcibtest1234567890$/
          ),
        })
      )
    })

    it('omits egress arg to displayUploadResults when withCDN is false', async () => {
      await runAdd({
        filePath: testFile,
        privateKey: 'test-private-key',
        rpcUrl: 'wss://test.rpc.url',
        egressProvider: 'none',
      })
      const { displayUploadResults } = await import('../../common/upload-flow.js')
      const calls = vi.mocked(displayUploadResults).mock.calls
      const last = calls[calls.length - 1]
      expect(last?.[4]).toBeUndefined()
    })

    it('omits egress arg when chain.filbeam is null (devnet)', async () => {
      const { initializeSynapse } = await import('../../core/synapse/index.js')
      vi.mocked(initializeSynapse).mockImplementationOnce(async (config: any) => {
        if (config.privateKey == null) throw new Error('auth required')
        return {
          chain: { name: 'devnet', id: 31337, filbeam: null },
          client: { account: { address: '0x1234567890123456789012345678901234567890' } },
          storage: { upload: vi.fn(), findDataSets: mockFindDataSets },
        } as any
      })
      await runAdd({
        filePath: testFile,
        privateKey: 'test-private-key',
        rpcUrl: 'wss://test.rpc.url',
        egressProvider: 'beam',
      })
      const { displayUploadResults } = await import('../../common/upload-flow.js')
      const calls = vi.mocked(displayUploadResults).mock.calls
      const last = calls[calls.length - 1]
      expect(last?.[4]).toBeUndefined()
    })
  })

  describe('runAddFromCli egress glue', () => {
    it('defaults to beam egress (withCDN: true) when --egress-provider is omitted', async () => {
      await runAddFromCli(testFile, { privateKey: 'test-private-key', rpcUrl: 'wss://test.rpc.url' })
      const { initializeSynapse } = await import('../../core/synapse/index.js')
      expect(vi.mocked(initializeSynapse)).toHaveBeenCalledWith(
        expect.objectContaining({ withCDN: true }),
        expect.anything()
      )
    })

    it('opts out (withCDN unset) when --egress-provider none is passed', async () => {
      await runAddFromCli(testFile, {
        privateKey: 'test-private-key',
        rpcUrl: 'wss://test.rpc.url',
        egressProvider: 'none',
      })
      const { initializeSynapse } = await import('../../core/synapse/index.js')
      const calls = vi.mocked(initializeSynapse).mock.calls
      const lastConfig = calls[calls.length - 1]?.[0] as { withCDN?: boolean }
      expect(lastConfig.withCDN).toBeUndefined()
    })
  })
})
