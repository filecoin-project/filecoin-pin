/**
 * Dotenv-style file loader for `--credentials-file <path>`.
 *
 * Lets users point the CLI at a dotenv-style credentials file (e.g. one
 * produced by `filecoin-pin session create` or downloaded from a wallet
 * console) without `source`-ing it into their shell.
 *
 * The flag is not called `--env-file` because Node reserves that name:
 * Node validates its own `--env-file` before our code runs, so a bad path
 * produced a Node error instead of ours.
 *
 * The file loads from a Commander `preAction` hook, after flags and env
 * vars are resolved, and only supplies what they left unset. Each value is
 * recorded with source `file`, so a `--flag` or an env var always wins over
 * the file, across auth modes too: `PRIVATE_KEY` in the shell beats a
 * session key pair in the file (see `resolveAuthMode` in cli-auth.ts).
 */
import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import type { Command } from 'commander'
import { type LoadableEnvVar, supplyCredential } from './credential-source.js'

export const CREDENTIALS_FILE_FLAG = '--credentials-file'

/** Plain reason for a failed read; the path is already in the message. */
function describeReadError(error: unknown): string {
  const code = (error as { code?: string }).code
  if (code === 'ENOENT') return 'file not found'
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied'
  if (code === 'EISDIR') return 'path is a directory'
  return error instanceof Error ? error.message : String(error)
}

/** The only variables a credentials file may set: anything else could steer the CLI, not authenticate it. */
export const CREDENTIALS_FILE_VARS = [
  'PRIVATE_KEY',
  'SESSION_KEY',
  'WALLET_ADDRESS',
  'VIEW_ADDRESS',
  'NETWORK',
] as const satisfies LoadableEnvVar[]

/**
 * Read the credential variables of the dotenv-style file at `path`. Other
 * variables are ignored and named on stderr: a file from the console or a
 * teammate must not be able to point CONSOLE_URL or RPC_URL elsewhere.
 *
 * Throws with a clear, path-naming error if the file cannot be read
 * (e.g. it doesn't exist) or holds no usable entry.
 */
export function readCredentialsFile(path: string): Partial<Record<LoadableEnvVar, string>> {
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`--credentials-file: could not read "${path}": ${describeReadError(error)}`)
  }

  const credentials: Partial<Record<LoadableEnvVar, string>> = {}
  const ignored: string[] = []
  for (const [key, value] of Object.entries(parseEnv(contents))) {
    if (value !== undefined && (CREDENTIALS_FILE_VARS as readonly string[]).includes(key)) {
      credentials[key as LoadableEnvVar] = value
    } else {
      ignored.push(key)
    }
  }
  if (ignored.length > 0) {
    console.error(
      `--credentials-file: ignored ${ignored.join(', ')} (only ${CREDENTIALS_FILE_VARS.join(', ')} are read)`
    )
  }
  if (Object.keys(credentials).length === 0) {
    throw new Error(
      `--credentials-file: no usable entries in "${path}". Expected dotenv-style lines like:\n` +
        `  SESSION_KEY=0x<64 hex>\n  WALLET_ADDRESS=0x<40 hex>\n` +
        `(# comments and blank lines are ignored; "export KEY=VALUE" also works)`
    )
  }
  return credentials
}

/**
 * preAction hook body: when `--credentials-file` was given (in any position,
 * since the root program declares it), supply its variables at file
 * precedence. No-op when the flag is absent.
 */
export function applyCredentialsFile(actionCommand: Command, env: NodeJS.ProcessEnv = process.env): void {
  const path = actionCommand.optsWithGlobals<{ credentialsFile?: string }>().credentialsFile
  if (path === undefined) return
  for (const [name, value] of Object.entries(readCredentialsFile(path))) {
    supplyCredential(actionCommand, env, name as LoadableEnvVar, value, 'file')
  }
}
