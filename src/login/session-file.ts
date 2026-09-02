/**
 * The saved login session: one dotenv-style file in the filecoin-pin data
 * directory holding the session key and, once authorized, the owner
 * wallet address. Exactly one credential set; every write replaces the
 * whole file.
 *
 * `login` writes the key before the browser opens, so an interrupted login
 * resumes the same key. The owner address is added once the grant is seen
 * on-chain. Commands auto-load this file when neither flags nor env vars
 * supply credentials (see `src/utils/credential-source.ts`).
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import type { Address, Hex } from 'viem'
import { getDataDirectory } from '../config.js'

export const SESSION_FILE_NAME = 'session.env'

export interface SavedSession {
  /** Session key private key. */
  sessionKey: Hex
  /** Session key address, derived from the private key at save time. */
  sessionAddress: Address
  /** Owner wallet that authorized the key. Absent until the first grant is seen. */
  walletAddress?: Address
}

/** Absolute path of the session file. */
export function getSessionFilePath(dataDir: string = getDataDirectory()): string {
  return join(dataDir, SESSION_FILE_NAME)
}

function isHex(value: string | undefined, bytes: number): value is Hex {
  return value !== undefined && new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value)
}

/**
 * Read the saved session. Returns `undefined` when there is no file or it
 * holds no usable session key; a malformed file is treated as absent so a
 * stray edit cannot wedge every command.
 */
export function readSessionFile(path: string = getSessionFilePath()): SavedSession | undefined {
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  const parsed = parseEnv(contents)
  const sessionKey = parsed.SESSION_KEY
  const sessionAddress = parsed.SESSION_ADDRESS
  if (!isHex(sessionKey, 32) || !isHex(sessionAddress, 20)) return undefined
  const walletAddress = parsed.WALLET_ADDRESS
  return isHex(walletAddress, 20) ? { sessionKey, sessionAddress, walletAddress } : { sessionKey, sessionAddress }
}

/** Write the session, replacing any previous file. Owner-readable only. */
export function writeSessionFile(session: SavedSession, path: string = getSessionFilePath()): void {
  const lines = [
    '# filecoin-pin login session. Delete with: filecoin-pin logout',
    `SESSION_KEY=${session.sessionKey}`,
    `SESSION_ADDRESS=${session.sessionAddress}`,
  ]
  if (session.walletAddress !== undefined) lines.push(`WALLET_ADDRESS=${session.walletAddress}`)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 })
}

/** Delete the session file. Returns whether a file was removed. */
export function deleteSessionFile(path: string = getSessionFilePath()): boolean {
  try {
    readFileSync(path)
  } catch {
    return false
  }
  rmSync(path, { force: true })
  return true
}
