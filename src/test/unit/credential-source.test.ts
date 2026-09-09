import { afterEach, describe, expect, it, vi } from 'vitest'
import { readSessionFile } from '../../login/session-file.js'
import { applySessionFileCredentials, wasSessionSkippedForViewAddress } from '../../utils/credential-source.js'

vi.mock('../../login/session-file.js', () => ({
  readSessionFile: vi.fn(),
  getSessionFilePath: () => 'session.env',
}))

const KEY = `0x${'ab'.repeat(32)}` as const
const SESSION = '0x00000000000000000000000000000000000000bb' as const
const OWNER = '0x00000000000000000000000000000000000000aa' as const
const PATH = 'session.env'
const ARGV = ['node', 'cli.js', 'add', 'file.txt']
const AUTHORIZED = { sessionKey: KEY, sessionAddress: SESSION, walletAddress: OWNER }

function savedSession(session: Partial<typeof AUTHORIZED> & { network?: string } = AUTHORIZED) {
  vi.mocked(readSessionFile).mockReturnValue(session as ReturnType<typeof readSessionFile>)
}

function noSession() {
  vi.mocked(readSessionFile).mockReturnValue(undefined)
}

describe('applySessionFileCredentials', () => {
  afterEach(() => {
    vi.mocked(readSessionFile).mockReset()
  })

  it('loads the session file when nothing else supplies a credential', () => {
    savedSession()
    const env: NodeJS.ProcessEnv = {}
    expect(applySessionFileCredentials(ARGV, env, PATH)).toBe(PATH)
    expect(env).toEqual({ SESSION_KEY: KEY, WALLET_ADDRESS: OWNER })
  })

  it.each([
    [{ PRIVATE_KEY: '0xenv' }],
    [{ SESSION_KEY: '0xenv', WALLET_ADDRESS: '0xenv' }],
    [{ SESSION_KEY: '0xenv' }],
    [{ VIEW_ADDRESS: '0xenv' }],
  ])('env %o beats the file', (preset) => {
    savedSession()
    const env: NodeJS.ProcessEnv = { ...preset }
    expect(applySessionFileCredentials(ARGV, env, PATH)).toBeUndefined()
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
    expect(applySessionFileCredentials(['node', 'cli.js', 'add', ...flags, 'f'], env, PATH)).toBeUndefined()
    expect(env).toEqual(preset)
  })

  it.each(['login', 'logout', 'dashboard', 'server'])('never loads for %s', (command) => {
    savedSession()
    const env: NodeJS.ProcessEnv = {}
    expect(applySessionFileCredentials(['node', 'cli.js', '--verbose', command], env, PATH)).toBeUndefined()
    expect(env).toEqual({})
  })

  it('ignores a file whose login never completed (no owner yet)', () => {
    savedSession({ sessionKey: KEY, sessionAddress: SESSION })
    const env: NodeJS.ProcessEnv = {}
    expect(applySessionFileCredentials(ARGV, env, PATH)).toBeUndefined()
    expect(env).toEqual({})
  })

  it('exports the saved network when nothing chose one', () => {
    savedSession({ ...AUTHORIZED, network: 'calibration' })
    const env: NodeJS.ProcessEnv = {}
    applySessionFileCredentials(ARGV, env, PATH)
    expect(env.NETWORK).toBe('calibration')
  })

  it.each([
    ['NETWORK in the env', ARGV, { NETWORK: 'mainnet' }, 'mainnet'],
    ['--network with a space', [...ARGV, '--network', 'mainnet'], {}, undefined],
    ['--network with an equals sign', [...ARGV, '--network=mainnet'], {}, undefined],
    ['--rpc-url', [...ARGV, '--rpc-url', 'http://rpc'], {}, undefined],
  ])('does not export the saved network over %s', (_label, argv, preset, expected) => {
    savedSession({ ...AUTHORIZED, network: 'calibration' })
    const env: NodeJS.ProcessEnv = { ...preset }
    applySessionFileCredentials(argv, env, PATH)
    expect(env.NETWORK).toBe(expected)
    expect(env.SESSION_KEY).toBe(KEY)
  })

  it('records when only VIEW_ADDRESS kept a usable login out', () => {
    savedSession()
    expect(applySessionFileCredentials(ARGV, { VIEW_ADDRESS: OWNER }, PATH)).toBeUndefined()
    expect(wasSessionSkippedForViewAddress()).toBe(true)
  })

  it('does not blame VIEW_ADDRESS when another credential is also set', () => {
    savedSession()
    applySessionFileCredentials(ARGV, { VIEW_ADDRESS: OWNER, PRIVATE_KEY: '0xenv' }, PATH)
    expect(wasSessionSkippedForViewAddress()).toBe(false)
  })

  it('warns when CI is set and the saved login was used', () => {
    savedSession()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    applySessionFileCredentials(ARGV, { CI: 'true' }, PATH)
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('CI is set and credentials came from the saved login'))
    errors.mockRestore()
  })

  it('stays quiet outside CI', () => {
    savedSession()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    applySessionFileCredentials(ARGV, {}, PATH)
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it('is a no-op without a file', () => {
    noSession()
    const env: NodeJS.ProcessEnv = {}
    expect(applySessionFileCredentials(ARGV, env, PATH)).toBeUndefined()
    expect(env).toEqual({})
  })
})
