/**
 * Dotenv-style file loader for `--env-file <path>`.
 *
 * Lets users point the CLI at a dotenv-style credentials file (e.g. one
 * produced by `filecoin-pin session create` or downloaded from a wallet
 * console) without `source`-ing it into their shell.
 *
 * Semantics mirror Node's built-in `--env-file`: values from the file are
 * applied to `process.env` only when the variable is not already set, so
 * a pre-existing environment variable always wins over the file, and a
 * `--flag` (which Commander resolves after this runs) always wins over
 * both.
 */
import { readFileSync } from 'node:fs'

/**
 * Parse dotenv-style `KEY=VALUE` lines.
 *
 * Blank lines and lines starting with `#` are ignored. A single pair of
 * surrounding single or double quotes is stripped from the value. Lines
 * that don't match `KEY=VALUE` are skipped.
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const result: Record<string, string> = {}

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) {
      continue
    }

    const eq = line.indexOf('=')
    if (eq === -1) {
      continue
    }

    let key = line.slice(0, eq).trim()
    // Accept shell-sourceable files: `export KEY=VALUE` means KEY=VALUE.
    if (key.startsWith('export ')) {
      key = key.slice('export '.length).trim()
    }
    // A key with whitespace is never a valid env var name — skip, don't inject garbage.
    if (key === '' || /\s/.test(key)) {
      continue
    }

    let value = line.slice(eq + 1).trim()
    if (value.length >= 2) {
      const first = value[0]
      const last = value[value.length - 1]
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1)
      }
    }

    result[key] = value
  }

  return result
}

/**
 * Load a dotenv-style file at `path` into `env`, without overriding
 * variables already present in `env`.
 *
 * Throws with a clear, path-naming error if the file cannot be read
 * (e.g. it doesn't exist).
 */
export function loadEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): void {
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`--env-file: could not read "${path}": ${reason}`)
  }

  const parsed = parseEnvFile(contents)
  if (Object.keys(parsed).length === 0) {
    throw new Error(
      `--env-file: no usable entries in "${path}". Expected dotenv-style lines like:\n` +
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
 * Scan `argv` for a position-independent `--env-file <path>` or
 * `--env-file=<path>` and return the path, or `undefined` if not present.
 */
export function findEnvFileArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) {
      continue
    }
    if (arg === '--env-file') {
      return argv[i + 1]
    }
    if (arg.startsWith('--env-file=')) {
      return arg.slice('--env-file='.length)
    }
  }
  return undefined
}

/**
 * Pre-parse step: if `--env-file <path>` (or `=<path>`) appears anywhere in
 * `argv`, load it into `env` before Commander resolves env-backed options.
 * No-op when the flag is absent. Must run before `program.parse(...)`.
 */
export function applyEnvFileArg(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): void {
  const path = findEnvFileArg(argv)
  if (path !== undefined) {
    loadEnvFile(path, env)
  }
}
