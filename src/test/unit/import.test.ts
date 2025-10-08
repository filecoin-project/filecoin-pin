/**
 * Unit tests for CAR import functionality
 *
 * Tests the import command's ability to:
 * - Validate CAR files
 * - Handle various root CID scenarios
 * - Initialize Synapse with progress callbacks
 * - Upload to Filecoin
 * - Clean up resources properly
 */

import { createWriteStream } from 'node:fs'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { CarWriter } from '@ipld/car'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCarImport } from '../../import/import.js'
import type { ImportOptions } from '../../import/types.js'

// Test constants
const ZERO_CID = 'bafkqaaa' // Zero CID used when CAR has no roots

// Mock modules
vi.mock('@filoz/synapse-sdk', async () => await import('../mocks/synapse-sdk.js'))
vi.mock('../../core/payments/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../core/payments/index.js')>('../../core/payments/index.js')
  return {
    ...actual,
    checkFILBalance: vi.fn().mockResolvedValue({
      balance: 1000000000000000000n,
      isCalibnet: true,
      hasSufficientGas: true,
    }),
    checkUSDFCBalance: vi.fn().mockResolvedValue(1000000000000000000000n),
    checkAllowances: vi.fn().mockResolvedValue({
      needsUpdate: false,
      currentAllowances: {
        rateAllowance: BigInt('0xffffffffffffffff'),
        lockupAllowance: BigInt('0xffffffffffffffff'),
        rateUsed: 0n,
        lockupUsed: 0n,
      },
    }),
    setMaxAllowances: vi.fn().mockResolvedValue({
      transactionHash: '0x123...',
      currentAllowances: {
        rateAllowance: BigInt('0xffffffffffffffff'),
        lockupAllowance: BigInt('0xffffffffffffffff'),
        rateUsed: 0n,
        lockupUsed: 0n,
      },
    }),
    checkAndSetAllowances: vi.fn().mockResolvedValue({
      updated: false,
      currentAllowances: {
        rateAllowance: BigInt('0xffffffffffffffff'),
        lockupAllowance: BigInt('0xffffffffffffffff'),
        rateUsed: 0n,
        lockupUsed: 0n,
      },
    }),
    validatePaymentCapacity: vi.fn().mockResolvedValue({
      canUpload: true,
      storageTiB: 0.001,
      required: {
        rateAllowance: 100000000000000n,
        lockupAllowance: 1000000000000000000n,
        storageCapacityTiB: 0.001,
      },
      issues: {},
      suggestions: [],
    }),
  }
})

vi.mock('../../payments/setup.js', () => ({
  formatUSDFC: vi.fn((amount) => `${amount} USDFC`),
  validatePaymentRequirements: vi.fn().mockReturnValue({ isValid: true }),
}))
vi.mock('../../core/synapse/index.js', async () => {
  const { MockSynapse } = await import('../mocks/synapse-mocks.js')

  return {
    initializeSynapse: vi.fn(async (_config: any, _logger: any) => {
      const mockSynapse = new MockSynapse()
      return mockSynapse
    }),
    createStorageContext: vi.fn(async (_synapse: any, _logger: any, progressCallbacks?: any) => {
      const mockSynapse = new MockSynapse()

      // Simulate progress callbacks
      if (progressCallbacks) {
        // Simulate provider selection
        setTimeout(() => {
          progressCallbacks.onProviderSelected?.({
            id: 1,
            name: 'Mock Provider',
            serviceProvider: '0x1234567890123456789012345678901234567890',
          })
        }, 10)

        // Simulate dataset resolution
        setTimeout(() => {
          progressCallbacks.onDataSetResolved?.({
            dataSetId: 123,
            isExisting: false,
          })
        }, 20)
      }

      const mockStorage = await mockSynapse.storage.createContext()
      return {
        synapse: mockSynapse as any,
        storage: mockStorage,
        providerInfo: {
          id: 1,
          name: 'Mock Provider',
          serviceProvider: '0x1234567890123456789012345678901234567890',
          products: {
            PDP: {
              data: {
                serviceURL: 'http://localhost:8888/pdp',
              },
            },
          },
        },
      }
    }),
    cleanupSynapseService: vi.fn(async () => {
      // Mock cleanup
    }),
  }
})

// Mock console methods to capture output
const consoleMocks = {
  log: vi.spyOn(console, 'log').mockImplementation(() => {
    // Intentionally empty - suppressing console output in tests
  }),
  error: vi.spyOn(console, 'error').mockImplementation(() => {
    // Intentionally empty - suppressing console output in tests
  }),
}

// Mock process.exit to prevent test runner from exiting
const processExitMock = vi.spyOn(process, 'exit').mockImplementation(() => {
  throw new Error('process.exit called')
})

/**
 * Create a test CAR file with the given content
 *
 * @param filePath - Path where the CAR file should be written
 * @param roots - Root CIDs for the CAR header
 * @param blocks - Array of { content, cid? } to add to the CAR
 */
async function createTestCarFile(
  filePath: string,
  roots: CID[],
  blocks: Array<{ content: string | Uint8Array; cid?: CID }> = []
): Promise<{ cids: CID[] }> {
  const { writer, out } = await CarWriter.create(roots)
  const writeStream = createWriteStream(filePath)

  // Start piping the CAR output to file
  const pipePromise = pipeline(out as any, writeStream)

  // Track CIDs for test assertions
  const cids: CID[] = []

  // Write blocks
  for (const block of blocks) {
    const bytes = typeof block.content === 'string' ? new TextEncoder().encode(block.content) : block.content

    let cid = block.cid
    if (!cid) {
      const hash = await sha256.digest(bytes)
      cid = CID.create(1, raw.code, hash)
    }

    cids.push(cid)
    await writer.put({ cid, bytes })
  }

  await writer.close()
  await pipePromise

  return { cids }
}

describe('CAR Import', () => {
  const testDir = './test-import-cars'
  const testPrivateKey = '0x0000000000000000000000000000000000000000000000000000000000000001'

  beforeEach(async () => {
    // Create test directory
    await mkdir(testDir, { recursive: true })

    // Clear all mocks
    vi.clearAllMocks()
    consoleMocks.log.mockClear()
    consoleMocks.error.mockClear()
    processExitMock.mockClear()
  })

  afterEach(async () => {
    // Clean up test files
    try {
      await stat(testDir)
      await rm(testDir, { recursive: true, force: true })
    } catch {
      // Directory doesn't exist, nothing to clean up
    }
  })

  describe('CAR File Validation', () => {
    it('should validate a proper CAR file with single root', async () => {
      const carPath = join(testDir, 'valid.car')
      const { cids } = await createTestCarFile(
        carPath,
        [], // Will use first block's CID as root
        [{ content: 'test content' }]
      )
      const cid = cids[0]
      if (!cid) throw new Error('No CID generated')

      // Update CAR with proper root
      await createTestCarFile(carPath, [cid], [{ content: 'test content', cid }])

      const options: ImportOptions = {
        filePath: carPath,
        privateKey: testPrivateKey,
      }

      const result = await runCarImport(options)

      expect(result.rootCid).toBe(cid.toString())
      expect(result.filePath).toBe(carPath)
      expect(result.pieceCid).toBeDefined()
      expect(result.dataSetId).toBeDefined()
    })

    it('should handle CAR file with no roots (use zero CID)', async () => {
      const carPath = join(testDir, 'no-roots.car')
      await createTestCarFile(
        carPath,
        [], // Empty roots array
        [{ content: 'test content' }]
      )

      const options: ImportOptions = {
        filePath: carPath,
        privateKey: testPrivateKey,
      }

      const result = await runCarImport(options)

      expect(result.rootCid).toBe(ZERO_CID) // Zero CID
      expect(result.filePath).toBe(carPath)
      expect(result.pieceCid).toBeDefined()
    })

    it('should handle CAR file with multiple roots (use first)', async () => {
      const carPath = join(testDir, 'multi-roots.car')
      const { cids } = await createTestCarFile(
        carPath,
        [], // Will set roots after creating CIDs
        [{ content: 'content 1' }, { content: 'content 2' }]
      )

      const cid1 = cids[0]
      const cid2 = cids[1]
      if (!cid1 || !cid2) throw new Error('CIDs not generated')

      // Recreate with multiple roots
      await createTestCarFile(
        carPath,
        [cid1, cid2], // Multiple roots
        [
          { content: 'content 1', cid: cid1 },
          { content: 'content 2', cid: cid2 },
        ]
      )

      const options: ImportOptions = {
        filePath: carPath,
        privateKey: testPrivateKey,
      }

      const result = await runCarImport(options)

      expect(result.rootCid).toBe(cid1.toString()) // Should use first CID
      expect(consoleMocks.log).toHaveBeenCalledWith(expect.stringContaining('Multiple root CIDs found'))
    })

    it('should reject invalid CAR file', async () => {
      const invalidCarPath = join(testDir, 'invalid.car')
      await writeFile(invalidCarPath, 'not a car file')

      const options: ImportOptions = {
        filePath: invalidCarPath,
        privateKey: testPrivateKey,
      }

      await expect(runCarImport(options)).rejects.toThrow('process.exit called')
      expect(consoleMocks.error).toHaveBeenCalledWith('Import cancelled')
    })

    it('should reject non-existent file', async () => {
      const options: ImportOptions = {
        filePath: join(testDir, 'nonexistent.car'),
        privateKey: testPrivateKey,
      }

      await expect(runCarImport(options)).rejects.toThrow('process.exit called')
      expect(consoleMocks.error).toHaveBeenCalledWith('Import cancelled')
    })
  })

  describe('Synapse Integration', () => {
    it('should show progress during initialization', async () => {
      const carPath = join(testDir, 'progress.car')
      await createTestCarFile(
        carPath,
        [], // Will use first block's CID
        [{ content: 'test content' }]
      )

      const { createStorageContext } = await import('../../core/synapse/index.js')
      const createContextSpy = vi.mocked(createStorageContext)

      const options: ImportOptions = {
        filePath: carPath,
        privateKey: testPrivateKey,
      }

      await runCarImport(options)

      // Verify progress callbacks were provided to createStorageContext
      expect(createContextSpy).toHaveBeenCalledWith(
        expect.any(Object), // synapse
        expect.any(Object), // logger
        expect.objectContaining({
          onProviderSelected: expect.any(Function),
          onDataSetCreationStarted: expect.any(Function),
          onDataSetResolved: expect.any(Function),
        })
      )
    })

    it('should require private key', async () => {
      const carPath = join(testDir, 'test.car')
      await createTestCarFile(carPath, [], [{ content: 'test content' }])

      const options: ImportOptions = {
        filePath: carPath,
        // No private key provided
      }

      await expect(runCarImport(options)).rejects.toThrow('process.exit called')
      expect(consoleMocks.error).toHaveBeenCalledWith('Import cancelled')
    })

    it('should use custom RPC URL if provided', async () => {
      const carPath = join(testDir, 'rpc.car')
      await createTestCarFile(carPath, [], [{ content: 'test content' }])

      const customRpcUrl = 'wss://custom.rpc.url/ws'
      const options: ImportOptions = {
        filePath: carPath,
        privateKey: testPrivateKey,
        rpcUrl: customRpcUrl,
      }

      const { initializeSynapse } = await import('../../core/synapse/index.js')
      const initSpy = vi.mocked(initializeSynapse)

      await runCarImport(options)

      expect(initSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          rpcUrl: customRpcUrl,
        }),
        expect.any(Object)
      )
    })
  })

  describe('Cleanup', () => {
    it('should call cleanup on success', async () => {
      const carPath = join(testDir, 'cleanup.car')
      await createTestCarFile(carPath, [], [{ content: 'test content' }])

      const { cleanupSynapseService } = await import('../../core/synapse/index.js')
      const cleanupSpy = vi.mocked(cleanupSynapseService)

      const options: ImportOptions = {
        filePath: carPath,
        privateKey: testPrivateKey,
      }

      await runCarImport(options)

      expect(cleanupSpy).toHaveBeenCalled()
    })

    it('should call cleanup on error', async () => {
      const { cleanupSynapseService } = await import('../../core/synapse/index.js')
      const cleanupSpy = vi.mocked(cleanupSynapseService)

      const options: ImportOptions = {
        filePath: 'nonexistent.car',
        privateKey: testPrivateKey,
      }

      await expect(runCarImport(options)).rejects.toThrow('process.exit called')
      expect(cleanupSpy).toHaveBeenCalled()
    })
  })

  describe('Upload Result', () => {
    it('should return complete import result', async () => {
      const carPath = join(testDir, 'result.car')
      const { cids } = await createTestCarFile(carPath, [], [{ content: 'test content' }])

      const cid = cids[0]
      if (!cid) throw new Error('No CID generated')

      // Recreate with proper root
      await createTestCarFile(carPath, [cid], [{ content: 'test content', cid }])

      const options: ImportOptions = {
        filePath: carPath,
        privateKey: testPrivateKey,
      }

      const result = await runCarImport(options)

      expect(result).toMatchObject({
        filePath: carPath,
        fileSize: expect.any(Number),
        rootCid: cid.toString(),
        pieceCid: expect.stringMatching(/^bafkzcib/), // CommP prefix
        pieceId: expect.any(Number),
        dataSetId: '123', // Mock returns string
      })

      // Provider info is always present
      expect(result.providerInfo).toBeDefined()
      expect(result.providerInfo.id).toBe(1)
      expect(result.providerInfo.name).toBe('Mock Provider')
    })
  })
})
