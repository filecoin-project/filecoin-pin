import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AddPiecesPermission, CreateDataSetPermission } from '@filoz/synapse-core/session-key'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loginCommand, logoutCommand } from '../../commands/login.js'
import { watchAuthorization } from '../../core/session/watch-authorization.js'
import { openBrowser } from '../../login/open-browser.js'
import { checkAccountReadiness } from '../../login/readiness.js'
import { runLogin } from '../../login/run-login.js'
import { readSessionFile, writeSessionFile } from '../../login/session-file.js'
import { log } from '../../utils/cli-logger.js'

const OWNER = '0x00000000000000000000000000000000000000aa'
const REGISTRY = '0x00000000000000000000000000000000000000dd'
const FUTURE = 1790380800n

let dataDir: string

vi.mock('../../config.js', () => ({ getDataDirectory: () => dataDir }))
vi.mock('../../core/session/watch-authorization.js', () => ({ watchAuthorization: vi.fn() }))
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

function output(): string {
  return vi
    .mocked(log.line)
    .mock.calls.map((call) => String(call[0]))
    .join('\n')
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
    expect(text).toContain('Requesting scopes: createDataSet, addPieces (defaults — override with --scopes)')
    expect(text).toContain(
      `https://console.test/console/session-keys?authorize=${saved?.sessionAddress.toLowerCase()}&scopes=createDataSet,addPieces&network=calibration`
    )
    expect(text).toContain('storage service not approved yet')
    expect(text).toContain('USDFC deposit — 0.00')
    expect(text).toContain('https://console.test/console?deposit=2&operator=fwss')
    expect(text).not.toMatch(/FWSS operator|operator approval/i)
    expect(vi.mocked(openBrowser)).toHaveBeenCalledOnce()
  })

  it('resumes the saved key and passes the known owner to the watcher', async () => {
    const key = `0x${'11'.repeat(32)}` as const
    const session = '0x00000000000000000000000000000000000000bb'
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

  it('reports a partial grant with the requested-versus-granted diff and exits 2', async () => {
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
    expect(text).toContain('Authorized with fewer scopes than requested')
    expect(text).toContain('Requested:  createDataSet, addPieces, schedulePieceRemovals')
    expect(text).toContain('schedulePieceRemovals ✗ (owner declined)')
    expect(text).toContain('Uploads will work.')
  })

  it('rejects an unknown scope before touching the network', async () => {
    await expect(runLogin({ scopes: 'nope' })).rejects.toThrow(/Unknown scope "nope"/)
    expect(vi.mocked(watchAuthorization)).not.toHaveBeenCalled()
  })
})

describe('login command wiring', () => {
  it('registers login with --scopes, --fresh, and network flags', () => {
    const longs = loginCommand.options.map((o) => o.long)
    expect(longs).toEqual(expect.arrayContaining(['--scopes', '--fresh', '--network', '--rpc-url']))
    expect(loginCommand.options.some((o) => o.long === '--private-key')).toBe(false)
  })

  it('registers logout with no options', () => {
    expect(logoutCommand.name()).toBe('logout')
    expect(logoutCommand.options).toHaveLength(0)
  })
})
