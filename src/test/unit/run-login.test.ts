import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AddPiecesPermission, CreateDataSetPermission } from '@filoz/synapse-core/session-key'
import { privateKeyToAccount } from 'viem/accounts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loginCommand } from '../../commands/login.js'
import { watchAuthorization } from '../../core/session/watch-authorization.js'
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

let dataDir: string

vi.mock('../../config.js', () => ({ getDataDirectory: () => dataDir }))
vi.mock('../../core/session/watch-authorization.js', () => ({
  watchAuthorization: vi.fn(),
  DEFAULT_WATCH_DEADLINE_MS: 300000,
}))
vi.mock('../../login/open-browser.js', () => ({ openBrowser: vi.fn(() => false) }))
vi.mock('../../login/readiness.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../login/readiness.js')>()
  return { ...actual, checkAccountReadiness: vi.fn() }
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

describe('runLogin', () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'login-run-'))
    vi.spyOn(log, 'line').mockImplementation(() => undefined)
    vi.spyOn(log, 'flush').mockImplementation(() => undefined)
    vi.mocked(checkAccountReadiness).mockResolvedValue({ serviceApproved: false, depositUsdfc: 0n })
    process.env.CONSOLE_URL = 'https://console.test'
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
    vi.restoreAllMocks()
    vi.mocked(watchAuthorization).mockReset()
    delete process.env.CONSOLE_URL
  })

  it('saves the key before watching, prints the lowercase authorize link, and exits 0 on a full grant', async () => {
    vi.mocked(watchAuthorization).mockImplementation(async (options) => {
      // The file exists by the time the wait starts.
      const saved = readSessionFile(join(dataDir, 'session.env'))
      expect(saved?.sessionAddress).toBe(options.sessionAddress)
      expect(saved?.walletAddress).toBeUndefined()
      expect(options.fromBlock).toBe(42n)
      expect(options.registryAddress).toBe(REGISTRY)
      expect(options.permissions).toEqual([CreateDataSetPermission, AddPiecesPermission])
      return {
        status: 'granted',
        owner: OWNER,
        expiry: FUTURE,
        granted: [CreateDataSetPermission, AddPiecesPermission],
        missing: [],
      }
    })

    const code = await runLogin({})

    expect(code).toBe(0)
    const saved = readSessionFile(join(dataDir, 'session.env'))
    expect(saved?.walletAddress).toBe(OWNER)
    const text = output()
    expect(text).toContain('Session key generated')
    expect(text).toContain(
      `https://console.test/console/session-keys?authorize=${saved?.sessionAddress.toLowerCase()}&scopes=createDataSet,addPieces&network=calibration`
    )
    expect(text).toContain('https://console.test/console?deposit=2&operator=fwss&network=calibration')
    expect(vi.mocked(openBrowser)).toHaveBeenCalledOnce()
    // The readiness read uses the RPC the user selected, not the chain default.
    expect(vi.mocked(initializeSynapse)).toHaveBeenCalledWith(
      expect.objectContaining({ walletAddress: OWNER, readOnly: true, rpcUrl: 'http://rpc.test' })
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
    expect(readSessionFile(join(dataDir, 'session.env'))?.walletAddress).toBe(OWNER)
  })

  it('still exits 0 when the readiness read fails after a full grant', async () => {
    vi.mocked(watchAuthorization).mockResolvedValue({
      status: 'granted',
      owner: OWNER,
      expiry: FUTURE,
      granted: [CreateDataSetPermission, AddPiecesPermission],
      missing: [],
    })
    vi.mocked(checkAccountReadiness).mockRejectedValue(new Error('rpc down'))

    const code = await runLogin({})

    expect(code).toBe(0)
    expect(output()).toContain('Could not read account readiness: rpc down')
  })

  it('resumes the saved key and passes the known owner to the watcher', async () => {
    const key = `0x${'11'.repeat(32)}` as const
    const session = privateKeyToAccount(key).address
    writeSessionFile({ sessionKey: key, sessionAddress: session, walletAddress: OWNER }, join(dataDir, 'session.env'))
    vi.mocked(watchAuthorization).mockResolvedValue({ status: 'timeout', granted: [], missing: [] })

    const code = await runLogin({})

    expect(code).toBe(2)
    expect(vi.mocked(watchAuthorization)).toHaveBeenCalledWith(
      expect.objectContaining({ sessionAddress: session, owner: OWNER })
    )
    expect(output()).toContain('Resuming session key')
    expect(readSessionFile(join(dataDir, 'session.env'))?.sessionKey).toBe(key)
  })

  it('--fresh replaces the saved key', async () => {
    const key = `0x${'11'.repeat(32)}` as const
    writeSessionFile(
      { sessionKey: key, sessionAddress: '0x00000000000000000000000000000000000000bb' },
      join(dataDir, 'session.env')
    )
    vi.mocked(watchAuthorization).mockResolvedValue({ status: 'timeout', granted: [], missing: [] })

    await runLogin({ fresh: true })

    expect(readSessionFile(join(dataDir, 'session.env'))?.sessionKey).not.toBe(key)
    expect(vi.mocked(watchAuthorization)).toHaveBeenCalledWith(expect.not.objectContaining({ owner: OWNER }))
  })

  it('reports a partial grant with the requested-versus-granted diff and exits 0 when uploads still work', async () => {
    vi.mocked(watchAuthorization).mockResolvedValue({
      status: 'partial',
      owner: OWNER,
      expiry: FUTURE,
      granted: [CreateDataSetPermission, AddPiecesPermission],
      missing: ['0x5415701e313bb627e755b16924727217bb356574fe20e7061442c200b0822b22'],
    })

    const code = await runLogin({ scopes: 'createDataSet,addPieces,schedulePieceRemovals' })

    expect(code).toBe(0)
    const text = output()
    expect(text).toContain('Requested:  createDataSet, addPieces, schedulePieceRemovals')
    expect(text).toContain('schedulePieceRemovals ✗')
  })

  it('rejects an unknown scope before touching the network', async () => {
    await expect(runLogin({ scopes: 'nope' })).rejects.toThrow(/Unknown scope "nope"/)
    expect(vi.mocked(watchAuthorization)).not.toHaveBeenCalled()
  })

  it('records the network in the session file and refuses to resume a key made for another one', async () => {
    vi.mocked(watchAuthorization).mockResolvedValue({ status: 'timeout', granted: [], missing: [] })
    await runLogin({})
    expect(readSessionFile(join(dataDir, 'session.env'))?.network).toBe('calibration')

    vi.mocked(resolveNetwork).mockResolvedValueOnce({
      chain: { id: 314, name: 'mainnet', contracts: { sessionKeyRegistry: { address: REGISTRY } } },
      rpcUrl: 'http://rpc.test',
      transport: () => ({ request: vi.fn() }),
    } as never)
    await expect(runLogin({})).rejects.toThrow(/saved login is for calibration, not mainnet/)
    expect(vi.mocked(watchAuthorization)).toHaveBeenCalledOnce()
  })

  it('refuses a chain the console has no page for before saving anything', async () => {
    vi.mocked(openBrowser).mockClear()
    vi.mocked(resolveNetwork).mockResolvedValueOnce({
      chain: { id: 31415926, name: 'devnet', contracts: { sessionKeyRegistry: { address: REGISTRY } } },
      rpcUrl: 'http://rpc.test',
      transport: () => ({ request: vi.fn() }),
    } as never)

    await expect(runLogin({})).rejects.toThrow(/no pairing page for chain id 31415926/)
    expect(readSessionFile(join(dataDir, 'session.env'))).toBeUndefined()
    expect(vi.mocked(openBrowser)).not.toHaveBeenCalled()
  })

  it('--no-wait saves the key, prints the bare link, and exits 2 without watching', async () => {
    const code = await runLogin({ wait: false })

    expect(code).toBe(2)
    expect(vi.mocked(watchAuthorization)).not.toHaveBeenCalled()
    const saved = readSessionFile(join(dataDir, 'session.env'))
    expect(saved?.sessionAddress).toBeDefined()
    const lines = vi.mocked(log.line).mock.calls.map((call) => String(call[0]))
    expect(lines).toContain(
      `https://console.test/console/session-keys?authorize=${saved?.sessionAddress.toLowerCase()}&scopes=createDataSet,addPieces&network=calibration`
    )
  })

  it('--no-browser keeps the browser closed and --timeout shortens the wait', async () => {
    vi.mocked(openBrowser).mockClear()
    vi.mocked(watchAuthorization).mockResolvedValue({ status: 'timeout', granted: [], missing: [] })

    await runLogin({ browser: false, timeout: 30 })

    expect(vi.mocked(openBrowser)).not.toHaveBeenCalled()
    expect(vi.mocked(watchAuthorization)).toHaveBeenCalledWith(expect.objectContaining({ deadlineMs: 30000 }))
  })

  it('warns when a shell credential will shadow the saved login and when --fresh orphans a live key', async () => {
    const key = `0x${'11'.repeat(32)}` as const
    writeSessionFile(
      { sessionKey: key, sessionAddress: privateKeyToAccount(key).address, walletAddress: OWNER },
      join(dataDir, 'session.env')
    )
    vi.mocked(watchAuthorization).mockResolvedValue({ status: 'timeout', granted: [], missing: [] })
    process.env.SESSION_KEY = key
    try {
      await runLogin({ fresh: true })
    } finally {
      delete process.env.SESSION_KEY
    }

    const text = output()
    expect(text).toContain('SESSION_KEY is set')
    expect(text).toContain('stays authorized on chain')
  })
})

describe('login command wiring', () => {
  it('never accepts the owner private key', () => {
    expect(loginCommand.options.some((o) => o.long === '--private-key')).toBe(false)
  })
})
