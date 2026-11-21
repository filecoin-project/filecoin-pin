/**
 * Commander wiring for `login` and `logout`.
 *
 * `login` pairs this machine with a wallet through the Filecoin Cloud
 * console: it generates a scoped session key, the owner approves it in the
 * browser, and the CLI waits for the authorization on-chain. With `encrypt` in
 * `--scopes` it also takes the group key Grant the console issues. `logout`
 * forgets the saved key and its Grant.
 */

import { Command, InvalidArgumentError } from 'commander'
import pc from 'picocolors'
import { runLogin, runLogout } from '../login/index.js'
import { addNetworkOptions, rpcUrlOption, scopesOption } from '../utils/cli-options.js'

function parseDelegationDepth(value: string): number {
  if (!/^\d$/.test(value) || Number(value) > 7) throw new InvalidArgumentError('Expected a whole number from 0 to 7.')
  return Number(value)
}

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
  .option(
    '--group <path>',
    'Ask for a Grant to this group (a/b/c) instead of the whole group key; the Grant also covers every group beneath it. Implies encrypt. Each --group login adds a Grant and keeps the ones saved before'
  )
  .option(
    '--delegation-depth <n>',
    'How many links this session key may add below its Grant (0-7, console default 7): 0 cannot delegate at all, 1 can delegate one piece (as a share link of a private upload does), higher lets those keys delegate further. A Grant that allows more than this is refused',
    parseDelegationDepth
  )
  .option(
    '--private-uploads',
    'Make every add on this machine private (as add --private; add --public opts one out). Saved with the login; no console step'
  )
  .option('--no-private-uploads', 'Turn --private-uploads off again')
  .option('--fresh', 'Generate a new session key instead of resuming the saved one')
  .option('--no-browser', 'Print the console link without opening a browser')
  .option(
    '--no-wait',
    'Print the console link and exit 2 instead of waiting for the authorization; rerun login to check'
  )
  .option('--timeout <seconds>', 'How long to wait for the authorization (default: 300)', parseTimeoutSeconds)
  .addHelpText(
    'after',
    `
${pc.bold('EXAMPLES')}
  $ filecoin-pin login
  $ filecoin-pin login --network calibration
  $ filecoin-pin login --scopes createDataSet,addPieces,encrypt   # also get a group key Grant
  $ filecoin-pin login --group team/design                        # a Grant for one group (and beneath it)
  $ filecoin-pin login --group backups/ci --delegation-depth 0    # one that cannot be delegated further
  $ filecoin-pin login --no-browser --no-wait                     # print the link, approve later, rerun to check
  $ filecoin-pin login --private-uploads                          # every add private from now on (saved, no console)
  $ filecoin-pin login --grant fgr1_…                             # finish: import the Grant the console showed
  $ pbpaste | filecoin-pin login --grant -                        # the same, reading the Grant from stdin

${pc.bold('FILES')}
  The session key is saved to session.env in the data directory before the
  browser opens (owner-readable only), so an interrupted login resumes the
  same key and, unless --scopes says otherwise, the same scopes. Group key Grants are saved there too, as GROUP_KEY_ID and
  GROUP_KEY_GRANT (comma-separated, one per group). \`filecoin-pin logout\` deletes the file.

${pc.bold('GROUP KEY GRANTS')}
  With encrypt, the console also wraps your group key to this session key.
  On a terminal, login asks you to paste the Grant; otherwise (and with
  --no-wait) it prints the resume command and never blocks. A --grant given
  before the key is authorized is not imported with --no-wait: rerun it after
  approving. The Grant gives
  this key permanent read access to the whole group key (or, with --group, to that
  group and every group beneath it), including future uploads: expiry and revoking
  the key do not take it back. Group names are public in every envelope.
  filecoin-pin does not list groups: the app or person using it keeps track of them.

${pc.bold('ENVIRONMENT')}
  CONSOLE_URL   Filecoin Cloud console base URL (default: https://pay.filecoin.cloud). Point it at a
                console you run against a local foc-devnet to use login --network devnet
  BROWSER=none  never open a browser
  NETWORK, RPC_URL  as --network and --rpc-url

${pc.bold('EXIT CODES')}
  0  every requested scope was granted (and the Grant saved, with encrypt)
  2  no authorization seen in time, --no-wait, fewer scopes than requested, or the Grant
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
    'Log out: delete the saved session key from this machine (local only; the on-chain authorization stays until it expires)'
  )
  .action(() => {
    try {
      runLogout()
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    }
  })
