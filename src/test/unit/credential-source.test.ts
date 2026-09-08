import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeSessionFile } from '../../login/session-file.js'
import { applySessionFileCredentials, wasSessionSkippedForViewAddress } from '../../utils/credential-source.js'

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

  it('never loads for login, logout, dashboard, or server', () => {
    for (const command of ['login', 'logout', 'dashboard', 'server']) {
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

  it('exports the saved network unless a flag or the env already chose one', () => {
    writeSessionFile({ sessionKey: KEY, sessionAddress: SESSION, walletAddress: OWNER, network: 'calibration' }, path)
    const env: NodeJS.ProcessEnv = {}
    applySessionFileCredentials(ARGV, env, path)
    expect(env.NETWORK).toBe('calibration')

    const preset: NodeJS.ProcessEnv = { NETWORK: 'mainnet' }
    applySessionFileCredentials(ARGV, preset, path)
    expect(preset.NETWORK).toBe('mainnet')

    const flagged: NodeJS.ProcessEnv = {}
    applySessionFileCredentials([...ARGV, '--network', 'mainnet'], flagged, path)
    expect(flagged.NETWORK).toBeUndefined()
    expect(flagged.SESSION_KEY).toBe(KEY)
  })

  it('records when only VIEW_ADDRESS kept a usable login out', () => {
    const env: NodeJS.ProcessEnv = { VIEW_ADDRESS: OWNER }
    expect(applySessionFileCredentials(ARGV, env, path)).toBeUndefined()
    expect(wasSessionSkippedForViewAddress()).toBe(true)
    applySessionFileCredentials(ARGV, { VIEW_ADDRESS: OWNER, PRIVATE_KEY: '0xenv' }, path)
    expect(wasSessionSkippedForViewAddress()).toBe(false)
  })

  it('warns when CI is set and the saved login was used', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    applySessionFileCredentials(ARGV, { CI: 'true' }, path)
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('CI is set and credentials came from the saved login'))
    errors.mockClear()
    applySessionFileCredentials(ARGV, {}, path)
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it('is a no-op without a file', () => {
    const env: NodeJS.ProcessEnv = {}
    expect(applySessionFileCredentials(ARGV, env, join(dir, 'missing.env'))).toBeUndefined()
    expect(env).toEqual({})
  })
})
