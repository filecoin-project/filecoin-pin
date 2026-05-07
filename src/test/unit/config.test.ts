import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { calibration, mainnet } from '@filoz/synapse-sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createConfig } from '../../config.js'

describe('Config', () => {
  const originalEnv = {
    host: process.env.HOST,
    logLevel: process.env.LOG_LEVEL,
    network: process.env.NETWORK,
    port: process.env.PORT,
    rpcUrl: process.env.RPC_URL,
  }

  beforeEach(() => {
    delete process.env.HOST
    delete process.env.LOG_LEVEL
    delete process.env.NETWORK
    delete process.env.PORT
    delete process.env.RPC_URL
  })

  afterEach(() => {
    if (originalEnv.host === undefined) delete process.env.HOST
    else process.env.HOST = originalEnv.host

    if (originalEnv.logLevel === undefined) delete process.env.LOG_LEVEL
    else process.env.LOG_LEVEL = originalEnv.logLevel

    if (originalEnv.network === undefined) delete process.env.NETWORK
    else process.env.NETWORK = originalEnv.network

    if (originalEnv.port === undefined) delete process.env.PORT
    else process.env.PORT = originalEnv.port

    if (originalEnv.rpcUrl === undefined) delete process.env.RPC_URL
    else process.env.RPC_URL = originalEnv.rpcUrl
  })

  it('should create default config', () => {
    const config = createConfig()

    // Get expected data directory based on platform
    const home = homedir()
    const plat = platform()
    let expectedDataDir: string

    if (plat === 'linux') {
      expectedDataDir = process.env.XDG_DATA_HOME ?? join(home, '.local', 'share', 'filecoin-pin')
    } else if (plat === 'darwin') {
      expectedDataDir = join(home, 'Library', 'Application Support', 'filecoin-pin')
    } else if (plat === 'win32') {
      expectedDataDir = join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'filecoin-pin')
    } else {
      expectedDataDir = join(home, '.filecoin-pin')
    }

    const expectedRpcUrl = mainnet.rpcUrls.default.webSocket?.[0] ?? mainnet.rpcUrls.default.http[0]

    expect(config.port).toBe(3456)
    expect(config.host).toBe('localhost')
    expect(config.rpcUrl).toBe(expectedRpcUrl)
    expect(config.databasePath).toBe(join(expectedDataDir, 'pins.db'))
    expect(config.carStoragePath).toBe(join(expectedDataDir, 'cars'))
    expect(config.logLevel).toBe('info')
  })

  it('should use environment variables when provided', () => {
    process.env.PORT = '8080'
    process.env.HOST = '0.0.0.0'
    process.env.LOG_LEVEL = 'debug'

    const config = createConfig()

    expect(config.port).toBe(8080)
    expect(config.host).toBe('0.0.0.0')
    expect(config.logLevel).toBe('debug')
  })

  it('resolves chain from NETWORK so Synapse uses matching contracts', () => {
    process.env.NETWORK = 'mainnet'
    expect(createConfig().chain).toBe(mainnet)

    process.env.NETWORK = 'calibration'
    expect(createConfig().chain).toBe(calibration)
  })

  it('defaults chain to mainnet when NETWORK is not set', () => {
    expect(createConfig().chain).toBe(mainnet)
  })

  it('leaves chain undefined when only RPC_URL is set so initializeSynapse can probe it', () => {
    process.env.RPC_URL = 'wss://custom.example/rpc'
    expect(createConfig().chain).toBeUndefined()
  })

  it('throws when both NETWORK and RPC_URL are set', () => {
    process.env.NETWORK = 'mainnet'
    process.env.RPC_URL = 'wss://custom.example/rpc'
    expect(() => createConfig()).toThrow(/'NETWORK' and 'RPC_URL' are mutually exclusive/)
  })
})
