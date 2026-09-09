/**
 * Credential auto-load: the lowest-priority credential source.
 *
 * Resolution order for every command: explicit flags, then
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
const NETWORK_FLAGS = ['--network', '--rpc-url'] as const
/**
 * Commands that never auto-load: `login`/`logout` manage the file, `dashboard`
 * needs no credential and opens a browser, and the pinning server is a daemon
 * that must not silently bind to an interactive, expiring session key.
 */
const SKIPPED_COMMANDS = ['login', 'logout', 'dashboard', 'server'] as const

let loadedFrom: string | undefined
let loadedNetwork: string | undefined
let skippedForViewAddress = false

/** True when argv carries any of `flags`, in `--flag value` or `--flag=value` form. */
function hasFlag(argv: readonly string[], flags: readonly string[]): boolean {
  return argv.some((arg) => flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)))
}

/** True when the first non-option argument names a command that never auto-loads. */
function isSkippedCommand(argv: readonly string[]): boolean {
  const command = argv.slice(2).find((arg) => !arg.startsWith('-'))
  return command !== undefined && (SKIPPED_COMMANDS as readonly string[]).includes(command)
}

function isSet(env: NodeJS.ProcessEnv, name: string): boolean {
  return env[name] !== undefined && env[name] !== ''
}

function hasAuthEnv(env: NodeJS.ProcessEnv): boolean {
  return AUTH_ENV_VARS.some((name) => isSet(env, name))
}

/**
 * Load `SESSION_KEY` and `WALLET_ADDRESS` from the session file into `env`
 * when nothing else supplied a credential, plus `NETWORK` when neither a
 * flag nor the env chose one, since the grant lives on the chain the key
 * was made for. A file without an owner address (login started but never
 * authorized) is left alone, so the command hits the no-credentials error
 * and points at `login`. `login`, `logout`, and `server` never auto-load.
 *
 * @returns the file path when it was used, otherwise undefined
 */
export function applySessionFileCredentials(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  path: string = getSessionFilePath()
): string | undefined {
  if (isSkippedCommand(argv) || hasFlag(argv, AUTH_FLAGS)) return undefined
  if (hasAuthEnv(env)) {
    // Only VIEW_ADDRESS set: a usable login exists but read-only mode wins. Remembered so the
    // command can say why the saved login was not used.
    const onlyViewAddress = isSet(env, 'VIEW_ADDRESS') && !AUTH_ENV_VARS.slice(0, 3).some((n) => isSet(env, n))
    skippedForViewAddress = onlyViewAddress && readSessionFile(path)?.walletAddress !== undefined
    return undefined
  }
  const session = readSessionFile(path)
  if (session?.walletAddress === undefined) return undefined
  env.SESSION_KEY = session.sessionKey
  env.WALLET_ADDRESS = session.walletAddress
  if (session.network !== undefined && !isSet(env, 'NETWORK') && !hasFlag(argv, NETWORK_FLAGS)) {
    env.NETWORK = session.network
  }
  loadedFrom = path
  loadedNetwork = session.network
  if (isSet(env, 'CI')) {
    // A runner that reuses its home directory keeps this file between jobs, so
    // every later job would upload as this owner. Said before any output.
    console.error(
      `Warning: CI is set and credentials came from the saved login at ${path}. Set PRIVATE_KEY, or SESSION_KEY and WALLET_ADDRESS, explicitly on CI so a stale login is never picked up.`
    )
  }
  return path
}

/** Path of the session file the running command's credentials came from, if any. */
export function getSessionCredentialSource(): string | undefined {
  return loadedFrom
}

/** Network recorded in the session file the credentials came from, if any. */
export function getSessionCredentialNetwork(): string | undefined {
  return loadedNetwork
}

/** True when a usable saved login was skipped only because VIEW_ADDRESS is set. */
export function wasSessionSkippedForViewAddress(): boolean {
  return skippedForViewAddress
}
