import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { publicKeyOf } from '@filoz/keysmith'
import { AddPiecesPermission, CreateDataSetPermission } from '@filoz/synapse-core/session-key'
import { recoverMessageAddress } from 'viem'
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
import {
  OWNER as GRANT_OWNER,
  GROUP_KEY,
  makeGrant,
  OTHER_SESSION_KEY,
  SESSION_ADDRESS,
  SESSION_KEY,
  STRANGER_KEY,
} from '../fixtures/group-key-grants.js'

const OWNER = '0x00000000000000000000000000000000000000aa'
const REGISTRY = '0x00000000000000000000000000000000000000dd'
const FUTURE = 1790380800n
const KEY = `0x${'11'.repeat(32)}` as const
const AUTHORIZE_LINK_PREFIX = 'https://console.test/console/setup?network=calibration&authorize='
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

  it('records the block for --no-wait too, which also tells the owner to rerun', async () => {
    const code = await runLogin({ wait: false })

    expect(code).toBe(2)
    expect(vi.mocked(watchAuthorization)).not.toHaveBeenCalled()
    // The grant is usually mined before the owner reruns; without this the
    // rerun scans from its own head and never sees the event.
    expect(readSessionFile(sessionPath())?.fromBlock).toBe(42n)
  })

  it('still pairs when the block read fails on the --no-wait path', async () => {
    vi.mocked(getBlockNumber).mockRejectedValue(new Error('rpc down'))

    const code = await runLogin({ wait: false })

    expect(code).toBe(2)
    expect(output()).toContain('Not waiting for the authorization')
  })

  it('records the block the wait started at even when the wait times out', async () => {
    // The timeout is the case that matters: the rerun this prints is the one
    // that has to resume, and without the block it would scan from the head.
    vi.mocked(watchAuthorization).mockResolvedValue(TIMED_OUT)

    const code = await runLogin({})

    expect(code).toBe(2)
    expect(readSessionFile(sessionPath())?.fromBlock).toBe(42n)
  })

  it('resumes the scan from the recorded block instead of the current one', async () => {
    const sessionAddress = privateKeyToAccount(KEY).address
    writeSessionFile({ sessionKey: KEY, sessionAddress, network: 'calibration', fromBlock: 7n }, sessionPath())
    vi.mocked(getBlockNumber).mockResolvedValue(9_000n)
    vi.mocked(watchAuthorization).mockResolvedValue(FULL_GRANT)

    await runLogin({})

    // The owner authorizes once. Scanning from 9000 would wait for a second
    // event that never comes, which is what left a timed-out login stuck.
    expect(vi.mocked(watchAuthorization).mock.calls[0]?.[0].fromBlock).toBe(7n)
    expect(readSessionFile(sessionPath())?.fromBlock).toBe(7n)
  })

  it('prints the lowercase authorize link and opens it in the browser', async () => {
    vi.mocked(watchAuthorization).mockResolvedValue(FULL_GRANT)

    await runLogin({})

    const saved = readSessionFile(sessionPath())
    const url = `${AUTHORIZE_LINK_PREFIX}${saved?.sessionAddress.toLowerCase()}&scopes=createDataSet,addPieces`
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
      `${AUTHORIZE_LINK_PREFIX}${saved?.sessionAddress.toLowerCase()}&scopes=createDataSet,addPieces`
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

  describe('group key Grants', () => {
    const ENCRYPT = 'createDataSet,addPieces,encrypt'
    /** The owner that signs the test Grants authorized SESSION_KEY. */
    const GRANT_AUTHORIZED: WatchAuthorizationResult = { ...FULL_GRANT, owner: GRANT_OWNER.address }
    let prompts: string[]

    /** A stdout whose writes (the prompts) land in `prompts`. */
    const fakeStdout = (isTTY: boolean) =>
      Object.assign(
        new Writable({
          write(chunk, _encoding, callback) {
            prompts.push(String(chunk))
            callback()
          },
        }),
        { isTTY }
      )
    /** Streams whose stdin never ends: a read from it would hang the test. */
    const silentStdin = (isTTY: boolean, stdoutIsTTY = isTTY) => ({
      stdin: Object.assign(new PassThrough(), { isTTY }),
      stdout: fakeStdout(stdoutIsTTY),
    })
    /** A terminal the owner pastes `lines` into, then closes. */
    const terminal = (...lines: string[]) => {
      const io = silentStdin(true)
      io.stdin.end(lines.map((line) => `${line}\n`).join(''))
      return io
    }
    const savedKey = (extra: object = {}) =>
      writeSessionFile(
        { sessionKey: SESSION_KEY, sessionAddress: SESSION_ADDRESS, network: 'calibration', ...extra },
        sessionPath()
      )
    const linkIn = (text: string) => {
      const line = text.split('\n').find((l) => l.startsWith('https://console.test/console/setup?'))
      if (line === undefined) throw new Error('no setup link printed')
      return new URL(line)
    }

    beforeEach(() => {
      prompts = []
    })

    it('links with pubkey and pubkeysig, keeps encrypt off the link scopes, and shows the session address', async () => {
      savedKey()

      await runLogin({ scopes: ENCRYPT, wait: false }, silentStdin(false))

      const link = linkIn(output())
      expect(link.searchParams.get('network')).toBe('calibration')
      expect(link.searchParams.get('authorize')).toBe(SESSION_ADDRESS.toLowerCase())
      expect(link.searchParams.get('scopes')).toBe('createDataSet,addPieces')
      const pubkey = link.searchParams.get('pubkey')
      expect(pubkey).toBe(publicKeyOf(SESSION_KEY).toLowerCase())
      const signer = await recoverMessageAddress({
        message: `Keysmith key agreement key: ${pubkey}`,
        signature: link.searchParams.get('pubkeysig') as `0x${string}`,
      })
      expect(signer).toBe(SESSION_ADDRESS)
      expect(output()).toContain(`Session address: ${SESSION_ADDRESS}`)
    })

    it('never asks the chain for encrypt', async () => {
      savedKey()
      vi.mocked(watchAuthorization).mockResolvedValue(GRANT_AUTHORIZED)

      await runLogin({ scopes: ENCRYPT }, silentStdin(false))

      expect(vi.mocked(watchAuthorization).mock.calls[0]?.[0].permissions).toEqual([
        CreateDataSetPermission,
        AddPiecesPermission,
      ])
    })

    it('--no-wait never reads stdin and prints the resume command', async () => {
      savedKey()

      const code = await runLogin({ scopes: ENCRYPT, wait: false }, silentStdin(true))

      expect(code).toBe(2)
      expect(output()).toContain('filecoin-pin login --grant <grant>')
      expect(output()).toContain('filecoin-pin login --grant -')
      expect(prompts).toEqual([])
    })

    it('without a terminal, never blocks: prints the link and the resume command, and exits 2', async () => {
      savedKey()
      vi.mocked(watchAuthorization).mockResolvedValue(GRANT_AUTHORIZED)

      const code = await runLogin({ scopes: ENCRYPT }, silentStdin(false))

      expect(code).toBe(2)
      const text = output()
      expect(text).toContain('Encrypted uploads need the group key Grant')
      expect(text.split('\n').filter((line) => line.includes('pubkeysig='))).toHaveLength(2)
      expect(text).toContain('filecoin-pin login --grant <grant>')
      expect(prompts).toEqual([])
      expect(readSessionFile(sessionPath())).not.toHaveProperty('groupKeyGrant')
    })

    it('on a terminal, explains a wrong paste and asks again', async () => {
      savedKey()
      vi.mocked(watchAuthorization).mockResolvedValue(GRANT_AUTHORIZED)

      const code = await runLogin({ scopes: ENCRYPT }, terminal('fak1_abc', await makeGrant()))

      expect(code).toBe(0)
      expect(prompts.join('')).toContain('This is an Access key, not a Grant')
      expect(prompts.filter((p) => p.includes('Paste the Grant'))).toHaveLength(2)
    })

    it('on a terminal, a paste with foreign characters is refused and asked again', async () => {
      savedKey()
      vi.mocked(watchAuthorization).mockResolvedValue(GRANT_AUTHORIZED)
      const grant = await makeGrant()

      const code = await runLogin({ scopes: ENCRYPT }, terminal(`${grant.slice(0, 100)}+${grant.slice(101)}`, grant))

      expect(code).toBe(0)
      const text = prompts.join('')
      expect(text).toContain('This is not a Grant: it contains characters a Grant never has')
    })

    it('on a terminal, an empty line skips the Grant with the resume command', async () => {
      savedKey()
      vi.mocked(watchAuthorization).mockResolvedValue(GRANT_AUTHORIZED)

      const code = await runLogin({ scopes: ENCRYPT }, terminal(''))

      expect(code).toBe(2)
      expect(output()).toContain('filecoin-pin login --grant <grant>')
    })

    it('without encrypt, asks for no Grant', async () => {
      savedKey()
      vi.mocked(watchAuthorization).mockResolvedValue(GRANT_AUTHORIZED)

      const code = await runLogin({}, terminal(await makeGrant()))

      expect(code).toBe(0)
      expect(prompts).toEqual([])
      expect(output()).not.toMatch(/Grant|pubkey/)
      expect(readSessionFile(sessionPath())).not.toHaveProperty('groupKeyGrant')
    })

    it('login --grant imports a Grant for the authorized session, offline', async () => {
      savedKey({ walletAddress: GRANT_OWNER.address })
      const grant = await makeGrant()

      const code = await runLogin({ grant }, silentStdin(false))

      expect(code).toBe(0)
      expect(readSessionFile(sessionPath())).toMatchObject({ groupKeyId: GROUP_KEY, groupKeyGrant: grant })
      expect(vi.mocked(resolveNetwork)).not.toHaveBeenCalled()
      expect(vi.mocked(watchAuthorization)).not.toHaveBeenCalled()
    })

    it('login --grant - reads a Grant with line breaks from stdin', async () => {
      savedKey({ walletAddress: GRANT_OWNER.address })
      const grant = await makeGrant()
      const io = silentStdin(false)
      io.stdin.end(`${grant.slice(0, 250)}\n${grant.slice(250)}\n`)

      const code = await runLogin({ grant: '-' }, io)

      expect(code).toBe(0)
      expect(readSessionFile(sessionPath())?.groupKeyGrant).toBe(grant)
    })

    it('login --grant refuses a Grant for another session key and saves nothing', async () => {
      savedKey({ walletAddress: GRANT_OWNER.address })

      await expect(
        runLogin({ grant: await makeGrant({ sessionKey: OTHER_SESSION_KEY }) }, silentStdin(false))
      ).rejects.toThrow(/another session key/)
      expect(readSessionFile(sessionPath())).not.toHaveProperty('groupKeyGrant')
    })

    it('login --grant refuses a wrong paste before touching the network or waiting', async () => {
      savedKey()

      await expect(runLogin({ grant: 'fak1_abc' }, silentStdin(false))).rejects.toThrow(
        /This is an Access key, not a Grant/
      )
      expect(vi.mocked(resolveNetwork)).not.toHaveBeenCalled()
      expect(vi.mocked(watchAuthorization)).not.toHaveBeenCalled()
    })

    it('login --grant --no-wait before the owner is known says the Grant was not imported, and exits 2', async () => {
      savedKey()

      const code = await runLogin({ grant: await makeGrant(), wait: false }, silentStdin(false))

      expect(code).toBe(2)
      expect(output()).toContain(
        "The Grant was not imported: the session key isn't authorized yet. Approve it in the console, then run `filecoin-pin login --grant …` again."
      )
      expect(readSessionFile(sessionPath())).not.toHaveProperty('groupKeyGrant')
    })

    it('login --grant imports offline once the owner is known, even with --rpc-url', async () => {
      savedKey({ walletAddress: GRANT_OWNER.address })

      const code = await runLogin({ grant: await makeGrant(), rpcUrl: 'http://rpc.test' }, silentStdin(false))

      expect(code).toBe(0)
      expect(vi.mocked(resolveNetwork)).not.toHaveBeenCalled()
      expect(readSessionFile(sessionPath())?.groupKeyId).toBe(GROUP_KEY)
    })

    it('login --fresh --grant is refused before the saved key is replaced', async () => {
      savedKey({ walletAddress: GRANT_OWNER.address })

      await expect(runLogin({ fresh: true, grant: await makeGrant() }, silentStdin(false))).rejects.toThrow(
        /a --fresh key has none yet/
      )
      expect(readSessionFile(sessionPath())?.sessionKey).toBe(SESSION_KEY)
      expect(vi.mocked(resolveNetwork)).not.toHaveBeenCalled()
    })

    it.each([
      ['for another session key', { sessionKey: OTHER_SESSION_KEY }, /another session key/],
      ['expired', { expires: 1_000_000 }, /This Grant expired at/],
    ])('login --grant with a Grant %s fails before the link and the wait', async (_case, input, message) => {
      savedKey()

      await expect(runLogin({ grant: await makeGrant(input) }, silentStdin(false))).rejects.toThrow(message)
      expect(vi.mocked(watchAuthorization)).not.toHaveBeenCalled()
      expect(output()).not.toContain('console/setup')
    })

    it('a Grant refused after the wait keeps the login, says why, and exits 2', async () => {
      savedKey()
      vi.mocked(watchAuthorization).mockResolvedValue(GRANT_AUTHORIZED)

      const code = await runLogin({ grant: await makeGrant({ ownerKey: STRANGER_KEY }) }, silentStdin(false))

      expect(code).toBe(2)
      expect(output()).toMatch(/Grant refused: This Grant is from wallet 0x[0-9a-fA-F]{40}, not/)
      expect(output()).toContain('filecoin-pin login --grant <grant>')
      const saved = readSessionFile(sessionPath())
      expect(saved?.walletAddress).toBe(GRANT_OWNER.address)
      expect(saved).not.toHaveProperty('groupKeyGrant')
    })

    it('login --grant refuses a network the console does not serve', async () => {
      writeSessionFile(
        { sessionKey: SESSION_KEY, sessionAddress: SESSION_ADDRESS, walletAddress: GRANT_OWNER.address },
        sessionPath()
      )

      await expect(runLogin({ grant: await makeGrant(), network: 'devnet' }, silentStdin(false))).rejects.toThrow(
        /login --grant works on mainnet and calibration, not devnet/
      )
    })

    it('login --grant - refuses a terminal instead of waiting on it', async () => {
      savedKey({ walletAddress: GRANT_OWNER.address })

      await expect(runLogin({ grant: '-' }, silentStdin(true))).rejects.toThrow(
        /pipe the Grant in, or pass it as an argument/
      )
    })

    it('login --grant - refuses more than 16 KB of stdin', async () => {
      savedKey({ walletAddress: GRANT_OWNER.address })
      const io = silentStdin(false)
      io.stdin.write('a'.repeat(10_000))
      io.stdin.end('a'.repeat(10_000))

      await expect(runLogin({ grant: '-' }, io)).rejects.toThrow(/more than 16 KB, which is not a Grant/)
    })

    it('with stdin a terminal but stdout not, never prompts: prints the resume command and exits 2', async () => {
      savedKey()
      vi.mocked(watchAuthorization).mockResolvedValue(GRANT_AUTHORIZED)

      const code = await runLogin({ scopes: ENCRYPT }, silentStdin(true, false))

      expect(code).toBe(2)
      expect(prompts).toEqual([])
      expect(output()).toContain('filecoin-pin login --grant <grant>')
    })

    it('on a terminal, a cut-short paste is refused and asked again', async () => {
      savedKey()
      vi.mocked(watchAuthorization).mockResolvedValue(GRANT_AUTHORIZED)
      const grant = await makeGrant()

      const code = await runLogin({ scopes: ENCRYPT }, terminal(grant.slice(0, 200), grant))

      expect(code).toBe(0)
      expect(prompts.join('')).toContain('The Grant is incomplete or corrupted; copy it again from the console.')
      expect(readSessionFile(sessionPath())?.groupKeyGrant).toBe(grant)
    })

    it('login --grant with no saved session fails and writes nothing', async () => {
      await expect(runLogin({ grant: await makeGrant() }, silentStdin(false))).rejects.toThrow(
        'No saved session to import a Grant for. Run `filecoin-pin login --scopes createDataSet,addPieces,encrypt` first.'
      )
      expect(existsSync(sessionPath())).toBe(false)
      expect(vi.mocked(resolveNetwork)).not.toHaveBeenCalled()
    })

    it('warns that an exported GROUP_KEY_GRANT takes precedence over the saved one', async () => {
      vi.stubEnv('GROUP_KEY_GRANT', 'fgr1_env')

      await runLogin({ wait: false }, silentStdin(false))

      expect(output()).toContain('⚠ GROUP_KEY_GRANT is set in this shell and takes precedence over the saved login.')
    })

    it('a new Grant replaces the saved one', async () => {
      const other = `0x${'ab'.repeat(16)}` as const
      savedKey({ walletAddress: GRANT_OWNER.address })
      await runLogin({ grant: await makeGrant() }, silentStdin(false))

      await runLogin({ grant: await makeGrant({ groupKey: other }) }, silentStdin(false))

      expect(readSessionFile(sessionPath())?.groupKeyId).toBe(other)
      expect(readFileSync(sessionPath(), 'utf8').match(/GROUP_KEY_GRANT=/g)).toHaveLength(1)
    })

    it('login --grant before the authorization was seen resumes the wait on the saved network, then imports', async () => {
      savedKey({ fromBlock: 7n })
      vi.mocked(watchAuthorization).mockResolvedValue(GRANT_AUTHORIZED)
      const grant = await makeGrant()

      const code = await runLogin({ grant }, silentStdin(false))

      expect(code).toBe(0)
      expect(vi.mocked(resolveNetwork)).toHaveBeenCalledWith(expect.objectContaining({ network: 'calibration' }))
      expect(vi.mocked(openBrowser)).not.toHaveBeenCalled()
      expect(readSessionFile(sessionPath())).toMatchObject({ walletAddress: GRANT_OWNER.address, groupKeyGrant: grant })
    })

    it('keeps the saved Grant through the rewrite of a resumed login', async () => {
      const grant = await makeGrant()
      savedKey({ walletAddress: GRANT_OWNER.address, groupKeyId: GROUP_KEY, groupKeyGrant: grant })
      vi.mocked(watchAuthorization).mockResolvedValue(GRANT_AUTHORIZED)

      await runLogin({}, silentStdin(false))

      // The owner-found rewrite added FROM_BLOCK; the Grant must ride along.
      const saved = readSessionFile(sessionPath())
      expect(saved?.fromBlock).toBe(42n)
      expect(saved).toMatchObject({ groupKeyId: GROUP_KEY, groupKeyGrant: grant })
    })

    it('on a resumed login with encrypt, keeps a saved Grant that still opens, without asking', async () => {
      const grant = await makeGrant()
      savedKey({ walletAddress: GRANT_OWNER.address, groupKeyId: GROUP_KEY, groupKeyGrant: grant })
      vi.mocked(watchAuthorization).mockResolvedValue(GRANT_AUTHORIZED)

      const code = await runLogin({ scopes: ENCRYPT }, silentStdin(true))

      expect(code).toBe(0)
      expect(output()).toContain(`Grant for group key ${GROUP_KEY} already saved`)
      expect(prompts).toEqual([])
    })

    it('on a resumed login with encrypt, ignores a saved Grant that no longer opens and asks again', async () => {
      const stale = await makeGrant({ expires: Math.floor(Date.now() / 1000) - 3600 })
      savedKey({ walletAddress: GRANT_OWNER.address, groupKeyId: GROUP_KEY, groupKeyGrant: stale })
      vi.mocked(watchAuthorization).mockResolvedValue(GRANT_AUTHORIZED)

      const code = await runLogin({ scopes: ENCRYPT }, silentStdin(false))

      expect(code).toBe(2)
      expect(output()).toMatch(/The saved Grant was ignored: This Grant expired/)
      expect(output()).toContain('filecoin-pin login --grant <grant>')
    })

    it('--fresh drops the Grant and warns that the replaced key can still open it', async () => {
      savedKey({ walletAddress: GRANT_OWNER.address, groupKeyId: GROUP_KEY, groupKeyGrant: await makeGrant() })

      await runLogin({ fresh: true, wait: false }, silentStdin(false))

      const saved = readSessionFile(sessionPath())
      expect(saved?.sessionKey).not.toBe(SESSION_KEY)
      expect(saved).not.toHaveProperty('groupKeyGrant')
      expect(readFileSync(sessionPath(), 'utf8')).not.toContain('GROUP_KEY')
      expect(output()).toContain(
        `Dropped its Grant for group key ${GROUP_KEY}. The replaced key can still open that Grant`
      )
    })

    it('refuses encrypt on a network without a console, pointing at owner mode', async () => {
      vi.mocked(resolveNetwork).mockResolvedValue(networkFor(31415926, 'devnet'))

      await expect(runLogin({ scopes: ENCRYPT }, silentStdin(false))).rejects.toThrow(
        /no page for chain id 31415926.*encrypt in owner mode: set PRIVATE_KEY/
      )
      expect(readSessionFile(sessionPath())).toBeUndefined()
    })

    it('refuses encrypt without an on-chain scope', async () => {
      await expect(runLogin({ scopes: 'encrypt' }, silentStdin(false))).rejects.toThrow(
        /at least one.*login also takes encrypt/
      )
    })
  })
})

describe('login command wiring', () => {
  it('never accepts the owner private key', () => {
    expect(loginCommand.options.some((o) => o.long === '--private-key')).toBe(false)
  })
})
