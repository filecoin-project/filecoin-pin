import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The OWS account resolver loads a native binding; stub it so tests exercise
// precedence without touching the vault. The returned sentinel echoes the
// options it was called with so we can assert chain/passphrase handling.
// vi.mock is hoisted above imports, so the mock fns are created via vi.hoisted.
const { getOwsAccount, resolveChainFromRpc } = vi.hoisted(() => ({
  getOwsAccount: vi.fn(async (opts: unknown) => ({ address: '0xf39Fd6', __ows: opts })),
  resolveChainFromRpc: vi.fn(async () => ({ id: 314159, name: 'Filecoin Calibration' })),
}))
vi.mock('../../core/ows/index.js', () => ({ getOwsAccount }))
vi.mock('../../core/synapse/resolve-chain-from-rpc.js', () => ({ resolveChainFromRpc }))

vi.mock('../../core/synapse/index.js', () => ({
  createTransport: vi.fn(() => ({ transport: true })),
  initializeSynapse: vi.fn(),
}))

// getRpcUrl() calls resolveDevnetConfig internally, so mock it at the source
// module (devnet-config) rather than the get-rpc-url re-export; get-rpc-url's
// internal reference and cli-auth's import both resolve to this mock.
const { resolveDevnetConfig } = vi.hoisted(() => ({
  resolveDevnetConfig: vi.fn(() => ({
    privateKey: '0xdevnetkey',
    chain: { id: 31415926, name: 'Devnet', rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } } },
  })),
}))
vi.mock('../../common/devnet-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common/devnet-config.js')>()
  return { ...actual, resolveDevnetConfig }
})

import type { AuthOptionSources, CLIAuthOptions } from '../../utils/cli-auth.js'
import { parseCLIAuth } from '../../utils/cli-auth.js'
import { addAuthOptions } from '../../utils/cli-options.js'

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

/** Build options with an explicit source map so precedence is deterministic. */
function withSources(base: CLIAuthOptions, sources: AuthOptionSources): CLIAuthOptions {
  return { ...base, optionSources: sources }
}

beforeEach(() => {
  getOwsAccount.mockClear()
  resolveChainFromRpc.mockClear()
})

describe('parseCLIAuth - single auth mode', () => {
  it('resolves a private key into a private-key config', async () => {
    const config = await parseCLIAuth({ privateKey: PK, network: 'calibration' })
    expect(config).toMatchObject({ privateKey: PK })
    expect(config).not.toHaveProperty('account')
    expect(getOwsAccount).not.toHaveBeenCalled()
  })

  it('resolves an OWS wallet into an account config without loading a private key', async () => {
    const config = await parseCLIAuth({ wallet: 'fil-test', network: 'calibration' })
    expect(getOwsAccount).toHaveBeenCalledTimes(1)
    expect(config).toHaveProperty('account')
    expect(config).not.toHaveProperty('privateKey')
  })

  it('resolves --view-address into read-only config', async () => {
    const config = await parseCLIAuth({ viewAddress: '0xabc', network: 'calibration' })
    expect(config).toMatchObject({ walletAddress: '0xabc', readOnly: true })
    expect(getOwsAccount).not.toHaveBeenCalled()
  })

  it('resolves wallet-address + session-key into session-key config', async () => {
    const config = await parseCLIAuth({ walletAddress: '0xowner', sessionKey: '0xsess', network: 'calibration' })
    expect(config).toMatchObject({ walletAddress: '0xowner', sessionKey: '0xsess' })
  })

  it('passes through a lone wallet-address so initializeSynapse can report "requires both"', async () => {
    const config = await parseCLIAuth({ walletAddress: '0xowner', network: 'calibration' })
    expect(config).toMatchObject({ walletAddress: '0xowner' })
    expect(config).not.toHaveProperty('sessionKey')
  })

  it('never resolves the OWS account for a non-signing mode', async () => {
    await parseCLIAuth({ viewAddress: '0xabc', wallet: 'ignored', network: 'calibration' }).catch(() => undefined)
    // (view + ows is a conflict; the point is the native adapter is not eagerly loaded)
    expect(getOwsAccount).not.toHaveBeenCalled()
  })
})

describe('parseCLIAuth - precedence: explicit flag beats env', () => {
  it('explicit --private-key wins over an env OWS wallet', async () => {
    const config = await parseCLIAuth(
      withSources(
        { privateKey: PK, wallet: 'env-wallet', network: 'calibration' },
        { privateKey: 'cli', wallet: 'env' }
      )
    )
    expect(config).toMatchObject({ privateKey: PK })
    expect(getOwsAccount).not.toHaveBeenCalled()
  })

  it('explicit --wallet wins over an env private key', async () => {
    const config = await parseCLIAuth(
      withSources(
        { privateKey: PK, wallet: 'cli-wallet', network: 'calibration' },
        { privateKey: 'env', wallet: 'cli' }
      )
    )
    expect(config).toHaveProperty('account')
    expect(config).not.toHaveProperty('privateKey')
  })

  // A lone explicit session-key half must not outrank a complete env-sourced
  // mode. Session-key competes only when BOTH halves are present.
  it('a lone explicit --wallet-address does not beat an env OWS wallet', async () => {
    const config = await parseCLIAuth(
      withSources(
        { walletAddress: '0xowner', wallet: 'env-wallet', network: 'calibration' },
        { walletAddress: 'cli', wallet: 'env' }
      )
    )
    expect(config).toHaveProperty('account')
    expect(config).not.toHaveProperty('walletAddress')
  })

  it('a lone explicit --session-key does not beat an env private key', async () => {
    const config = await parseCLIAuth(
      withSources(
        { sessionKey: '0xsess', privateKey: PK, network: 'calibration' },
        { sessionKey: 'cli', privateKey: 'env' }
      )
    )
    expect(config).toMatchObject({ privateKey: PK })
    expect(config).not.toHaveProperty('sessionKey')
  })

  it('a complete explicit session key still beats an env private key', async () => {
    const config = await parseCLIAuth(
      withSources(
        { walletAddress: '0xowner', sessionKey: '0xsess', privateKey: PK, network: 'calibration' },
        { walletAddress: 'cli', sessionKey: 'cli', privateKey: 'env' }
      )
    )
    expect(config).toMatchObject({ walletAddress: '0xowner', sessionKey: '0xsess' })
    expect(config).not.toHaveProperty('privateKey')
  })
})

describe('parseCLIAuth - precedence: conflicts', () => {
  it('errors when two modes are supplied by explicit flags', async () => {
    await expect(
      parseCLIAuth(
        withSources({ privateKey: PK, wallet: 'w', network: 'calibration' }, { privateKey: 'cli', wallet: 'cli' })
      )
    ).rejects.toThrow(/Conflicting authentication options/)
  })

  it('errors when two modes are supplied only by env, hinting to pass a flag', async () => {
    await expect(
      parseCLIAuth(
        withSources({ privateKey: PK, wallet: 'w', network: 'calibration' }, { privateKey: 'env', wallet: 'env' })
      )
    ).rejects.toThrow(/Pass an explicit flag to disambiguate/)
  })

  it('treats a programmatic caller (no sources) as all-explicit, so two modes conflict', async () => {
    await expect(parseCLIAuth({ privateKey: PK, wallet: 'w', network: 'calibration' })).rejects.toThrow(
      /Conflicting authentication options/
    )
  })

  it('reports conflicts in canonical order (read-only before private key)', async () => {
    await expect(
      parseCLIAuth(
        withSources(
          { viewAddress: '0xabc', privateKey: PK, network: 'calibration' },
          {
            viewAddress: 'env',
            privateKey: 'env',
          }
        )
      )
    ).rejects.toThrow(/--view-address\/VIEW_ADDRESS and --private-key\/PRIVATE_KEY/)
  })
})

describe('parseCLIAuth - OWS chain hint', () => {
  it('uses the network chain when --network is set', async () => {
    await parseCLIAuth({ wallet: 'fil-test', network: 'calibration' })
    const [opts] = getOwsAccount.mock.calls[0] as [{ chain: { id: number } }]
    expect(opts.chain.id).toBe(314159)
    expect(resolveChainFromRpc).not.toHaveBeenCalled()
  })

  it('probes the RPC endpoint for the chain when only --rpc-url is set', async () => {
    await parseCLIAuth({ wallet: 'fil-test', rpcUrl: 'https://example.invalid/rpc' })
    expect(resolveChainFromRpc).toHaveBeenCalledTimes(1)
    const [opts] = getOwsAccount.mock.calls[0] as [{ chain: { id: number } }]
    expect(opts.chain.id).toBe(314159)
  })

  it('defaults the chain hint to mainnet when neither network nor rpc-url is set', async () => {
    await parseCLIAuth({ wallet: 'fil-test' })
    const [opts] = getOwsAccount.mock.calls[0] as [{ chain: { id: number } }]
    expect(opts.chain.id).toBe(314)
    expect(resolveChainFromRpc).not.toHaveBeenCalled()
  })
})

describe('parseCLIAuth - OWS passphrase', () => {
  it('forwards a real passphrase', async () => {
    await parseCLIAuth({ wallet: 'fil-test', walletPassphrase: 'hunter2', network: 'calibration' })
    const [opts] = getOwsAccount.mock.calls[0] as [{ passphrase?: string }]
    expect(opts.passphrase).toBe('hunter2')
  })

  it('treats an empty passphrase as not provided', async () => {
    await parseCLIAuth({ wallet: 'fil-test', walletPassphrase: '', network: 'calibration' })
    const [opts] = getOwsAccount.mock.calls[0] as [{ passphrase?: string }]
    expect(opts).not.toHaveProperty('passphrase')
  })
})

describe('parseCLIAuth - devnet fallback', () => {
  it('uses the devnet key only when no auth mode is supplied', async () => {
    const config = await parseCLIAuth({ network: 'devnet' })
    expect(config).toMatchObject({ privateKey: '0xdevnetkey' })
    expect(resolveDevnetConfig).toHaveBeenCalled()
  })

  it('does not use the devnet key when an OWS wallet is supplied', async () => {
    const config = await parseCLIAuth({ network: 'devnet', wallet: 'fil-test' })
    expect(config).toHaveProperty('account')
    expect(config).not.toHaveProperty('privateKey')
  })
})

describe('addAuthOptions - source collection hook', () => {
  const ENV_KEYS = [
    'PRIVATE_KEY',
    'OWS_WALLET_ID',
    'OWS_WALLET_PASSPHRASE',
    'WALLET_ADDRESS',
    'SESSION_KEY',
    'VIEW_ADDRESS',
  ]
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = {}
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })

  async function captureSources(argv: string[]): Promise<AuthOptionSources> {
    let captured: AuthOptionSources = {}
    const command = new Command('add').exitOverride()
    command.action((options) => {
      captured = options.optionSources
    })
    addAuthOptions(command)
    await command.parseAsync(argv, { from: 'user' })
    return captured
  }

  it('marks an explicit flag as cli and an env var as env', async () => {
    process.env.OWS_WALLET_ID = 'env-wallet'
    const sources = await captureSources(['--private-key', PK])
    expect(sources.privateKey).toBe('cli')
    expect(sources.wallet).toBe('env')
  })

  it('omits options that were never supplied', async () => {
    const sources = await captureSources(['--wallet', 'w'])
    expect(sources.wallet).toBe('cli')
    expect(sources).not.toHaveProperty('privateKey')
    expect(sources).not.toHaveProperty('viewAddress')
  })
})
