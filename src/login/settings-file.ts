/**
 * Preferences that outlive a login: one dotenv-style `settings.env` in the filecoin-pin data
 * directory, beside `session.env`, so `logout` and `login --fresh` leave them alone (#812).
 *
 * The only one so far is `UPLOADS=private` (`login --private-uploads`, #825): every `add` is
 * private unless `--public` says otherwise. `FILECOIN_PIN_UPLOADS` overrides the file, so a CI job
 * can set it without a login. Both are read fail-closed: an unreadable file or an unknown value
 * stops the command rather than letting an upload go public.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseEnv } from 'node:util'
import { getDataDirectory } from '../config.js'

export const SETTINGS_FILE_NAME = 'settings.env'
export const UPLOADS_ENV = 'FILECOIN_PIN_UPLOADS'

/** Absolute path of the settings file. */
export function getSettingsFilePath(dataDir: string = getDataDirectory()): string {
  return join(dataDir, SETTINGS_FILE_NAME)
}

/** The file's entries; empty when there is no file. Throws when it exists but cannot be read. */
function readSettings(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  try {
    return { ...parseEnv(readFileSync(path, 'utf8')) } as Record<string, string>
  } catch (error) {
    throw new Error(
      `Cannot read ${path} (${error instanceof Error ? error.message : String(error)}): fix or remove it, or set ${UPLOADS_ENV}`
    )
  }
}

/** `private` → true, `public` → false; anything else is refused, naming where it came from. */
function uploadsValue(value: string, source: string): boolean {
  if (value === 'private') return true
  if (value === 'public') return false
  throw new Error(`${source} is "${value}": use private or public`)
}

/**
 * Whether uploads are private unless a flag says otherwise: `FILECOIN_PIN_UPLOADS`, else the
 * settings file's `UPLOADS`, else false.
 *
 * @throws When the variable or the file holds another value, or the file cannot be read.
 */
export function privateUploadsByDefault(
  path: string = getSettingsFilePath(),
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const fromEnv = env[UPLOADS_ENV]
  if (fromEnv !== undefined && fromEnv !== '') return uploadsValue(fromEnv, UPLOADS_ENV)
  const fromFile = readSettings(path).UPLOADS
  return fromFile === undefined ? false : uploadsValue(fromFile, `UPLOADS in ${path}`)
}

/**
 * Save the setting (true writes `UPLOADS=private`, false removes it), keeping any other entries.
 * The file is removed once it holds nothing.
 */
export function writePrivateUploads(on: boolean, path: string = getSettingsFilePath()): void {
  const { UPLOADS: _, ...rest } = readSettings(path)
  const entries = on ? { ...rest, UPLOADS: 'private' } : rest
  const lines = Object.entries(entries).map(([key, value]) => `${key}=${value}`)
  if (lines.length === 0) {
    rmSync(path, { force: true })
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  // Written aside and renamed, so a reader never sees half a file.
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${lines.join('\n')}\n`)
  renameSync(tmp, path)
}
