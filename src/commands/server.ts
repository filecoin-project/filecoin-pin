import { Command, Option } from 'commander'
import { startServer } from '../server.js'
import { addNetworkOptions } from '../utils/cli-options.js'

export const serverCommand = new Command('server')
  .description('Start the IPFS Pinning Service API server')
  .option('-p, --port <number>', 'server port', '3000')
  .option('--host <string>', 'server host', '127.0.0.1')
  .option('--car-storage <path>', 'path for CAR file storage', './cars')
  .option('--database <path>', 'path to SQLite database', './pins.db')
  .option('--private-key <key>', 'private key for Synapse (env: PRIVATE_KEY)')
  .option('--wallet-address <address>', 'wallet address for session key auth (env: WALLET_ADDRESS)')
  .option('--session-key <key>', 'session key for session key auth (env: SESSION_KEY)')
  .option('--access-token <token>', 'bearer token required on all API requests except GET / (env: ACCESS_TOKEN)')

addNetworkOptions(serverCommand)
  .addOption(
    new Option('--rpc-url <url>', 'RPC URL for Filecoin network (overrides --network)').env('RPC_URL')
    // default rpcUrl value is defined in ../common/get-rpc-url.ts
  )
  .action(async (options) => {
    // Override environment variables with CLI options if provided
    if (options.privateKey) {
      process.env.PRIVATE_KEY = options.privateKey
    }
    if (options.walletAddress) {
      process.env.WALLET_ADDRESS = options.walletAddress
    }
    if (options.sessionKey) {
      process.env.SESSION_KEY = options.sessionKey
    }
    if (options.accessToken) {
      process.env.ACCESS_TOKEN = options.accessToken
    }
    // RPC URL takes precedence over network flag
    if (options.rpcUrl) {
      process.env.RPC_URL = options.rpcUrl
    } else if (options.network) {
      process.env.NETWORK = options.network
    }
    if (options.carStorage) {
      process.env.CAR_STORAGE_PATH = options.carStorage
    }
    if (options.database) {
      process.env.DATABASE_PATH = options.database
    }
    if (options.port) {
      process.env.PORT = options.port
    }
    if (options.host) {
      process.env.HOST = options.host
    }

    await startServer()
  })
