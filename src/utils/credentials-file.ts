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
 * Values from the file are applied to `process.env` only when the variable
 * is not already set, so a pre-existing environment variable always wins
 * over the file, and a `--flag` (which Commander resolves after this runs)
 * always wins over both.
 */
import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

export const CREDENTIALS_FILE_FLAG = '--credentials-file'

/**
 * Load a dotenv-style file at `path` into `env`, without overriding
 * variables already present in `env`.
 *
 * Throws with a clear, path-naming error if the file cannot be read
 * (e.g. it doesn't exist).
 */
export function loadCredentialsFile(path: string, env: NodeJS.ProcessEnv = process.env): void {
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`--credentials-file: could not read "${path}": ${reason}`)
  }

  const parsed = parseEnv(contents)
  if (Object.keys(parsed).length === 0) {
    throw new Error(
      `--credentials-file: no usable entries in "${path}". Expected dotenv-style lines like:\n` +
        `  SESSION_KEY=0x<64 hex>\n  WALLET_ADDRESS=0x<40 hex>\n` +
        `(# comments and blank lines are ignored; "export KEY=VALUE" also works)`
    )
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) {
      env[key] = value
    }
  }
}

/**
 * Scan `argv` for a position-independent `--credentials-file <path>` or
 * `--credentials-file=<path>` and return the path, or `undefined` if not present.
 */
export function findCredentialsFileArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) {
      continue
    }
    if (arg === CREDENTIALS_FILE_FLAG) {
      return argv[i + 1]
    }
    if (arg.startsWith(`${CREDENTIALS_FILE_FLAG}=`)) {
      return arg.slice(CREDENTIALS_FILE_FLAG.length + 1)
    }
  }
  return undefined
}

/**
 * Pre-parse step: if `--credentials-file <path>` (or `=<path>`) appears anywhere in
 * `argv`, load it into `env` before Commander resolves env-backed options.
 * No-op when the flag is absent. Must run before `program.parse(...)`.
 */
export function applyCredentialsFileArg(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): void {
  const path = findCredentialsFileArg(argv)
  if (path !== undefined) {
    loadCredentialsFile(path, env)
  }
}
