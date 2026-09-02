import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formatCountdown, formatExpiryDate, shortAddress } from '../../login/format.js'
import { deleteSessionFile, getSessionFilePath, readSessionFile, writeSessionFile } from '../../login/session-file.js'

const KEY = `0x${'ab'.repeat(32)}` as const
const SESSION = privateKeyToAccount(KEY).address
const OWNER = '0x00000000000000000000000000000000000000aa'

describe('session file', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'login-session-'))
    path = getSessionFilePath(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('lives in the data directory as session.env', () => {
    expect(path).toBe(join(dir, 'session.env'))
  })

  it('reads back what it wrote, without an owner before authorization', () => {
    writeSessionFile({ sessionKey: KEY, sessionAddress: SESSION }, path)
    expect(readSessionFile(path)).toEqual({ sessionKey: KEY, sessionAddress: SESSION })
  })

  it('adds the owner on the second write and keeps exactly one credential set', () => {
    writeSessionFile({ sessionKey: KEY, sessionAddress: SESSION }, path)
    writeSessionFile({ sessionKey: KEY, sessionAddress: SESSION, walletAddress: OWNER }, path)
    expect(readSessionFile(path)).toEqual({ sessionKey: KEY, sessionAddress: SESSION, walletAddress: OWNER })
    expect(readFileSync(path, 'utf8').match(/SESSION_KEY=/g)).toHaveLength(1)
  })

  it('writes the file owner-readable only', () => {
    writeSessionFile({ sessionKey: KEY, sessionAddress: SESSION }, path)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('treats a missing or malformed file as no session', () => {
    expect(readSessionFile(path)).toBeUndefined()
    writeFileSync(path, 'SESSION_KEY=not-a-key\n')
    expect(readSessionFile(path)).toBeUndefined()
    writeFileSync(path, 'SESSION_KEY="unterminated\n=\n')
    expect(readSessionFile(path)).toBeUndefined()
    writeFileSync(path, `SESSION_KEY=0x${'0'.repeat(64)}\n`) // out of curve range
    expect(readSessionFile(path)).toBeUndefined()
  })

  it('derives the session address from the key instead of trusting the file', () => {
    writeFileSync(path, `SESSION_KEY=${KEY}\nSESSION_ADDRESS=0x00000000000000000000000000000000000000cc\n`)
    expect(readSessionFile(path)?.sessionAddress).toBe(SESSION)
  })

  it('tightens permissions when rewriting a permissive existing file', () => {
    writeFileSync(path, 'stale\n')
    chmodSync(path, 0o644)
    writeSessionFile({ sessionKey: KEY, sessionAddress: SESSION }, path)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readSessionFile(path)?.sessionKey).toBe(KEY)
  })

  it('deleteSessionFile reports whether anything was removed', () => {
    expect(deleteSessionFile(path)).toBe(false)
    writeSessionFile({ sessionKey: KEY, sessionAddress: SESSION }, path)
    expect(deleteSessionFile(path)).toBe(true)
    expect(readSessionFile(path)).toBeUndefined()
  })
})

describe('login format helpers', () => {
  it('shortens addresses to 0x1234…abcd', () => {
    expect(shortAddress('0x5929000000000000000000000000000000000c41a')).toBe('0x5929…c41a')
  })

  it('formats the expiry as a date', () => {
    expect(formatExpiryDate(1790380800n)).toBe('2026-09-26')
  })

  it('formats the countdown as m:ss', () => {
    expect(formatCountdown(277000)).toBe('4:37')
    expect(formatCountdown(0)).toBe('0:00')
    expect(formatCountdown(59500)).toBe('1:00')
  })
})
