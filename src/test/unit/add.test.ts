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
import fs, { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { AddPiecesPermission, CreateDataSetPermission } from '@filoz/synapse-core/session-key'
import { CarWriter } from '@ipld/car'
import * as fee from 'filecoin-encryption-envelope'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'
import { privateKeyToAccount } from 'viem/accounts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAdd, runAddFromCli } from '../../add/add.js'
import type { AddDryRunResult, AddResult } from '../../add/types.js'
import { EXIT_CODE_INCOMPLETE } from '../../common/cli-errors.js'
import { decryptToDirectory } from '../../common/encryption.js'
import { ownerKeyResolver } from '../../common/keyspace.js'

const { mockCarPath, mockFindDataSets, mockListDataSets } = vi.hoisted(() => ({
  mockCarPath: 'test-add-files/mock.car',
  mockFindDataSets: vi.fn().mockResolvedValue([]),
  mockListDataSets: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../core/data-set/list-data-sets.js', () => ({
  listDataSets: mockListDataSets,
}))

// Mock the external dependencies at module level
vi.mock('../../common/upload-flow.js', () => ({
  validatePaymentSetup: vi.fn(),
  performAutoFunding: vi.fn(),
  promptDataSetSelection: vi.fn().mockRejectedValue(new Error('not interactive')),
  // Mirrors the real no-match path: an unmatched --data-set-metadata filter is
  // carried forward so a newly created data set still gets it.
  resolveUploadTargets: vi.fn(async (_synapse: any, _selection: any, opts: any) => ({
    ...(opts?.dataSetMetadata != null && { dataSetMetadata: opts.dataSetMetadata }),
  })),
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
  estimateUploadCost: vi.fn().mockResolvedValue({
    requestedCopies: 2,
    newDataSetCount: 0,
    costs: {
      rates: { perEpoch: 100n, perMonth: 3000n },
      fees: { total: 500n },
      lockups: { total: 90000n },
      depositNeeded: 0n,
      needsFwssMaxApproval: false,
      ready: true,
    },
  }),
  displayDryRunEstimate: vi.fn(),
}))

vi.mock('../../core/synapse/index.js', () => ({
  getClientAddress: vi.fn(() => '0x1234567890123456789012345678901234567890'),
  isSessionKeyMode: vi.fn(() => false),
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

vi.mock('../../common/funds-preflight.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../common/funds-preflight.js')>()),
  assertUploadFunds: vi.fn(async () => undefined),
  estimateInputBytes: vi.fn(async () => 1024),
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
  isInteractive: vi.fn(() => false),
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
    const { isSessionKeyMode } = await import('../../core/synapse/index.js')
    vi.mocked(isSessionKeyMode).mockReturnValue(false)
  })

  describe('runAdd command', () => {
    const sessionAuth = () => ({
      filePath: testFile,
      walletAddress: '0x1234567890123456789012345678901234567890',
      sessionKey: `0x${'11'.repeat(32)}`,
      rpcUrl: 'wss://test.rpc.url',
    })

    it('with a session key, checks funds on the size estimate before packing and again on the CAR size', async () => {
      const { isSessionKeyMode } = await import('../../core/synapse/index.js')
      const { assertUploadFunds } = await import('../../common/funds-preflight.js')
      const { createCarFromPath } = await import('../../core/unixfs/index.js')
      vi.mocked(isSessionKeyMode).mockReturnValue(true)

      await runAdd(sessionAuth())

      expect(vi.mocked(createCarFromPath)).toHaveBeenCalledTimes(1)
      const packedAt = vi.mocked(createCarFromPath).mock.invocationCallOrder[0]
      const [beforePacking, afterPacking] = vi.mocked(assertUploadFunds).mock.invocationCallOrder
      expect(beforePacking).toBeLessThan(packedAt as number)
      expect(afterPacking).toBeGreaterThan(packedAt as number)
      // 1024 is the stubbed estimate; the second call carries the packed CAR's size.
      expect(vi.mocked(assertUploadFunds).mock.calls[0]?.[1]).toBe(1024)
      expect(vi.mocked(assertUploadFunds).mock.calls[1]?.[1]).toBe(TEST_CAR_CONTENT.length)
    })

    it('with a session key, --auto-fund is not attempted: the funds check runs instead', async () => {
      const { isSessionKeyMode } = await import('../../core/synapse/index.js')
      const { assertUploadFunds } = await import('../../common/funds-preflight.js')
      const { performAutoFunding } = await import('../../common/upload-flow.js')
      vi.mocked(isSessionKeyMode).mockReturnValue(true)

      await runAdd({ ...sessionAuth(), autoFund: true })

      expect(vi.mocked(assertUploadFunds)).toHaveBeenCalledTimes(2)
      expect(vi.mocked(performAutoFunding)).not.toHaveBeenCalled()
    })

    it('with a session key, packs nothing when the funds check refuses', async () => {
      const { isSessionKeyMode } = await import('../../core/synapse/index.js')
      const { assertUploadFunds } = await import('../../common/funds-preflight.js')
      const { createCarFromPath } = await import('../../core/unixfs/index.js')
      vi.mocked(isSessionKeyMode).mockReturnValue(true)
      vi.mocked(assertUploadFunds).mockRejectedValueOnce(new Error("Account can't pay for this upload"))

      await expect(runAdd(sessionAuth())).rejects.toThrow("Account can't pay")
      expect(vi.mocked(createCarFromPath)).not.toHaveBeenCalled()
    })

    it('should successfully add a file (no directory wrapper)', async () => {
      const result = (await runAdd({
        filePath: testFile,
        privateKey: 'test-private-key',
        rpcUrl: 'wss://test.rpc.url',
      })) as AddResult

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
          requiredPermissions: [CreateDataSetPermission, AddPiecesPermission],
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
        dataSetIds: ['123'],
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

    it('routes --data-set-metadata through resolveUploadTargets to performUpload', async () => {
      const { resolveUploadTargets, performUpload } = await import('../../common/upload-flow.js')
      vi.mocked(resolveUploadTargets).mockResolvedValueOnce({ dataSetIds: [13260n, 13261n] })

      await runAdd({
        filePath: testFile,
        privateKey: 'test-private-key',
        rpcUrl: 'wss://test.rpc.url',
        dataSetMetadata: { source: 'storacha-migration', 'space-did': 'did:key:abc' },
      })

      expect(vi.mocked(resolveUploadTargets)).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Object),
        expect.objectContaining({ dataSetMetadata: { source: 'storacha-migration', 'space-did': 'did:key:abc' } })
      )
      expect(vi.mocked(performUpload)).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ dataSetIds: [13260n, 13261n] })
      )
      const lastCall = vi.mocked(performUpload).mock.calls.at(-1)
      expect(lastCall?.[3]).not.toHaveProperty('metadata')
    })

    it('routes data set IDs from resolveUploadTargets to performUpload when no targeting is given', async () => {
      const { resolveUploadTargets, performUpload } = await import('../../common/upload-flow.js')
      vi.mocked(resolveUploadTargets).mockResolvedValueOnce({ dataSetIds: [7n, 9n] })

      await runAdd({
        filePath: testFile,
        privateKey: 'test-private-key',
        rpcUrl: 'wss://test.rpc.url',
      })

      expect(vi.mocked(resolveUploadTargets)).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Object),
        expect.objectContaining({ withCDN: false })
      )
      expect(vi.mocked(performUpload)).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ dataSetIds: [7n, 9n], copies: 2 })
      )
    })

    it('hands explicit --data-set-id targeting to resolveUploadTargets', async () => {
      await runAdd({
        filePath: testFile,
        privateKey: 'test-private-key',
        rpcUrl: 'wss://test.rpc.url',
        dataSetIds: ['123'],
      })

      const { resolveUploadTargets } = await import('../../common/upload-flow.js')
      expect(vi.mocked(resolveUploadTargets)).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ dataSetIds: [123n] }),
        expect.any(Object)
      )
    })

    it('passes upload targeting options through to auto-funding', async () => {
      await runAdd({
        filePath: testFile,
        privateKey: 'test-private-key',
        rpcUrl: 'wss://test.rpc.url',
        autoFund: true,
        providerIds: ['7', '8'],
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

    describe('dry-run', () => {
      it('returns AddDryRunResult and skips upload, funding, and payment validation', async () => {
        const result = (await runAdd({
          filePath: testFile,
          privateKey: 'test-private-key',
          rpcUrl: 'wss://test.rpc.url',
          dryRun: true,
        })) as AddDryRunResult

        expect(result).toMatchObject({
          dryRun: true,
          filePath: testFile,
          fileSize: expect.any(Number),
          rootCid: TEST_FILE_CID,
          requestedCopies: 2,
          newDataSetCount: 0,
          costs: expect.objectContaining({ ready: true }),
        })

        const { performUpload, performAutoFunding, validatePaymentSetup } = await import('../../common/upload-flow.js')
        expect(vi.mocked(performUpload)).not.toHaveBeenCalled()
        expect(vi.mocked(performAutoFunding)).not.toHaveBeenCalled()
        expect(vi.mocked(validatePaymentSetup)).not.toHaveBeenCalled()
      })

      it('passes copies to estimateUploadCost', async () => {
        await runAdd({
          filePath: testFile,
          privateKey: 'test-private-key',
          rpcUrl: 'wss://test.rpc.url',
          dryRun: true,
          copies: 3,
        })

        const { estimateUploadCost } = await import('../../common/upload-flow.js')
        expect(vi.mocked(estimateUploadCost)).toHaveBeenCalledWith(
          expect.anything(),
          expect.any(Number),
          expect.objectContaining({ copies: 3 })
        )
      })

      it('passes providerIds to estimateUploadCost', async () => {
        await runAdd({
          filePath: testFile,
          privateKey: 'test-private-key',
          rpcUrl: 'wss://test.rpc.url',
          dryRun: true,
          providerIds: ['7', '8'],
        })

        const { estimateUploadCost } = await import('../../common/upload-flow.js')
        expect(vi.mocked(estimateUploadCost)).toHaveBeenCalledWith(
          expect.anything(),
          expect.any(Number),
          expect.objectContaining({ providerIds: [7n, 8n] })
        )
      })

      it('passes dataSetIds to estimateUploadCost', async () => {
        await runAdd({
          filePath: testFile,
          privateKey: 'test-private-key',
          rpcUrl: 'wss://test.rpc.url',
          dryRun: true,
          dataSetIds: ['123', '456'],
        })

        const { estimateUploadCost } = await import('../../common/upload-flow.js')
        expect(vi.mocked(estimateUploadCost)).toHaveBeenCalledWith(
          expect.anything(),
          expect.any(Number),
          expect.objectContaining({ dataSetIds: [123n, 456n] })
        )
      })

      it('passes withCDN to estimateUploadCost based on egressProvider', async () => {
        await runAdd({
          filePath: testFile,
          privateKey: 'test-private-key',
          rpcUrl: 'wss://test.rpc.url',
          dryRun: true,
          egressProvider: 'none',
        })

        const { estimateUploadCost } = await import('../../common/upload-flow.js')
        expect(vi.mocked(estimateUploadCost)).toHaveBeenCalledWith(
          expect.anything(),
          expect.any(Number),
          expect.objectContaining({ withCDN: false })
        )
      })
    })
  })

  describe('runAddFromCli egress glue', () => {
    it('defaults to no egress (withCDN unset) when --egress-provider is omitted', async () => {
      await runAddFromCli(testFile, { privateKey: 'test-private-key', rpcUrl: 'wss://test.rpc.url' })
      const { initializeSynapse } = await import('../../core/synapse/index.js')
      const calls = vi.mocked(initializeSynapse).mock.calls
      const lastConfig = calls[calls.length - 1]?.[0] as { withCDN?: boolean }
      expect(lastConfig.withCDN).toBeUndefined()
    })

    it('opts in (withCDN: true) when --egress-provider beam is passed', async () => {
      await runAddFromCli(testFile, {
        privateKey: 'test-private-key',
        rpcUrl: 'wss://test.rpc.url',
        egressProvider: 'beam',
      })
      const { initializeSynapse } = await import('../../core/synapse/index.js')
      expect(vi.mocked(initializeSynapse)).toHaveBeenCalledWith(
        expect.objectContaining({ withCDN: true }),
        expect.anything()
      )

      // Reuse is gated on the same flag: with beam requested, only CDN-enabled
      // data sets qualify, so the egress request is never silently dropped.
      const { resolveUploadTargets } = await import('../../common/upload-flow.js')
      expect(vi.mocked(resolveUploadTargets)).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Object),
        expect.objectContaining({ withCDN: true })
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

  describe('--encrypt', () => {
    // The well-known Anvil development keys #0 and #1, as in Keysmith's pinned vectors.
    const OWNER = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
    const STRANGER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
    const VECTOR_KEYSPACE = '0x00112233445566778899aabbccddeeff'
    const VECTOR_COMMITMENT = 'v1.6982807649650e311e4c69af4ac90417'
    const auth = { privateKey: 'test-private-key', rpcUrl: 'wss://test.rpc.url' }

    let packed: { path: string; bytes: Buffer } | undefined
    const packedFile = () => {
      if (packed == null) throw new Error('nothing was packed')
      return packed
    }

    let baseInit: (...args: any[]) => any
    beforeEach(async () => {
      packed = undefined
      mockListDataSets.mockResolvedValue([])
      const { createCarFromPath } = await import('../../core/unixfs/index.js')
      const original = vi.mocked(createCarFromPath).getMockImplementation() as typeof createCarFromPath
      vi.mocked(createCarFromPath).mockImplementationOnce(async (path, options) => {
        packed = { path, bytes: await readFile(path) }
        return original(path, options)
      })
      // The owner wallet signs for the keyspace, so the client account must be a real signer.
      const { initializeSynapse } = await import('../../core/synapse/index.js')
      baseInit = vi.mocked(initializeSynapse).getMockImplementation() as typeof baseInit
      vi.mocked(initializeSynapse).mockImplementation(async (config: any, logger: any) => {
        const synapse = await baseInit(config, logger)
        return { ...synapse, client: { account: OWNER } }
      })
    })

    const scratch: string[] = []
    afterEach(async () => {
      const { initializeSynapse } = await import('../../core/synapse/index.js')
      vi.mocked(initializeSynapse).mockImplementation(baseInit)
      vi.restoreAllMocks()
      for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true })
    })

    // Decrypt the packed envelope the way `filecoin-pin decrypt` does and return the single child it restores.
    async function decrypt(bytes: Uint8Array, account = OWNER) {
      const { appMetadata, contentType } = await fee.parse(new Uint8Array(bytes))
      const dir = await mkdtemp(join(tmpdir(), 'filecoin-pin-add-test-'))
      scratch.push(dir)
      const envelope = join(dir, 'encrypted.fee')
      await writeFile(envelope, bytes)
      const outDir = join(dir, 'out')
      await decryptToDirectory(envelope, outDir, ownerKeyResolver(account))
      const [name] = await readdir(outDir)
      if (name == null) throw new Error('nothing was restored')
      const restored = join(outDir, name)
      return {
        appMetadata,
        contentType,
        name,
        restored,
        plaintext: await readFile(restored).catch(() => Buffer.alloc(0)),
      }
    }

    it('uploads an envelope the owner wallet decrypts back to the file, by name', async () => {
      await runAdd({ ...auth, filePath: testFile, encrypt: true })

      const { plaintext, name, contentType } = await decrypt(packedFile().bytes)
      expect(packedFile().bytes.includes(testContent.subarray(0, 64))).toBe(false)
      expect(name).toBe('test.bin')
      expect(plaintext.equals(testContent)).toBe(true)
      expect(contentType).toBe('application/vnd.ipld.car')
    })

    it('cannot be read with another wallet', async () => {
      await runAdd({ ...auth, filePath: testFile, encrypt: true })

      await expect(decrypt(packedFile().bytes, STRANGER)).rejects.toThrow(/belongs to/)
    })

    it('records exactly the Keysmith labels in appMetadata', async () => {
      await runAdd({ ...auth, filePath: testFile, encrypt: true })

      const { appMetadata } = await decrypt(packedFile().bytes)
      expect({ ...appMetadata }).toEqual({
        'foc/v': 1,
        'foc/own': OWNER.address.toLowerCase(),
        'foc/ks': expect.stringMatching(/^0x[0-9a-f]{32}$/),
        'foc/salt': expect.stringMatching(/^0x[0-9a-f]{32}$/),
      })
    })

    it('tags the data sets it writes to with the keyspace id and commitment', async () => {
      await runAdd({ ...auth, filePath: testFile, encrypt: true })

      const { resolveUploadTargets } = await import('../../common/upload-flow.js')
      const { appMetadata } = await fee.parse(new Uint8Array(packedFile().bytes))
      expect(vi.mocked(resolveUploadTargets).mock.calls[0]?.[2]).toMatchObject({
        requiredMetadata: {
          'foc/ks': appMetadata?.['foc/ks'],
          'foc/kc': expect.stringMatching(/^v1\.[0-9a-f]{32}$/),
        },
      })
    })

    it('reuses the keyspace an existing data set records, after checking its commitment', async () => {
      mockListDataSets.mockResolvedValue([
        { dataSetId: 7n, isLive: true, metadata: { 'foc/ks': VECTOR_KEYSPACE, 'foc/kc': VECTOR_COMMITMENT } },
      ])

      await runAdd({ ...auth, filePath: testFile, encrypt: true })

      const { appMetadata } = await fee.parse(new Uint8Array(packedFile().bytes))
      expect(appMetadata?.['foc/ks']).toBe(VECTOR_KEYSPACE)
      const { resolveUploadTargets } = await import('../../common/upload-flow.js')
      expect(vi.mocked(resolveUploadTargets).mock.calls[0]?.[2]).toMatchObject({
        requiredMetadata: { 'foc/ks': VECTOR_KEYSPACE, 'foc/kc': VECTOR_COMMITMENT },
      })
    })

    it('stops when the recorded commitment does not match this wallet', async () => {
      mockListDataSets.mockResolvedValue([
        { dataSetId: 7n, isLive: true, metadata: { 'foc/ks': VECTOR_KEYSPACE, 'foc/kc': `v1.${'0'.repeat(32)}` } },
      ])

      await expect(runAdd({ ...auth, filePath: testFile, encrypt: true })).rejects.toThrow(/commitment/)
      expect(packed).toBeUndefined()
    })

    it('refuses to encrypt without the owner wallet', async () => {
      const { initializeSynapse } = await import('../../core/synapse/index.js')
      vi.mocked(initializeSynapse).mockImplementation(baseInit)
      const session = { walletAddress: OWNER.address, sessionKey: STRANGER.address, rpcUrl: 'wss://test.rpc.url' }

      await expect(runAdd({ ...session, filePath: testFile, encrypt: true })).rejects.toThrow(/PRIVATE_KEY/)
      expect(packed).toBeUndefined()
    })

    it('uses a neutral name so the original filename is not stored', async () => {
      await runAdd({ ...auth, filePath: testFile, encrypt: true })

      const { performUpload } = await import('../../common/upload-flow.js')
      expect(basename(packedFile().path)).toBe('encrypted.fee')
      expect(vi.mocked(performUpload).mock.calls[0]?.[3]?.pieceMetadata).toEqual({ name: 'encrypted.fee' })
    })

    it('removes the temporary envelope after a successful upload', async () => {
      await runAdd({ ...auth, filePath: testFile, encrypt: true })

      expect(existsSync(packedFile().path)).toBe(false)
    })

    it('removes the temporary envelope when the upload fails', async () => {
      const { performUpload } = await import('../../common/upload-flow.js')
      vi.mocked(performUpload).mockRejectedValueOnce(new Error('provider down'))

      await expect(runAdd({ ...auth, filePath: testFile, encrypt: true })).rejects.toThrow('provider down')
      expect(existsSync(packedFile().path)).toBe(false)
    })

    it('encrypts a CAR file instead of redirecting it to import', async () => {
      const cid = CID.create(1, raw.code, await sha256.digest(new Uint8Array([1])))
      const { writer, out } = CarWriter.create([cid])
      const chunks: Uint8Array[] = []
      const drain = (async () => {
        for await (const chunk of out) chunks.push(chunk)
      })()
      await writer.close()
      await drain
      const car = Buffer.concat(chunks)
      const carFile = join(testDir, 'archive.car')
      await writeFile(carFile, car)

      await runAdd({ ...auth, filePath: carFile, encrypt: true })

      expect((await decrypt(packedFile().bytes)).plaintext.equals(car)).toBe(true)
    })

    it('encrypts a directory and restores it with its name and contents', async () => {
      await mkdir(join(testDir, 'nested'), { recursive: true })
      await writeFile(join(testDir, 'nested', 'note.txt'), 'hello')

      await runAdd({ ...auth, filePath: testDir, encrypt: true })

      const { name, restored } = await decrypt(packedFile().bytes)
      expect(name).toBe(basename(testDir))
      expect((await readFile(join(restored, 'test.bin'))).equals(testContent)).toBe(true)
      expect(await readFile(join(restored, 'nested', 'note.txt'), 'utf8')).toBe('hello')
      expect(basename(packedFile().path)).toBe('encrypted.fee')
    })

    it('never writes the plaintext filename or key material to output or debug logs', async () => {
      const writes: string[] = []
      const capture = (chunk: unknown) => writes.push(String(chunk)) > 0
      vi.spyOn(process.stdout, 'write').mockImplementation(capture)
      vi.spyOn(process.stderr, 'write').mockImplementation(capture)
      // pino writes straight to the fd through sonic-boom, so capture fd 1 and 2 at the fs layer too
      const fsCapture = (...args: unknown[]) => {
        const data = args[1]
        writes.push(Array.isArray(data) ? data.map(String).join('') : String(data))
        const cb = args.at(-1)
        if (typeof cb === 'function') cb(null, 0)
        return 0
      }
      for (const name of ['write', 'writeSync', 'writev', 'writevSync'] as const) {
        const original = fs[name] as (...args: unknown[]) => unknown
        vi.spyOn(fs, name).mockImplementation(((...args: unknown[]) =>
          args[0] === 1 || args[0] === 2 ? fsCapture(...args) : original(...args)) as never)
      }
      vi.stubEnv('LOG_LEVEL', 'debug')
      const { createSpinner } = await import('../../utils/cli-helpers.js')

      await runAdd({ ...auth, filePath: testFile, encrypt: true })
      // sonic-boom flushes asynchronously
      await new Promise((resolve) => setTimeout(resolve, 100))

      const spinner = vi.mocked(createSpinner).mock.results[0]?.value
      const output = JSON.stringify([writes, spinner.start.mock.calls, spinner.stop.mock.calls])
      expect(output).toContain('encrypted')
      expect(output).not.toContain(basename(testFile))
      expect(output.toLowerCase()).not.toContain('ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
    })

    it('removes the envelope on Ctrl-C and exits as incomplete', async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
      const { performUpload } = await import('../../common/upload-flow.js')
      vi.mocked(performUpload).mockImplementationOnce(async () => {
        process.emit('SIGINT')
        throw new Error('interrupted')
      })

      await expect(runAdd({ ...auth, filePath: testFile, encrypt: true })).rejects.toThrow('interrupted')

      expect(exit).toHaveBeenCalledWith(EXIT_CODE_INCOMPLETE)
      expect(existsSync(packedFile().path)).toBe(false)
      expect(process.listeners('SIGINT')).not.toContain(expect.any(Function))
    })

    it('has no option that takes a password or a key on the command line', async () => {
      const { addCommand } = await import('../../commands/add.js')
      const flags = addCommand.options.map((o) => o.long)
      expect(flags).toContain('--encrypt')
      expect(flags).not.toContain('--password-file')
      expect(flags).not.toContain('--password')
    })
  })
})
