import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { RPC_URLS } from '@filoz/synapse-sdk'
import { describe, expect, it } from 'vitest'
import { createConfig } from '../../config.js'

describe('Config', () => {
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

    expect(config.port).toBe(3456)
    expect(config.host).toBe('localhost')
    expect(config.rpcUrl).toBe(RPC_URLS.calibration.websocket)
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

    // Clean up
    delete process.env.PORT
    delete process.env.HOST
    delete process.env.LOG_LEVEL
  })
})
