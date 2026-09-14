import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AddPiecesPermission, CreateDataSetPermission } from '@filoz/synapse-core/session-key'
import { privateKeyToAccount } from 'viem/accounts'
import { getBlockNumber } from 'viem/actions'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loginCommand } from '../../commands/login.js'
import { type WatchAuthorizationResult, watchAuthorization } from '../../core/session/watch-authorization.js'
import { initializeSynapse } from '../../core/synapse/index.js'
import { openBrowser } from '../../login/open-browser.js'
import { checkAccountReadiness } from '../../login/readiness.js'
import { runLogin } from '../../login/run-login.js'
import { readSessionFile, writeSessionFile } from '../../login/session-file.js'
import { resolveNetwork } from '../../session/resolve-network.js'
import { log } from '../../utils/cli-logger.js'

const OWNER = '0x00000000000000000000000000000000000000aa'
const REGISTRY = '0x00000000000000000000000000000000000000dd'
const FUTURE = 1790380800n
const KEY = `0x${'11'.repeat(32)}` as const
const AUTHORIZE_LINK_PREFIX = 'https://console.test/console/session-keys?authorize='
const FUNDING_LINK = 'https://console.test/console?deposit=2&operator=fwss&network=calibration'

const FULL_GRANT: WatchAuthorizationResult = {
  status: 'granted',
  owner: OWNER,
  expiry: FUTURE,
  granted: [CreateDataSetPermission, AddPiecesPermission],
  missing: [],
}
const TIMED_OUT: WatchAuthorizationResult = { status: 'timeout', granted: [], missing: [] }

let dataDir: string

vi.mock('../../config.js', () => ({ getDataDirectory: () => dataDir }))
vi.mock('../../core/session/watch-authorization.js', () => ({
  watchAuthorization: vi.fn(),
  DEFAULT_WATCH_DEADLINE_MS: 300000,
}))
vi.mock('../../login/open-browser.js', () => ({ openBrowser: vi.fn(() => false) }))
vi.mock('../../login/readiness.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../login/readiness.js')>()
  return {
    ...actual,
    checkAccountReadiness: vi.fn(async () => ({ serviceApproved: false, depositUsdfc: 0n })),
  }
})
vi.mock('../../core/synapse/index.js', () => ({ initializeSynapse: vi.fn(async () => ({})) }))
vi.mock('../../session/resolve-network.js', () => ({
  resolveNetwork: vi.fn(async () => ({
    chain: { id: 314159, name: 'calibration', contracts: { sessionKeyRegistry: { address: REGISTRY } } },
    rpcUrl: 'http://rpc.test',
    transport: () => ({ request: vi.fn() }),
  })),
}))
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>()
  return { ...actual, createPublicClient: vi.fn(() => ({ request: vi.fn() })) }
})
vi.mock('viem/actions', () => ({ getBlockNumber: vi.fn(async () => 42n) }))

/** Joined log lines with ANSI colour codes stripped, since CI forces colour on. */
function output(): string {
  return vi
    .mocked(log.line)
    .mock.calls.map((call) => String(call[0]))
    .join('\n')
    .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')
}

function sessionPath(): string {
  return join(dataDir, 'session.env')
}

/** A resolveNetwork result for a chain other than the default calibration one. */
function networkFor(chainId: number, name: string, rpcUrl = 'http://rpc.test') {
  return {
    chain: { id: chainId, name, contracts: { sessionKeyRegistry: { address: REGISTRY } } },
    rpcUrl,
    transport: () => ({ request: vi.fn() }),
  } as never
}

describe('runLogin', () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'login-run-'))
    vi.spyOn(log, 'line').mockImplementation(() => undefined)
    vi.spyOn(log, 'flush').mockImplementation(() => undefined)
    vi.stubEnv('CONSOLE_URL', 'https://console.test')
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    // Module mocks survive restoreAllMocks; reset each one so call counts
    // and per-test return values never reach the next test.
    for (const fn of [
      openBrowser,
      initializeSynapse,
      resolveNetwork,
      getBlockNumber,
      checkAccountReadiness,
      watchAuthorization,
    ]) {
      vi.mocked(fn).mockReset()
    }
  })

  it('writes the session file before the wait starts', async () => {
    vi.mocked(watchAuthorization).mockImplementation(async (options) => {
      // The file exists by the time the wait starts.
      const saved = readSessionFile(sessionPath())
      expect(saved?.sessionAddress).toBe(options.sessionAddress)
      expect(saved?.walletAddress).toBeUndefined()
      expect(options.fromBlock).toBe(42n)
      expect(options.registryAddress).toBe(REGISTRY)
      expect(options.permissions).toEqual([CreateDataSetPermission, AddPiecesPermission])
      return FULL_GRANT
    })

    const code = await runLogin({})

    expect(code).toBe(0)
    expect(vi.mocked(watchAuthorization)).toHaveBeenCalledOnce()
  })

  it('prints the lowercase authorize link and opens it in the browser', async () => {
    vi.mocked(watchAuthorization).mockResolvedValue(FULL_GRANT)

    await runLogin({})

    const saved = readSessionFile(sessionPath())
    const url = `${AUTHORIZE_LINK_PREFIX}${saved?.sessionAddress.toLowerCase()}&scopes=createDataSet,addPieces&network=calibration`
    expect(output()).toContain(url)
    expect(vi.mocked(openBrowser)).toHaveBeenCalledExactlyOnceWith(url)
  })

  it('prints the funding link when the storage service is not approved and nothing is deposited', async () => {
    vi.mocked(watchAuthorization).mockResolvedValue(FULL_GRANT)
    vi.mocked(checkAccountReadiness).mockResolvedValue({ serviceApproved: false, depositUsdfc: 0n })

    await runLogin({})

    const text = output()
    expect(text).toContain('storage service not approved yet')
    expect(text).toContain(FUNDING_LINK)
  })

  it('prints the approved scorecard and no funding link when the account is funded', async () => {
    vi.mocked(watchAuthorization).mockResolvedValue(FULL_GRANT)
    vi.mocked(checkAccountReadiness).mockResolvedValue({
      serviceApproved: true,
      depositUsdfc: 5_000_000_000_000_000_000n,
    })

    await runLogin({})

    const text = output()
    expect(text).toContain('✓ storage service approved')
    expect(text).not.toContain('operator=fwss')
  })

  it('reads account readiness over the RPC the user selected', async () => {
    vi.mocked(resolveNetwork).mockResolvedValue(networkFor(314159, 'calibration', 'http://rpc.selected'))
    vi.mocked(watchAuthorization).mockResolvedValue(FULL_GRANT)

    await runLogin({})

    expect(vi.mocked(initializeSynapse)).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ walletAddress: OWNER, readOnly: true, rpcUrl: 'http://rpc.selected' })
    )
  })

  it('reports a grant of none of the requested scopes and exits 2', async () => {
    vi.mocked(watchAuthorization).mockResolvedValue({
      status: 'none',
      owner: OWNER,
      granted: [],
      missing: [CreateDataSetPermission, AddPiecesPermission],
    })

    const code = await runLogin({})

    expect(code).toBe(2)
    expect(output()).toContain('Authorized with none of the requested scopes')
    expect(readSessionFile(sessionPath())?.walletAddress).toBe(OWNER)
  })

  it('still exits 0 when the readiness read fails after a full grant', async () => {
    vi.mocked(watchAuthorization).mockResolvedValue(FULL_GRANT)
    vi.mocked(checkAccountReadiness).mockRejectedValue(new Error('rpc down'))

    const code = await runLogin({})

    expect(code).toBe(0)
    expect(output()).toContain('Could not read account readiness: rpc down')
  })

  it('resumes the saved key and passes the known owner to the watcher', async () => {
    const session = privateKeyToAccount(KEY).address
    writeSessionFile({ sessionKey: KEY, sessionAddress: session, walletAddress: OWNER }, sessionPath())
    vi.mocked(watchAuthorization).mockResolvedValue(TIMED_OUT)

    const code = await runLogin({})

    expect(code).toBe(2)
    expect(vi.mocked(watchAuthorization)).toHaveBeenCalledWith(
      expect.objectContaining({ sessionAddress: session, owner: OWNER })
    )
    expect(output()).toContain('Resuming session key')
    expect(readSessionFile(sessionPath())?.sessionKey).toBe(KEY)
  })

  it('--fresh replaces an authorized key and warns that it stays live on chain', async () => {
    const replaced = privateKeyToAccount(KEY).address
    writeSessionFile({ sessionKey: KEY, sessionAddress: replaced, walletAddress: OWNER }, sessionPath())
    vi.mocked(watchAuthorization).mockResolvedValue(TIMED_OUT)

    await runLogin({ fresh: true })

    const saved = readSessionFile(sessionPath())
    expect(saved?.sessionKey).not.toBe(KEY)
    expect(saved?.walletAddress).toBeUndefined()
    expect(vi.mocked(watchAuthorization)).toHaveBeenCalledExactlyOnceWith(expect.not.objectContaining({ owner: OWNER }))
    expect(output()).toContain('stays authorized on chain')
  })

  it('reports a partial grant with the requested-versus-granted diff and exits 2 even though uploads work', async () => {
    vi.mocked(watchAuthorization).mockResolvedValue({
      status: 'partial',
      owner: OWNER,
      expiry: FUTURE,
      granted: [CreateDataSetPermission, AddPiecesPermission],
      missing: ['0x5415701e313bb627e755b16924727217bb356574fe20e7061442c200b0822b22'],
    })

    const code = await runLogin({ scopes: 'createDataSet,addPieces,schedulePieceRemovals' })

    expect(code).toBe(2)
    const text = output()
    expect(text).toContain('Requested:  createDataSet, addPieces, schedulePieceRemovals')
    expect(text).toContain('schedulePieceRemovals ✗')
    expect(text).toContain('Uploads will work.')
  })

  it('rejects an unknown scope before touching the network', async () => {
    await expect(runLogin({ scopes: 'nope' })).rejects.toThrow(/Unknown scope "nope"/)
    expect(vi.mocked(watchAuthorization)).not.toHaveBeenCalled()
  })

  it('records the network in the session file', async () => {
    vi.mocked(watchAuthorization).mockResolvedValue(TIMED_OUT)

    await runLogin({})

    expect(readSessionFile(sessionPath())?.network).toBe('calibration')
  })

  it('refuses to resume a key made for another network', async () => {
    writeSessionFile(
      { sessionKey: KEY, sessionAddress: privateKeyToAccount(KEY).address, network: 'calibration' },
      sessionPath()
    )
    vi.mocked(resolveNetwork).mockResolvedValue(networkFor(314, 'mainnet'))

    await expect(runLogin({})).rejects.toThrow(/saved login is for calibration, not mainnet/)
    expect(vi.mocked(watchAuthorization)).not.toHaveBeenCalled()
  })

  it('refuses a chain the console has no page for before saving anything', async () => {
    vi.mocked(resolveNetwork).mockResolvedValue(networkFor(31415926, 'devnet'))

    await expect(runLogin({})).rejects.toThrow(/no pairing page for chain id 31415926/)
    expect(readSessionFile(sessionPath())).toBeUndefined()
    expect(vi.mocked(openBrowser)).not.toHaveBeenCalled()
  })

  it('--no-wait saves the key, prints the bare link, and exits 2 without watching', async () => {
    const code = await runLogin({ wait: false })

    expect(code).toBe(2)
    expect(vi.mocked(watchAuthorization)).not.toHaveBeenCalled()
    const saved = readSessionFile(sessionPath())
    expect(saved?.sessionAddress).toBeDefined()
    const lines = vi.mocked(log.line).mock.calls.map((call) => String(call[0]))
    expect(lines).toContain(
      `${AUTHORIZE_LINK_PREFIX}${saved?.sessionAddress.toLowerCase()}&scopes=createDataSet,addPieces&network=calibration`
    )
  })

  it('--no-browser keeps the browser closed', async () => {
    vi.mocked(watchAuthorization).mockResolvedValue(TIMED_OUT)

    await runLogin({ browser: false })

    expect(vi.mocked(openBrowser)).not.toHaveBeenCalled()
  })

  it('--timeout shortens the wait and the Ctrl-C handler is removed after a timeout', async () => {
    vi.mocked(watchAuthorization).mockResolvedValue(TIMED_OUT)
    const sigintListeners = process.listenerCount('SIGINT')

    await runLogin({ browser: false, timeout: 30 })

    expect(vi.mocked(watchAuthorization)).toHaveBeenCalledWith(expect.objectContaining({ deadlineMs: 30000 }))
    expect(process.listenerCount('SIGINT')).toBe(sigintListeners)
  })

  it('prints the link before touching the RPC, so a dead endpoint still pairs', async () => {
    vi.mocked(getBlockNumber).mockRejectedValue(new Error('rpc down'))

    await expect(runLogin({ network: 'calibration', browser: false })).rejects.toThrow('rpc down')
    expect(output()).toContain(AUTHORIZE_LINK_PREFIX)
  })

  it('stops the spinner with a resume hint when the watch itself fails', async () => {
    // Outside a TTY the spinner's stop line goes through log.message, not log.line.
    const message = vi.spyOn(log, 'message').mockImplementation(() => undefined)
    vi.mocked(watchAuthorization).mockRejectedValue(new Error('endpoint failed 3 polls in a row'))
    const sigintListeners = process.listenerCount('SIGINT')

    await expect(runLogin({ network: 'calibration', browser: false })).rejects.toThrow('3 polls in a row')
    expect(message).toHaveBeenCalledWith(expect.stringContaining('Could not watch for the authorization'))
    expect(process.listenerCount('SIGINT')).toBe(sigintListeners)
  })

  it('warns when a shell credential will shadow the saved login', async () => {
    vi.mocked(watchAuthorization).mockResolvedValue(TIMED_OUT)
    vi.stubEnv('SESSION_KEY', KEY)

    await runLogin({})

    expect(output()).toContain('SESSION_KEY is set')
  })
})

describe('login command wiring', () => {
  it('never accepts the owner private key', () => {
    expect(loginCommand.options.some((o) => o.long === '--private-key')).toBe(false)
  })
})
