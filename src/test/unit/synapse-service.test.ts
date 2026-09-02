// Value import of the mocked module (vi.mock below replaces it at runtime).
import {
  AddPiecesPermission,
  CreateDataSetPermission,
  fromSecp256k1,
  SchedulePieceRemovalsPermission,
  TerminateServicePermission,
} from '@filoz/synapse-core/session-key'
import { Synapse } from '@filoz/synapse-sdk'
import { CID } from 'multiformats/cid'
import type { Logger } from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initializeSynapse, type SynapseSetupConfig } from '../../core/synapse/index.js'
import { uploadToSynapse } from '../../core/upload/synapse.js'
import { createLogger } from '../../logger.js'
import { MockSynapse } from '../mocks/synapse-mocks.js'

// Mock the Synapse SDK
vi.mock('@filoz/synapse-sdk', async () => await import('../mocks/synapse-sdk.js'))

// Mock the session key module so tests never hit the real network
vi.mock('@filoz/synapse-core/session-key', async () => await import('../mocks/synapse-core-session-key.js'))

// Mock the chainId probe so tests never hit a real RPC endpoint
vi.mock('../../core/synapse/resolve-chain-from-rpc.js', async () => {
  const { calibration } = await import('../mocks/synapse-sdk.js')
  return { resolveChainFromRpc: vi.fn(async () => calibration) }
})

// Test CID for upload tests
const TEST_CID = CID.parse('bafkreia5fn4rmshmb7cl7fufkpcw733b5anhuhydtqstnglpkzosqln5kq')

describe('synapse-service', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createLogger({ logLevel: 'info' })
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('initializeSynapse', () => {
    it('should initialize Synapse with private key config', async () => {
      const config: SynapseSetupConfig = {
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
        rpcUrl: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1',
      }

      const synapse = await initializeSynapse(config, logger)
      expect(synapse).toBeDefined()
    })

    it('should log initialization events', async () => {
      const infoSpy = vi.spyOn(logger, 'info')
      const config: SynapseSetupConfig = {
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
        rpcUrl: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1',
      }

      await initializeSynapse(config, logger)

      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'synapse.init', mode: 'private-key' }),
        'Initializing Synapse'
      )

      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'synapse.init.success' }),
        'Synapse initialized'
      )
    })

    it('should initialize Synapse in read-only mode', async () => {
      const config: SynapseSetupConfig = {
        walletAddress: '0x0000000000000000000000000000000000000002',
        readOnly: true,
        rpcUrl: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1',
      }

      const infoSpy = vi.spyOn(logger, 'info')
      const synapse = await initializeSynapse(config, logger)

      expect(synapse).toBeDefined()
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'synapse.init', mode: 'read-only' }),
        'Initializing Synapse (read-only)'
      )
    })

    it('should initialize Synapse in session-key mode', async () => {
      const config: SynapseSetupConfig = {
        walletAddress: '0x0000000000000000000000000000000000000002',
        sessionKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
        rpcUrl: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1',
      }

      const infoSpy = vi.spyOn(logger, 'info')
      const synapse = await initializeSynapse(config, logger)

      expect(synapse).toBeDefined()
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'synapse.init', mode: 'session-key' }),
        'Initializing Synapse (session key)'
      )
    })

    // Queue a one-shot session key whose only meaningful behaviour is hasPermission
    // and expirations. initializeSynapse touches just syncExpirations/hasPermission/
    // expirations/address, so the partial object is cast to the concrete (unexported)
    // class the real fromSecp256k1 returns.
    const mockSessionKeyOnce = (hasPermission: (p: string) => boolean, expirations: Record<string, bigint>) => {
      vi.mocked(fromSecp256k1).mockImplementationOnce((() => ({
        syncExpirations: vi.fn().mockResolvedValue(undefined),
        expirations,
        address: '0x0000000000000000000000000000000000000001',
        hasPermission: vi.fn(hasPermission),
      })) as unknown as typeof fromSecp256k1)
    }

    it('should not require any permission by default (read-only commands)', async () => {
      mockSessionKeyOnce(() => false, {}) // key granted nothing; no requiredPermissions means nothing to check

      const config: SynapseSetupConfig = {
        walletAddress: '0x0000000000000000000000000000000000000002',
        sessionKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
        rpcUrl: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1',
      }

      await expect(initializeSynapse(config, logger)).resolves.toBeDefined()
    })

    it('should reject only the missing scope, with a console-first remediation message', async () => {
      // Grant everything except AddPieces — a live grant exists, so this is case 3
      // (missing scope), not case 2 (never authorized at all).
      mockSessionKeyOnce((p) => p !== AddPiecesPermission, {
        [CreateDataSetPermission]: 9999999999n,
        [AddPiecesPermission]: 0n,
        [SchedulePieceRemovalsPermission]: 9999999999n,
        [TerminateServicePermission]: 9999999999n,
      })

      const previousConsoleUrl = process.env.CONSOLE_URL
      process.env.CONSOLE_URL = 'https://pay.example.test'
      try {
        const config: SynapseSetupConfig = {
          walletAddress: '0x0000000000000000000000000000000000000002',
          sessionKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
          rpcUrl: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1',
          requiredPermissions: [AddPiecesPermission],
        }

        const error = await initializeSynapse(config, logger).then(
          () => null,
          (e: unknown) => e as Error
        )
        expect(error).not.toBeNull()
        expect(error?.message).toContain('lacks AddPieces for this operation on ')
        expect(error?.message).not.toContain('TerminateService')
        expect(error?.message).toContain(
          'https://pay.example.test/console/session-keys?authorize=0x0000000000000000000000000000000000000001&scopes=addPieces'
        )
        expect(error?.message).toContain(
          'filecoin-pin session authorize 0x0000000000000000000000000000000000000001 --scopes addPieces'
        )
        expect(error?.message).not.toContain('filecoin-pin session create')
        expect(error?.message).toContain('Then re-run this command.')
      } finally {
        if (previousConsoleUrl == null) {
          delete process.env.CONSOLE_URL
        } else {
          process.env.CONSOLE_URL = previousConsoleUrl
        }
      }
    })

    it('should say a previously granted scope expired, with its timestamp, rather than the generic wording', async () => {
      // AddPieces WAS granted and lapsed (nonzero past expiry); another grant is
      // still live, so this is the missing-scope shape, not never-authorized.
      mockSessionKeyOnce((p) => p !== AddPiecesPermission, {
        [CreateDataSetPermission]: 9999999999n,
        [AddPiecesPermission]: 1000n, // 1970-01-01T00:16:40.000Z — unambiguously past
        [SchedulePieceRemovalsPermission]: 9999999999n,
        [TerminateServicePermission]: 9999999999n,
      })

      const config: SynapseSetupConfig = {
        walletAddress: '0x0000000000000000000000000000000000000002',
        sessionKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
        rpcUrl: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1',
        requiredPermissions: [AddPiecesPermission],
      }

      const error = await initializeSynapse(config, logger).then(
        () => null,
        (e: unknown) => e as Error
      )
      expect(error).not.toBeNull()
      expect(error?.message).toContain('lacks AddPieces for this operation on ')
      expect(error?.message).toContain('AddPieces: expired at 1970-01-01T00:16:40.000Z')
      expect(error?.message).not.toContain('never granted')
    })

    it('should say the session expired, with the lapse date, when every needed grant has lapsed', async () => {
      mockSessionKeyOnce(() => false, {
        [CreateDataSetPermission]: 1000n,
        [AddPiecesPermission]: 2000n, // 1970-01-01, unambiguously past
        [SchedulePieceRemovalsPermission]: 0n,
        [TerminateServicePermission]: 0n,
      })

      const config: SynapseSetupConfig = {
        walletAddress: '0x0000000000000000000000000000000000000002',
        sessionKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
        rpcUrl: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1',
        requiredPermissions: [CreateDataSetPermission, AddPiecesPermission],
      }

      const error = await initializeSynapse(config, logger).then(
        () => null,
        (e: unknown) => e as Error
      )
      expect(error?.message).toContain(
        'Session expired (key 0x0000000000000000000000000000000000000001, grants lapsed 1970-01-01)'
      )
      expect(error?.message).toContain('Renew it:  filecoin-pin login')
      // One remedy only: no console link and no owner CLI hints on the expired wall.
      expect(error?.message).not.toContain('console')
      expect(error?.message).not.toContain('session authorize')
    })

    it("should use the 'never authorized, or expired/revoked' wording when the key holds no live grant", async () => {
      mockSessionKeyOnce(() => false, {
        [CreateDataSetPermission]: 0n,
        [AddPiecesPermission]: 0n,
        [SchedulePieceRemovalsPermission]: 0n,
        [TerminateServicePermission]: 0n,
      })

      const config: SynapseSetupConfig = {
        walletAddress: '0x0000000000000000000000000000000000000002',
        sessionKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
        rpcUrl: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1',
        requiredPermissions: [AddPiecesPermission],
      }

      const error = await initializeSynapse(config, logger).then(
        () => null,
        (e: unknown) => e as Error
      )
      expect(error).not.toBeNull()
      expect(error?.message).toContain("isn't authorized for account 0x0000000000000000000000000000000000000002 on ")
      expect(error?.message).toContain('the key is for a different network (check --network)')
      expect(error?.message).toContain('AddPieces: never granted')
      expect(error?.message).toContain('filecoin-pin session create --scopes addPieces')
    })

    it('should pass when the key holds exactly the required permissions', async () => {
      const granted: Record<string, true> = { [AddPiecesPermission]: true, [CreateDataSetPermission]: true }
      mockSessionKeyOnce((p) => granted[p] === true, {
        [CreateDataSetPermission]: 9999999999n,
        [AddPiecesPermission]: 9999999999n,
      })

      const config: SynapseSetupConfig = {
        walletAddress: '0x0000000000000000000000000000000000000002',
        sessionKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
        rpcUrl: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1',
        requiredPermissions: [AddPiecesPermission, CreateDataSetPermission],
      }

      await expect(initializeSynapse(config, logger)).resolves.toBeDefined()
      // The SDK's own gate defaults to all four permissions; the preflight
      // result only holds if the same subset reaches Synapse.create.
      expect(vi.mocked(Synapse.create)).toHaveBeenCalledWith(
        expect.objectContaining({ requiredPermissions: [AddPiecesPermission, CreateDataSetPermission] })
      )
    })

    it('should forward an empty permission list to Synapse.create when none are required', async () => {
      mockSessionKeyOnce(() => false, {})

      const config: SynapseSetupConfig = {
        walletAddress: '0x0000000000000000000000000000000000000002',
        sessionKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
        rpcUrl: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1',
      }

      await initializeSynapse(config, logger)
      expect(vi.mocked(Synapse.create)).toHaveBeenCalledWith(expect.objectContaining({ requiredPermissions: [] }))
    })

    it('should throw when no authentication is provided', async () => {
      // AccountConfig with null account satisfies the type but triggers the no-auth branch
      const config = { rpcUrl: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1' } as any

      await expect(initializeSynapse(config, logger)).rejects.toThrow('No credentials found')
    })

    it('should throw when walletAddress is provided without sessionKey', async () => {
      const config = { walletAddress: '0x1234567890123456789012345678901234567890' } as any

      await expect(initializeSynapse(config, logger)).rejects.toThrow('Missing: --session-key / SESSION_KEY')
    })

    it('should throw when sessionKey is provided without walletAddress', async () => {
      const config = {
        sessionKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      } as any

      await expect(initializeSynapse(config, logger)).rejects.toThrow('Missing: --wallet-address / WALLET_ADDRESS')
    })

    it('should throw a flag-specific error when sessionKey is not a hex private key', async () => {
      const config = {
        walletAddress: '0x0000000000000000000000000000000000000002',
        sessionKey: 'not-a-private-key',
        rpcUrl: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1',
      } as any

      await expect(initializeSynapse(config, logger)).rejects.toThrow(
        'Invalid --session-key / SESSION_KEY: expected the session key private key'
      )
    })

    it('should explain when the session address is passed as sessionKey', async () => {
      const config = {
        walletAddress: '0x0000000000000000000000000000000000000002',
        sessionKey: '0x1234567890123456789012345678901234567890',
        rpcUrl: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1',
      } as any

      await expect(initializeSynapse(config, logger)).rejects.toThrow(
        'this looks like an address, but the session key private key'
      )
    })

    it('should name --session-key when the SDK rejects a well-formed key (e.g. out of curve range)', async () => {
      const { fromSecp256k1 } = await import('@filoz/synapse-core/session-key')
      vi.mocked(fromSecp256k1).mockImplementationOnce(() => {
        // Mirrors viem's privateKeyToAccount error for a zero scalar
        throw new Error('expected valid private key: 1 <= n < 1157920892…, got 0')
      })

      const config = {
        walletAddress: '0x0000000000000000000000000000000000000002',
        sessionKey: `0x${'0'.repeat(64)}`,
        rpcUrl: 'wss://wss.calibration.node.glif.io/apigw/lotus/rpc/v1',
      } as any

      await expect(initializeSynapse(config, logger)).rejects.toThrow(
        'Invalid --session-key / SESSION_KEY: expected valid private key'
      )
    })

    it('should report a malformed sessionKey before probing the RPC endpoint', async () => {
      const { resolveChainFromRpc } = await import('../../core/synapse/resolve-chain-from-rpc.js')

      const config = {
        walletAddress: '0x0000000000000000000000000000000000000002',
        sessionKey: 'not-a-private-key',
        rpcUrl: 'wss://unreachable.example.com/rpc/v1',
      } as any

      await expect(initializeSynapse(config, logger)).rejects.toThrow(
        'Invalid --session-key / SESSION_KEY: expected the session key private key'
      )
      expect(resolveChainFromRpc).not.toHaveBeenCalled()
    })
  })

  describe('initializeSynapse chain resolution', () => {
    it('uses the chain probed from the RPC URL when no chain hint is provided', async () => {
      const { resolveChainFromRpc } = await import('../../core/synapse/resolve-chain-from-rpc.js')
      const { Synapse, calibration } = await import('../mocks/synapse-sdk.js')
      vi.mocked(resolveChainFromRpc).mockResolvedValueOnce(calibration as never)

      await initializeSynapse({
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
        rpcUrl: 'wss://example.test/rpc',
      })

      expect(resolveChainFromRpc).toHaveBeenCalledTimes(1)
      const lastCall = vi.mocked(Synapse.create).mock.calls.at(-1) as unknown as [{ chain: unknown }]
      expect(lastCall[0]).toMatchObject({ chain: calibration })
    })

    it('lets the RPC probe override a chain hint passed by a programmatic caller', async () => {
      const { resolveChainFromRpc } = await import('../../core/synapse/resolve-chain-from-rpc.js')
      const { Synapse, mainnet, calibration } = await import('../mocks/synapse-sdk.js')
      vi.mocked(resolveChainFromRpc).mockResolvedValueOnce(calibration as never)

      await initializeSynapse({
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
        rpcUrl: 'wss://example.test/rpc',
        chain: mainnet as never,
      })

      const lastCall = vi.mocked(Synapse.create).mock.calls.at(-1) as unknown as [{ chain: unknown }]
      expect(lastCall[0]).toMatchObject({ chain: calibration })
    })

    it('skips probing when no RPC URL is provided and falls back to mainnet', async () => {
      const { resolveChainFromRpc } = await import('../../core/synapse/resolve-chain-from-rpc.js')
      const { Synapse, mainnet } = await import('../mocks/synapse-sdk.js')
      vi.mocked(resolveChainFromRpc).mockClear()

      await initializeSynapse({
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
      })

      expect(resolveChainFromRpc).not.toHaveBeenCalled()
      const lastCall = vi.mocked(Synapse.create).mock.calls.at(-1) as unknown as [{ chain: unknown }]
      expect(lastCall[0]).toMatchObject({ chain: mainnet })
    })
  })

  describe('uploadToSynapse', () => {
    let mockSynapse: MockSynapse

    beforeEach(async () => {
      mockSynapse = new MockSynapse()
      // Ensure internal storage context is created
      await mockSynapse.createStorageContext()
    })

    it('should upload data successfully', async () => {
      const data = new Uint8Array([1, 2, 3])
      const contextId = 'pin-123'

      const result = await uploadToSynapse(mockSynapse as any, data, TEST_CID, logger, { contextId })

      expect(result).toHaveProperty('pieceCid')
      expect(result).toHaveProperty('copies')
      expect(result).toHaveProperty('failedAttempts')
      expect(result.pieceCid).toMatch(/^bafkzcib/)
      expect(result.copies).toHaveLength(1)
      expect(result.failedAttempts).toHaveLength(0)
    })

    it('should log upload events', async () => {
      const infoSpy = vi.spyOn(logger, 'info')
      const data = new Uint8Array([1, 2, 3])
      const contextId = 'pin-456'

      await uploadToSynapse(mockSynapse as any, data, TEST_CID, logger, { contextId })

      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'synapse.upload.stored',
          contextId,
        }),
        'Piece stored on provider'
      )

      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'synapse.upload.success',
          contextId,
        }),
        'Successfully uploaded to Filecoin with Synapse'
      )
    })

    it('should call upload callbacks', async () => {
      const progressEvents: number[] = []
      let storedCallbackCalled = false
      let piecesAddedCallbackCalled = false

      const data = new Uint8Array([1, 2, 3])
      await uploadToSynapse(mockSynapse as any, data, TEST_CID, logger, {
        contextId: 'pin-789',
        onProgress(event) {
          switch (event.type) {
            case 'uploadProgress': {
              progressEvents.push(event.data.bytesUploaded)
              break
            }
            case 'stored': {
              storedCallbackCalled = true
              break
            }
            case 'piecesAdded': {
              piecesAddedCallbackCalled = true
              break
            }
          }
        },
      })

      expect(progressEvents).toEqual([3])
      expect(storedCallbackCalled).toBe(true)
      expect(piecesAddedCallbackCalled).toBe(true)
    })

    it('should log byte-level upload progress events', async () => {
      const debugSpy = vi.spyOn(logger, 'debug')
      const data = new Uint8Array([1, 2, 3, 4])
      const contextId = 'pin-progress'

      await uploadToSynapse(mockSynapse as any, data, TEST_CID, logger, { contextId })

      expect(debugSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'synapse.upload.progress',
          contextId,
          bytesUploaded: 4,
        }),
        'Upload progress update'
      )
    })

    it('should throw immediately when signal is already aborted', async () => {
      const data = new Uint8Array([1, 2, 3])
      const abortController = new AbortController()
      abortController.abort()

      await expect(
        uploadToSynapse(mockSynapse as any, data, TEST_CID, logger, {
          contextId: 'pin-abort',
          signal: abortController.signal,
        })
      ).rejects.toThrow('This operation was aborted')
    })

    it('should pass signal to storage.upload', async () => {
      const data = new Uint8Array([1, 2, 3])
      const abortController = new AbortController()
      const uploadSpy = vi.spyOn(mockSynapse.storage, 'upload')

      await uploadToSynapse(mockSynapse as any, data, TEST_CID, logger, {
        contextId: 'pin-signal',
        signal: abortController.signal,
      })

      expect(uploadSpy).toHaveBeenCalledWith(
        data,
        expect.objectContaining({
          signal: abortController.signal,
        })
      )
    })

    it('should pass ReadableStream data directly to storage.upload', async () => {
      const data = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]))
          controller.close()
        },
      })
      const uploadSpy = vi.spyOn(mockSynapse.storage, 'upload')

      await uploadToSynapse(mockSynapse as any, data, TEST_CID, logger, {
        contextId: 'pin-stream',
      })

      expect(uploadSpy).toHaveBeenCalledWith(data, expect.anything())
    })
  })

  describe('Multi-copy Results', () => {
    it('should return copies array in upload result', async () => {
      const mockSynapse = new MockSynapse()
      await mockSynapse.createStorageContext()

      const data = new Uint8Array([1, 2, 3])
      const result = await uploadToSynapse(mockSynapse as any, data, TEST_CID, logger, {
        contextId: 'test-upload',
      })

      expect(result.copies).toBeDefined()
      expect(result.copies).toHaveLength(1)
      const primaryCopy = result.copies[0]
      expect(primaryCopy).toBeDefined()
      expect(primaryCopy?.role).toBe('primary')
      expect(primaryCopy?.providerId).toBe(1n)
      expect(primaryCopy?.dataSetId).toBe(123n)
      expect(primaryCopy?.retrievalUrl).toContain('/pdp/piece/')
    })

    it('should return empty failedAttempts array on success', async () => {
      const mockSynapse = new MockSynapse()
      await mockSynapse.createStorageContext()

      const data = new Uint8Array([1, 2, 3])
      const result = await uploadToSynapse(mockSynapse as any, data, TEST_CID, logger, {
        contextId: 'test-upload',
      })

      expect(result.failedAttempts).toBeDefined()
      expect(result.failedAttempts).toHaveLength(0)
    })
  })
})
