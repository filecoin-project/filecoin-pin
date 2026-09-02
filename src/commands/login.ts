/**
 * Commander wiring for `login` and `logout`.
 *
 * `login` pairs this machine with a wallet through the Filecoin Cloud
 * console: it generates a scoped session key, the owner approves it in the
 * browser, and the CLI waits for the grant on-chain. `logout` forgets the
 * saved key.
 */

import { Command } from 'commander'
import { runLogin, runLogout } from '../login/index.js'
import { addNetworkOptions, rpcUrlOption, scopesOption } from '../utils/cli-options.js'

export const loginCommand = new Command('login')
  .description('Log in to your Filecoin account: approve a session key for this machine in the Filecoin Cloud console')
  .addOption(scopesOption('Comma-separated scopes to request (default: createDataSet,addPieces)'))
  .option('--fresh', 'Generate a new session key instead of resuming the saved one')
  .action(async (options) => {
    try {
      process.exitCode = await runLogin(options)
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    }
  })
addNetworkOptions(loginCommand).addOption(rpcUrlOption('RPC endpoint'))

export const logoutCommand = new Command('logout')
  .description('Log out: delete the saved session key from this machine')
  .action(() => {
    runLogout()
  })
