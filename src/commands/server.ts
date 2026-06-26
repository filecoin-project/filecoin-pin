import { Command, Option } from 'commander'
import { startServer } from '../server.js'
import { addNetworkOptions, addSigningAuthOptions, rpcUrlOption } from '../utils/cli-options.js'

export const serverCommand = new Command('server')
  .description('Run a local IPFS Pinning Service API server')
  .addOption(new Option('-p, --port <number>', 'server port').env('PORT').default('3000'))
  .addOption(new Option('--host <string>', 'server host').env('HOST').default('127.0.0.1'))
  .option('--car-storage <path>', 'path for CAR file storage', './cars')
  .option('--database <path>', 'path to SQLite database', './pins.db')
  .addOption(
    new Option('--access-token <token>', 'bearer token required on all API requests except GET /').env('ACCESS_TOKEN')
  )
  .option(
    // ALLOW_NO_AUTH is intentionally NOT bound via .env(): Commander treats a
    // defined env var as true for boolean options regardless of its value,
    // while the config loader requires ALLOW_NO_AUTH === 'true'. Binding it
    // would turn ALLOW_NO_AUTH=false into an enabled flag.
    '--allow-no-auth',
    'start the server without an access token, serving all requests unauthenticated (env: ALLOW_NO_AUTH)'
  )

addSigningAuthOptions(serverCommand)
addNetworkOptions(serverCommand)
  .addOption(
    rpcUrlOption('RPC URL for Filecoin network (overrides --network)')
    // default rpcUrl value is defined in ../common/get-rpc-url.ts
  )
  .action(async (options) => {
    // Copy parsed option values into process.env for startServer's config
    // loader. Options with .env() bindings may already hold the env value,
    // so a truthy option does not imply the flag was passed on the command
    // line (use command.getOptionValueSource() to distinguish).
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
    if (options.allowNoAuth) {
      process.env.ALLOW_NO_AUTH = 'true'
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
