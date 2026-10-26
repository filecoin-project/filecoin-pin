/**
 * Commander wiring for `login` and `logout`.
 *
 * `login` pairs this machine with a wallet through the Filecoin Cloud
 * console: it generates a scoped session key, the owner approves it in the
 * browser, and the CLI waits for the grant on-chain. With `encrypt` in
 * `--scopes` it also takes the group key Grant the console issues. `logout`
 * forgets the saved key and its Grant.
 */

import { Command, InvalidArgumentError } from 'commander'
import pc from 'picocolors'
import { runLogin, runLogout } from '../login/index.js'
import { addNetworkOptions, rpcUrlOption, scopesOption } from '../utils/cli-options.js'

function parseTimeoutSeconds(value: string): number {
  const seconds = Number(value)
  if (!Number.isInteger(seconds) || seconds <= 0) throw new InvalidArgumentError('Expected a whole number of seconds.')
  return seconds
}

export const loginCommand = new Command('login')
  .description('Log in to your Filecoin account: approve a session key for this machine in the Filecoin Cloud console')
  .addOption(
    scopesOption(
      'Comma-separated scopes to request (default: createDataSet,addPieces). Add encrypt to also get a group key Grant for encrypted uploads'
    )
  )
  .option(
    '--grant <grant>',
    'Import the group key Grant (fgr1_…) the console showed for the saved session key; - reads it from stdin'
  )
  .option('--fresh', 'Generate a new session key instead of resuming the saved one')
  .option('--no-browser', 'Print the console link without opening a browser')
  .option('--no-wait', 'Print the console link and exit 2 instead of waiting for the grant; rerun login to check')
  .option('--timeout <seconds>', 'How long to wait for the grant (default: 300)', parseTimeoutSeconds)
  .addHelpText(
    'after',
    `
${pc.bold('EXAMPLES')}
  $ filecoin-pin login
  $ filecoin-pin login --network calibration
  $ filecoin-pin login --scopes createDataSet,addPieces,encrypt   # also get a group key Grant
  $ filecoin-pin login --no-browser --no-wait                     # print the link, approve later, rerun to check
  $ filecoin-pin login --grant fgr1_…                             # finish: import the Grant the console showed
  $ pbpaste | filecoin-pin login --grant -                        # the same, reading the Grant from stdin

${pc.bold('FILES')}
  The session key is saved to session.env in the data directory before the
  browser opens (owner-readable only), so an interrupted login resumes the
  same key. A group key Grant is saved there too, as GROUP_KEY_ID and
  GROUP_KEY_GRANT. \`filecoin-pin logout\` deletes the file.

${pc.bold('GROUP KEY GRANTS')}
  With encrypt, the console also wraps your group key to this session key.
  On a terminal, login asks you to paste the Grant; otherwise (and with
  --no-wait) it prints the resume command and never blocks. The Grant gives
  this key permanent read access to the whole group key, including future
  uploads: expiry and revoking the key do not take it back.

${pc.bold('ENVIRONMENT')}
  CONSOLE_URL   Filecoin Cloud console base URL (default: https://pay.filecoin.cloud)
  BROWSER=none  never open a browser
  NETWORK, RPC_URL  as --network and --rpc-url

${pc.bold('EXIT CODES')}
  0  every requested scope was granted (and the Grant saved, with encrypt)
  2  no grant seen in time, --no-wait, fewer scopes than requested, or the Grant
     is still to come (rerun login, or login --grant, to resume)
  1  error, including a network the console has no pairing page for`
  )
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
  .description(
    'Log out: delete the saved session key from this machine (local only; the on-chain grant stays until it expires)'
  )
  .action(() => {
    try {
      runLogout()
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    }
  })
