/**
 * Credential auto-load: the lowest-priority credential source.
 *
 * Resolution order for every command (PRD section 5): explicit flags, then
 * env vars (`PRIVATE_KEY`, or `SESSION_KEY` + `WALLET_ADDRESS`), then the
 * session file `login` wrote, then the error that points at `login`.
 *
 * This runs before Commander parses argv. Commander already makes flags win
 * over env vars, so the only job here is to load the session file into the
 * environment when no flag and no env var supplied a credential. Explicit
 * always beats implicit: a shell or CI that sets env vars is never
 * surprised by a stale laptop file.
 */

import { getSessionFilePath, readSessionFile } from '../login/session-file.js'

const AUTH_ENV_VARS = ['PRIVATE_KEY', 'SESSION_KEY', 'WALLET_ADDRESS', 'VIEW_ADDRESS'] as const
const AUTH_FLAGS = ['--private-key', '--session-key', '--wallet-address', '--view-address'] as const
/**
 * Commands that never auto-load: `login`/`logout` manage the file, and the
 * pinning server is a daemon that must not silently bind to an interactive,
 * expiring session key.
 */
const SKIPPED_COMMANDS = ['login', 'logout', 'server'] as const

let loadedFrom: string | undefined

/** True when argv carries any auth flag, in `--flag value` or `--flag=value` form. */
function hasAuthFlag(argv: readonly string[]): boolean {
  return argv.some((arg) => AUTH_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`)))
}

/** True when the first non-option argument names a command that never auto-loads. */
function isSkippedCommand(argv: readonly string[]): boolean {
  const command = argv.slice(2).find((arg) => !arg.startsWith('-'))
  return command !== undefined && (SKIPPED_COMMANDS as readonly string[]).includes(command)
}

function hasAuthEnv(env: NodeJS.ProcessEnv): boolean {
  return AUTH_ENV_VARS.some((name) => env[name] !== undefined && env[name] !== '')
}

/**
 * Load `SESSION_KEY` and `WALLET_ADDRESS` from the session file into `env`
 * when nothing else supplied a credential. A file without an owner address
 * (login started but never authorized) is left alone, so the command hits
 * the no-credentials error and points at `login`. `login`, `logout`, and
 * `server` never auto-load.
 *
 * @returns the file path when it was used, otherwise undefined
 */
export function applySessionFileCredentials(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  path: string = getSessionFilePath()
): string | undefined {
  if (isSkippedCommand(argv) || hasAuthFlag(argv) || hasAuthEnv(env)) return undefined
  const session = readSessionFile(path)
  if (session?.walletAddress === undefined) return undefined
  env.SESSION_KEY = session.sessionKey
  env.WALLET_ADDRESS = session.walletAddress
  loadedFrom = path
  return path
}

/** Path of the session file the running command's credentials came from, if any. */
export function getSessionCredentialSource(): string | undefined {
  return loadedFrom
}
