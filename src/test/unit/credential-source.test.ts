import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeSessionFile } from '../../login/session-file.js'
import { applySessionFileCredentials } from '../../utils/credential-source.js'

const KEY = `0x${'ab'.repeat(32)}` as const
const SESSION = '0x00000000000000000000000000000000000000bb'
const OWNER = '0x00000000000000000000000000000000000000aa'
const ARGV = ['node', 'cli.js', 'add', 'file.txt']

describe('applySessionFileCredentials', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'credential-source-'))
    path = join(dir, 'session.env')
    writeSessionFile({ sessionKey: KEY, sessionAddress: SESSION, walletAddress: OWNER }, path)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('loads the session file when nothing else supplies a credential', () => {
    const env: NodeJS.ProcessEnv = {}
    expect(applySessionFileCredentials(ARGV, env, path)).toBe(path)
    expect(env).toEqual({ SESSION_KEY: KEY, WALLET_ADDRESS: OWNER })
  })

  it('env vars beat the file', () => {
    for (const preset of [
      { PRIVATE_KEY: '0xenv' },
      { SESSION_KEY: '0xenv', WALLET_ADDRESS: '0xenv' },
      { SESSION_KEY: '0xenv' },
      { VIEW_ADDRESS: '0xenv' },
    ]) {
      const env: NodeJS.ProcessEnv = { ...preset }
      expect(applySessionFileCredentials(ARGV, env, path)).toBeUndefined()
      expect(env).toEqual(preset)
    }
  })

  it('flags beat both the env and the file', () => {
    for (const argv of [
      ['node', 'cli.js', 'add', '--private-key', '0xflag', 'f'],
      ['node', 'cli.js', 'add', '--private-key=0xflag', 'f'],
      ['node', 'cli.js', 'add', '--session-key', '0xflag', '--wallet-address', '0xflag', 'f'],
      ['node', 'cli.js', 'add', '--view-address', '0xflag', 'f'],
    ]) {
      for (const preset of [{}, { PRIVATE_KEY: '0xenv' }]) {
        const env: NodeJS.ProcessEnv = { ...preset }
        expect(applySessionFileCredentials(argv, env, path)).toBeUndefined()
        expect(env).toEqual(preset)
      }
    }
  })

  it('never loads for login, logout, or server', () => {
    for (const command of ['login', 'logout', 'server']) {
      const env: NodeJS.ProcessEnv = {}
      expect(applySessionFileCredentials(['node', 'cli.js', '--verbose', command], env, path)).toBeUndefined()
      expect(env).toEqual({})
    }
  })

  it('ignores a file whose login never completed (no owner yet)', () => {
    writeSessionFile({ sessionKey: KEY, sessionAddress: SESSION }, path)
    const env: NodeJS.ProcessEnv = {}
    expect(applySessionFileCredentials(ARGV, env, path)).toBeUndefined()
    expect(env).toEqual({})
  })

  it('is a no-op without a file', () => {
    const env: NodeJS.ProcessEnv = {}
    expect(applySessionFileCredentials(ARGV, env, join(dir, 'missing.env'))).toBeUndefined()
    expect(env).toEqual({})
  })
})
