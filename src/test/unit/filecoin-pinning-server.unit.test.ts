import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConfig } from '../../config.js'
import { createFilecoinPinningServer } from '../../filecoin-pinning-server.js'
import { createLogger } from '../../logger.js'

vi.mock('@filoz/synapse-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@filoz/synapse-sdk')>()
  const mockModule = await import('../mocks/synapse-sdk.js')
  return { ...mockModule, SIZE_CONSTANTS: actual.SIZE_CONSTANTS }
})

vi.mock('@filoz/synapse-core/session-key', async () => await import('../mocks/synapse-core-session-key.js'))

const SERVICE_INFO = { service: 'filecoin-pin', version: '0.1.0' }
const TEST_OUTPUT_DIR = './test-unit-pinning-server-cars'

describe('createFilecoinPinningServer auth selection', () => {
  let server: any
  let pinStore: any

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(async () => {
    if (server != null) {
      await server.close()
      server = undefined
    }
    if (pinStore != null) {
      await pinStore.stop()
      pinStore = undefined
    }
  })

  it('should start successfully with session key auth (walletAddress + sessionKey)', async () => {
    const config = {
      ...createConfig(),
      carStoragePath: TEST_OUTPUT_DIR,
      port: 0,
      privateKey: undefined,
      walletAddress: '0x0000000000000000000000000000000000000002',
      sessionKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
    }
    const logger = createLogger(config)

    const result = await createFilecoinPinningServer(config, logger, SERVICE_INFO)
    server = result.server
    pinStore = result.pinStore

    expect(server).toBeDefined()
    expect(pinStore).toBeDefined()
  })

  it('should throw "No authentication configured" when neither privateKey nor sessionKey provided', async () => {
    const config = {
      ...createConfig(),
      carStoragePath: TEST_OUTPUT_DIR,
      port: 0,
      privateKey: undefined,
      walletAddress: undefined,
      sessionKey: undefined,
    }
    const logger = createLogger(config)

    await expect(createFilecoinPinningServer(config, logger, SERVICE_INFO)).rejects.toThrow(
      'No authentication configured'
    )
  })

  it('should include --private-key and --session-key hints in the no-auth error message', async () => {
    const config = {
      ...createConfig(),
      carStoragePath: TEST_OUTPUT_DIR,
      port: 0,
      privateKey: undefined,
      walletAddress: undefined,
      sessionKey: undefined,
    }
    const logger = createLogger(config)

    await expect(createFilecoinPinningServer(config, logger, SERVICE_INFO)).rejects.toThrow(
      /--private-key.*PRIVATE_KEY|--wallet-address.*--session-key/
    )
  })

  it('should throw when walletAddress is set but sessionKey is missing', async () => {
    const config = {
      ...createConfig(),
      carStoragePath: TEST_OUTPUT_DIR,
      port: 0,
      privateKey: undefined,
      walletAddress: '0x0000000000000000000000000000000000000002',
      sessionKey: undefined,
    }
    const logger = createLogger(config)

    await expect(createFilecoinPinningServer(config, logger, SERVICE_INFO)).rejects.toThrow(
      'No authentication configured'
    )
  })

  it('should throw when walletAddress is not a valid ethereum address', async () => {
    const config = {
      ...createConfig(),
      carStoragePath: TEST_OUTPUT_DIR,
      port: 0,
      privateKey: undefined,
      walletAddress: 'not-an-address',
      sessionKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
    }
    const logger = createLogger(config)

    await expect(createFilecoinPinningServer(config, logger, SERVICE_INFO)).rejects.toThrow(
      'Wallet address must be an ethereum address'
    )
  })

  it('should throw when sessionKey is not 0x-prefixed hex', async () => {
    const config = {
      ...createConfig(),
      carStoragePath: TEST_OUTPUT_DIR,
      port: 0,
      privateKey: undefined,
      walletAddress: '0x0000000000000000000000000000000000000002',
      sessionKey: 'not-hex-at-all',
    }
    const logger = createLogger(config)

    await expect(createFilecoinPinningServer(config, logger, SERVICE_INFO)).rejects.toThrow(
      'Session key must be 0x-prefixed hexadecimal'
    )
  })

  it('should throw when sessionKey is valid hex but not 32 bytes', async () => {
    const config = {
      ...createConfig(),
      carStoragePath: TEST_OUTPUT_DIR,
      port: 0,
      privateKey: undefined,
      walletAddress: '0x0000000000000000000000000000000000000002',
      sessionKey: '0x1234',
    }
    const logger = createLogger(config)

    await expect(createFilecoinPinningServer(config, logger, SERVICE_INFO)).rejects.toThrow(
      'Session key must be 32 bytes'
    )
  })

  it('should throw when privateKey is not valid hex', async () => {
    const config = {
      ...createConfig(),
      carStoragePath: TEST_OUTPUT_DIR,
      port: 0,
      privateKey: 'not-a-hex-key',
      walletAddress: undefined,
      sessionKey: undefined,
    }
    const logger = createLogger(config)

    await expect(createFilecoinPinningServer(config, logger, SERVICE_INFO)).rejects.toThrow(
      'Private key must be 0x-prefixed hexadecimal'
    )
  })

  it('should throw when privateKey is valid hex but not 32 bytes', async () => {
    const config = {
      ...createConfig(),
      carStoragePath: TEST_OUTPUT_DIR,
      port: 0,
      privateKey: '0x1234',
      walletAddress: undefined,
      sessionKey: undefined,
    }
    const logger = createLogger(config)

    await expect(createFilecoinPinningServer(config, logger, SERVICE_INFO)).rejects.toThrow(
      'Private key must be 32 bytes'
    )
  })
})
