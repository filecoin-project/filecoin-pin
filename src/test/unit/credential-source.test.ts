import { Command } from 'commander'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readSessionFile } from '../../login/session-file.js'
import { addAuthOptions } from '../../utils/cli-options.js'
import {
  applySessionFileCredentials,
  getSessionCredentialNetwork,
  getSessionCredentialSource,
  wasSessionSkippedForViewAddress,
} from '../../utils/credential-source.js'

vi.mock('../../login/session-file.js', () => ({
  readSessionFile: vi.fn(),
  getSessionFilePath: () => 'session.env',
}))

const KEY = `0x${'ab'.repeat(32)}` as const
const SESSION = '0x00000000000000000000000000000000000000bb' as const
const OWNER = '0x00000000000000000000000000000000000000aa' as const
const PATH = 'session.env'
const AUTHORIZED = { sessionKey: KEY, sessionAddress: SESSION, walletAddress: OWNER }

function savedSession(session: Partial<typeof AUTHORIZED> & { network?: string } = AUTHORIZED) {
  vi.mocked(readSessionFile).mockReturnValue(session as ReturnType<typeof readSessionFile>)
}

function noSession() {
  vi.mocked(readSessionFile).mockReturnValue(undefined)
}

/** An `add`-like command after Commander parsed `flags`, with env-backed options bound from `env`. */
function parsed(flags: string[] = [], env: NodeJS.ProcessEnv = {}): Command {
  const command = addAuthOptions(new Command('add').exitOverride())
  const previous = { ...process.env }
  Object.assign(process.env, env)
  try {
    command.parse(flags, { from: 'user' })
  } finally {
    for (const name of Object.keys(env)) delete process.env[name]
    Object.assign(process.env, previous)
  }
  return command
}

describe('applySessionFileCredentials', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.mocked(readSessionFile).mockReset()
  })

  it('loads the session file when nothing else supplies a credential', () => {
    savedSession()
    const env: NodeJS.ProcessEnv = {}
    const command = parsed()
    expect(applySessionFileCredentials(command, env, PATH)).toBe(PATH)
    expect(env).toEqual({ SESSION_KEY: KEY, WALLET_ADDRESS: OWNER })
    expect(command.opts()).toMatchObject({ sessionKey: KEY, walletAddress: OWNER })
    expect(command.getOptionValueSource('sessionKey')).toBe('session')
    expect(getSessionCredentialSource()).toBe(PATH)
  })

  it.each([
    [{ PRIVATE_KEY: '0xenv' }],
    [{ SESSION_KEY: '0xenv', WALLET_ADDRESS: '0xenv' }],
    [{ SESSION_KEY: '0xenv' }],
    [{ VIEW_ADDRESS: '0xenv' }],
  ])('env %o beats the file', (preset) => {
    savedSession()
    const env: NodeJS.ProcessEnv = { ...preset }
    expect(applySessionFileCredentials(parsed([], env), env, PATH)).toBeUndefined()
    expect(env).toEqual(preset)
  })

  it.each([
    [['--private-key', '0xflag'], {}],
    [['--private-key=0xflag'], { PRIVATE_KEY: '0xenv' }],
    [['--session-key', '0xflag', '--wallet-address', '0xflag'], {}],
    [['--view-address', '0xflag'], {}],
  ])('flags %j beat the env and the file', (flags, preset) => {
    savedSession()
    const env: NodeJS.ProcessEnv = { ...preset }
    expect(applySessionFileCredentials(parsed(flags, env), env, PATH)).toBeUndefined()
    expect(env).toEqual(preset)
  })

  const WITH_GRANT = { ...AUTHORIZED, groupKeyId: `0x${'cd'.repeat(16)}`, groupKeyGrant: 'fgr1_saved' }

  it('loads the saved group key Grant with the session key', () => {
    savedSession(WITH_GRANT)
    const env: NodeJS.ProcessEnv = {}
    applySessionFileCredentials(parsed(), env, PATH)
    expect(env).toEqual({
      SESSION_KEY: KEY,
      WALLET_ADDRESS: OWNER,
      GROUP_KEY_ID: WITH_GRANT.groupKeyId,
      GROUP_KEY_GRANT: 'fgr1_saved',
    })
  })

  it('lets a Grant in the environment beat the saved one', () => {
    savedSession(WITH_GRANT)
    const env: NodeJS.ProcessEnv = { GROUP_KEY_GRANT: 'fgr1_env', GROUP_KEY_ID: '0xenv' }
    applySessionFileCredentials(parsed(), env, PATH)
    expect(env).toMatchObject({ SESSION_KEY: KEY, GROUP_KEY_GRANT: 'fgr1_env', GROUP_KEY_ID: '0xenv' })
  })

  it('leaves the saved Grant out when the environment supplies the session key', () => {
    savedSession(WITH_GRANT)
    const env: NodeJS.ProcessEnv = { SESSION_KEY: '0xenv', WALLET_ADDRESS: '0xenv' }
    applySessionFileCredentials(parsed([], env), env, PATH)
    expect(env).not.toHaveProperty('GROUP_KEY_GRANT')
  })

  it('ignores a file whose login never completed (no owner yet)', () => {
    savedSession({ sessionKey: KEY, sessionAddress: SESSION })
    const env: NodeJS.ProcessEnv = {}
    expect(applySessionFileCredentials(parsed(), env, PATH)).toBeUndefined()
    expect(env).toEqual({})
  })

  it('exports the saved network when nothing chose one', () => {
    savedSession({ ...AUTHORIZED, network: 'calibration' })
    const env: NodeJS.ProcessEnv = {}
    const command = parsed()
    applySessionFileCredentials(command, env, PATH)
    expect(env.NETWORK).toBe('calibration')
    expect(command.opts().network).toBe('calibration')
    expect(getSessionCredentialNetwork()).toBe('calibration')
  })

  it.each([
    ['NETWORK in the env', [], { NETWORK: 'mainnet' }, 'mainnet'],
    ['RPC_URL in the env', [], { RPC_URL: 'http://rpc' }, undefined],
    ['--network with a space', ['--network', 'mainnet'], {}, undefined],
    ['--network with an equals sign', ['--network=mainnet'], {}, undefined],
    ['--rpc-url', ['--rpc-url', 'http://rpc'], {}, undefined],
  ])('does not export the saved network over %s', (_label, flags, preset, expected) => {
    savedSession({ ...AUTHORIZED, network: 'calibration' })
    const env: NodeJS.ProcessEnv = { ...preset }
    const command = parsed(flags, env)
    applySessionFileCredentials(command, env, PATH)
    expect(env.NETWORK).toBe(expected)
    expect(command.getOptionValueSource('network')).not.toBe('session')
    expect(env.SESSION_KEY).toBe(KEY)
  })

  it('records when only VIEW_ADDRESS kept a usable login out', () => {
    savedSession()
    const env = { VIEW_ADDRESS: OWNER }
    expect(applySessionFileCredentials(parsed([], env), env, PATH)).toBeUndefined()
    expect(wasSessionSkippedForViewAddress()).toBe(true)
  })

  it('does not blame VIEW_ADDRESS when another credential is also set', () => {
    savedSession()
    const env = { VIEW_ADDRESS: OWNER, PRIVATE_KEY: '0xenv' }
    applySessionFileCredentials(parsed([], env), env, PATH)
    expect(wasSessionSkippedForViewAddress()).toBe(false)
  })

  it('does not blame VIEW_ADDRESS when there is no session file', () => {
    noSession()
    const env = { VIEW_ADDRESS: OWNER }
    applySessionFileCredentials(parsed([], env), env, PATH)
    expect(wasSessionSkippedForViewAddress()).toBe(false)
  })

  it('does not blame VIEW_ADDRESS when the session file has no owner yet', () => {
    savedSession({ sessionKey: KEY, sessionAddress: SESSION })
    const env = { VIEW_ADDRESS: OWNER }
    applySessionFileCredentials(parsed([], env), env, PATH)
    expect(wasSessionSkippedForViewAddress()).toBe(false)
  })

  it('warns when CI is set and the saved login was used', () => {
    savedSession()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    applySessionFileCredentials(parsed(), { CI: 'true' }, PATH)
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('CI is set and credentials came from the saved login'))
  })

  it('stays quiet outside CI', () => {
    savedSession()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    applySessionFileCredentials(parsed(), {}, PATH)
    expect(errors).not.toHaveBeenCalled()
  })

  it('is a no-op without a file', () => {
    noSession()
    const env: NodeJS.ProcessEnv = {}
    expect(applySessionFileCredentials(parsed(), env, PATH)).toBeUndefined()
    expect(env).toEqual({})
  })
})
