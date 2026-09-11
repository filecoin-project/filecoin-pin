/**
 * Credential auto-load: the lowest-priority credential source.
 *
 * Resolution order for every command: explicit flags, then env vars
 * (`PRIVATE_KEY`, or `SESSION_KEY` + `WALLET_ADDRESS`), then
 * `--credentials-file`, then the session file `login` wrote, then the error
 * that points at `login`.
 *
 * Both file sources load from a Commander `preAction` hook, after parsing.
 * By then every flag and env-backed option is resolved, so "did the user
 * choose a credential or a network" is one option lookup rather than a
 * hand-rolled scan of argv and the environment, and each loaded value is
 * recorded with its own source (`file`, `session`) so `parseCLIAuth` can
 * rank it below the shell. Explicit always beats implicit: a shell or CI
 * that sets env vars is never surprised by a stale laptop file.
 */

import type { Command } from 'commander'
import { getSessionFilePath, readSessionFile } from '../login/session-file.js'

/** Env var name and Commander attribute for every variable the file sources may supply. */
const OPTION_FOR_ENV = {
  PRIVATE_KEY: 'privateKey',
  SESSION_KEY: 'sessionKey',
  WALLET_ADDRESS: 'walletAddress',
  VIEW_ADDRESS: 'viewAddress',
  NETWORK: 'network',
} as const

export type LoadableEnvVar = keyof typeof OPTION_FOR_ENV

const AUTH_ENV_VARS = [
  'PRIVATE_KEY',
  'SESSION_KEY',
  'WALLET_ADDRESS',
  'VIEW_ADDRESS',
] as const satisfies LoadableEnvVar[]

let loadedFrom: string | undefined
let loadedNetwork: string | undefined
let skippedForViewAddress = false

function isSet(env: NodeJS.ProcessEnv, name: string): boolean {
  return env[name] !== undefined && env[name] !== ''
}

/**
 * True when a flag, an env var, or an earlier loader already supplied
 * `name`. `NETWORK` counts as supplied when an RPC URL was chosen too, since
 * the two are mutually exclusive.
 */
function isSupplied(command: Command, env: NodeJS.ProcessEnv, name: LoadableEnvVar): boolean {
  if (name === 'NETWORK' && (command.getOptionValue('rpcUrl') !== undefined || isSet(env, 'RPC_URL'))) return true
  return command.getOptionValue(OPTION_FOR_ENV[name]) !== undefined || isSet(env, name)
}

/**
 * Supply `name` from a file source unless something higher already did.
 * The Commander option is set (with `source` as its provenance) only when
 * the command declares it, exactly as Commander binds env vars; the env var
 * is set for the code that reads `process.env` directly.
 *
 * @returns whether the value was used
 */
export function supplyCredential(
  command: Command,
  env: NodeJS.ProcessEnv,
  name: LoadableEnvVar,
  value: string,
  source: 'file' | 'session'
): boolean {
  if (isSupplied(command, env, name)) return false
  const attribute = OPTION_FOR_ENV[name]
  if (command.options.some((option) => option.attributeName() === attribute)) {
    command.setOptionValueWithSource(attribute, value, source)
  }
  env[name] = value
  return true
}

/**
 * Load `SESSION_KEY` and `WALLET_ADDRESS` from the session file when nothing
 * else supplied a credential, plus `NETWORK` when neither a flag, the env,
 * nor an RPC URL chose one, since the grant lives on the chain the key was
 * made for. A file without an owner address (login started but never
 * authorized) is left alone, so the command hits the no-credentials error
 * and points at `login`. Runs from the `addAuthOptions` preAction hook, so
 * commands without auth options (`login`, `logout`, `dashboard`, `server`)
 * never auto-load.
 *
 * @returns the file path when it was used, otherwise undefined
 */
export function applySessionFileCredentials(
  command: Command,
  env: NodeJS.ProcessEnv = process.env,
  path: string = getSessionFilePath()
): string | undefined {
  // One process may call this more than once (tests, programmatic use); start clean each time.
  loadedFrom = undefined
  loadedNetwork = undefined
  skippedForViewAddress = false
  const supplied = AUTH_ENV_VARS.filter((name) => isSupplied(command, env, name))
  if (supplied.length > 0) {
    // Only VIEW_ADDRESS set: a usable login exists but read-only mode wins. Remembered so the
    // command can say why the saved login was not used.
    const onlyViewAddress = supplied.length === 1 && supplied[0] === 'VIEW_ADDRESS'
    skippedForViewAddress =
      onlyViewAddress &&
      command.getOptionValueSource('viewAddress') === 'env' &&
      readSessionFile(path)?.walletAddress !== undefined
    return undefined
  }
  const session = readSessionFile(path)
  if (session?.walletAddress === undefined) return undefined
  supplyCredential(command, env, 'SESSION_KEY', session.sessionKey, 'session')
  supplyCredential(command, env, 'WALLET_ADDRESS', session.walletAddress, 'session')
  if (session.network !== undefined) supplyCredential(command, env, 'NETWORK', session.network, 'session')
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
