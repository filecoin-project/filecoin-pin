import { homedir, platform } from 'node:os'
import { join } from 'node:path'

export interface Config {
  port: number
  host: string
  privateKey: string | undefined
  rpcUrl: string
  databasePath: string
  carStoragePath: string
  logLevel: string
  warmStorageAddress: string | undefined
}

function getDataDirectory(): string {
  const home = homedir()
  const plat = platform()

  // Follow XDG Base Directory Specification on Linux
  if (plat === 'linux') {
    return process.env.XDG_DATA_HOME ?? join(home, '.local', 'share', 'filecoin-pin')
  }

  // macOS uses ~/Library/Application Support (same as config)
  if (plat === 'darwin') {
    return join(home, 'Library', 'Application Support', 'filecoin-pin')
  }

  // Windows uses %APPDATA%
  if (plat === 'win32') {
    return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'filecoin-pin')
  }

  // Fallback for other platforms
  return join(home, '.filecoin-pin')
}

export function createConfig(): Config {
  const dataDir = getDataDirectory()

  return {
    port: parseInt(process.env.PORT ?? '3456', 10),
    host: process.env.HOST ?? 'localhost',
    privateKey: process.env.PRIVATE_KEY,
    rpcUrl: process.env.RPC_URL ?? 'https://api.calibration.node.glif.io/rpc/v1',
    databasePath: process.env.DATABASE_PATH ?? join(dataDir, 'pins.db'),
    carStoragePath: process.env.CAR_STORAGE_PATH ?? join(dataDir, 'cars'),
    logLevel: process.env.LOG_LEVEL ?? 'info',
    warmStorageAddress: process.env.WARM_STORAGE_ADDRESS,
  }
}
