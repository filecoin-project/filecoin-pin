import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../utils/cli-logger.js', () => ({
  isTTY: vi.fn(() => true),
  log: { warn: vi.fn(), line: vi.fn(), flush: vi.fn(), indent: vi.fn() },
}))

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
import { log } from '../../utils/cli-logger.js'
import { addAuthOptions } from '../../utils/cli-options.js'

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

/** Build options with an explicit source map so precedence is deterministic. */
function withSources(base: CLIAuthOptions, sources: AuthOptionSources): CLIAuthOptions {
  return { ...base, optionSources: sources }
}

describe('parseCLIAuth - single auth mode', () => {
  it('resolves a private key into a private-key config', () => {
    const config = parseCLIAuth({ privateKey: PK, network: 'calibration' })
    expect(config).toMatchObject({ privateKey: PK })
  })

  it('resolves --view-address into read-only config', () => {
    const config = parseCLIAuth({ viewAddress: '0xabc', network: 'calibration' })
    expect(config).toMatchObject({ walletAddress: '0xabc', readOnly: true })
  })

  it('resolves wallet-address + session-key into session-key config', () => {
    const config = parseCLIAuth({ walletAddress: '0xowner', sessionKey: '0xsess', network: 'calibration' })
    expect(config).toMatchObject({ walletAddress: '0xowner', sessionKey: '0xsess' })
  })

  it('passes through a lone wallet-address so initializeSynapse can report "requires both"', () => {
    const config = parseCLIAuth({ walletAddress: '0xowner', network: 'calibration' })
    expect(config).toMatchObject({ walletAddress: '0xowner' })
    expect(config).not.toHaveProperty('sessionKey')
  })
})

describe('parseCLIAuth - precedence: explicit flag beats env', () => {
  it('explicit --private-key wins over an env view address', () => {
    const config = parseCLIAuth(
      withSources(
        { privateKey: PK, viewAddress: '0xabc', network: 'calibration' },
        { privateKey: 'cli', viewAddress: 'env' }
      )
    )
    expect(config).toMatchObject({ privateKey: PK })
    expect(config).not.toHaveProperty('readOnly')
  })

  it('explicit --view-address wins over an env private key', () => {
    const config = parseCLIAuth(
      withSources(
        { privateKey: PK, viewAddress: '0xabc', network: 'calibration' },
        { privateKey: 'env', viewAddress: 'cli' }
      )
    )
    expect(config).toMatchObject({ walletAddress: '0xabc', readOnly: true })
    expect(config).not.toHaveProperty('privateKey')
  })

  // A lone explicit session-key half must not outrank a complete env-sourced
  // mode. Session-key competes only when BOTH halves are present.
  it('a lone explicit --wallet-address does not beat an env private key', () => {
    const config = parseCLIAuth(
      withSources(
        { walletAddress: '0xowner', privateKey: PK, network: 'calibration' },
        { walletAddress: 'cli', privateKey: 'env' }
      )
    )
    expect(config).toMatchObject({ privateKey: PK })
    expect(config).not.toHaveProperty('walletAddress')
  })

  it('a lone explicit --session-key does not beat an env private key', () => {
    const config = parseCLIAuth(
      withSources(
        { sessionKey: '0xsess', privateKey: PK, network: 'calibration' },
        { sessionKey: 'cli', privateKey: 'env' }
      )
    )
    expect(config).toMatchObject({ privateKey: PK })
    expect(config).not.toHaveProperty('sessionKey')
  })

  it('a complete explicit session key still beats an env private key', () => {
    const config = parseCLIAuth(
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
  beforeEach(() => {
    vi.mocked(log.warn).mockClear()
  })

  it('errors when two modes are supplied by explicit flags', () => {
    expect(() =>
      parseCLIAuth(
        withSources(
          { privateKey: PK, viewAddress: '0xabc', network: 'calibration' },
          { privateKey: 'cli', viewAddress: 'cli' }
        )
      )
    ).toThrow(/Conflicting authentication options/)
  })

  it('breaks an env-only tie by canonical order and warns about the ignored mode', () => {
    const config = parseCLIAuth(
      withSources(
        { privateKey: PK, viewAddress: '0xabc', network: 'calibration' },
        { privateKey: 'env', viewAddress: 'env' }
      )
    )
    expect(config).toMatchObject({ walletAddress: '0xabc', readOnly: true })
    expect(config).not.toHaveProperty('privateKey')
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/ignoring --private-key\/PRIVATE_KEY/))
  })

  it('keeps a shell that exports PRIVATE_KEY alongside session-key credentials working', () => {
    const config = parseCLIAuth(
      withSources(
        { privateKey: PK, walletAddress: '0xowner', sessionKey: '0xsess', network: 'calibration' },
        { privateKey: 'env', walletAddress: 'env', sessionKey: 'env' }
      )
    )
    expect(config).toMatchObject({ walletAddress: '0xowner', sessionKey: '0xsess' })
    expect(config).not.toHaveProperty('privateKey')
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/ignoring --private-key\/PRIVATE_KEY/))
  })

  it('does not warn when a single env-sourced mode is supplied', () => {
    parseCLIAuth(withSources({ privateKey: PK, network: 'calibration' }, { privateKey: 'env' }))
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('treats a programmatic caller (no sources) as all-explicit, so two modes conflict', () => {
    expect(() => parseCLIAuth({ privateKey: PK, viewAddress: '0xabc', network: 'calibration' })).toThrow(
      /Conflicting authentication options/
    )
  })

  it('reports explicit conflicts in canonical order (read-only before private key)', () => {
    expect(() =>
      parseCLIAuth(
        withSources(
          { viewAddress: '0xabc', privateKey: PK, network: 'calibration' },
          {
            viewAddress: 'cli',
            privateKey: 'cli',
          }
        )
      )
    ).toThrow(/--view-address\/VIEW_ADDRESS and --private-key\/PRIVATE_KEY/)
  })
})

describe('parseCLIAuth - devnet fallback', () => {
  it('uses the devnet key only when no auth mode is supplied', () => {
    const config = parseCLIAuth({ network: 'devnet' })
    expect(config).toMatchObject({ privateKey: '0xdevnetkey' })
    expect(resolveDevnetConfig).toHaveBeenCalled()
  })

  it('does not use the devnet key when a session key is supplied', () => {
    const config = parseCLIAuth({ network: 'devnet', walletAddress: '0xowner', sessionKey: '0xsess' })
    expect(config).toMatchObject({ walletAddress: '0xowner', sessionKey: '0xsess' })
    expect(config).not.toHaveProperty('privateKey')
  })
})

describe('addAuthOptions - source collection hook', () => {
  const ENV_KEYS = ['PRIVATE_KEY', 'WALLET_ADDRESS', 'SESSION_KEY', 'VIEW_ADDRESS']
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
    process.env.VIEW_ADDRESS = '0xenv'
    const sources = await captureSources(['--private-key', PK])
    expect(sources.privateKey).toBe('cli')
    expect(sources.viewAddress).toBe('env')
  })

  it('omits options that were never supplied', async () => {
    const sources = await captureSources(['--session-key', '0xsess'])
    expect(sources.sessionKey).toBe('cli')
    expect(sources).not.toHaveProperty('privateKey')
    expect(sources).not.toHaveProperty('viewAddress')
  })
})
