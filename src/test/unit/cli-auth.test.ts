import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

describe('parseCLIAuth - single auth mode', () => {
  it('resolves a private key into a private-key config', async () => {
    const config = await parseCLIAuth({ privateKey: PK, network: 'calibration' })
    expect(config).toMatchObject({ privateKey: PK })
  })

  it('resolves --view-address into read-only config', async () => {
    const config = await parseCLIAuth({ viewAddress: '0xabc', network: 'calibration' })
    expect(config).toMatchObject({ walletAddress: '0xabc', readOnly: true })
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
})

describe('parseCLIAuth - precedence: explicit flag beats env', () => {
  it('explicit --private-key wins over an env view address', async () => {
    const config = await parseCLIAuth(
      withSources(
        { privateKey: PK, viewAddress: '0xabc', network: 'calibration' },
        { privateKey: 'cli', viewAddress: 'env' }
      )
    )
    expect(config).toMatchObject({ privateKey: PK })
    expect(config).not.toHaveProperty('readOnly')
  })

  it('explicit --view-address wins over an env private key', async () => {
    const config = await parseCLIAuth(
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
  it('a lone explicit --wallet-address does not beat an env private key', async () => {
    const config = await parseCLIAuth(
      withSources(
        { walletAddress: '0xowner', privateKey: PK, network: 'calibration' },
        { walletAddress: 'cli', privateKey: 'env' }
      )
    )
    expect(config).toMatchObject({ privateKey: PK })
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
        withSources(
          { privateKey: PK, viewAddress: '0xabc', network: 'calibration' },
          { privateKey: 'cli', viewAddress: 'cli' }
        )
      )
    ).rejects.toThrow(/Conflicting authentication options/)
  })

  it('errors when two modes are supplied only by env, hinting to pass a flag', async () => {
    await expect(
      parseCLIAuth(
        withSources(
          { privateKey: PK, viewAddress: '0xabc', network: 'calibration' },
          { privateKey: 'env', viewAddress: 'env' }
        )
      )
    ).rejects.toThrow(/Pass an explicit flag to disambiguate/)
  })

  it('treats a programmatic caller (no sources) as all-explicit, so two modes conflict', async () => {
    await expect(parseCLIAuth({ privateKey: PK, viewAddress: '0xabc', network: 'calibration' })).rejects.toThrow(
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

describe('parseCLIAuth - devnet fallback', () => {
  it('uses the devnet key only when no auth mode is supplied', async () => {
    const config = await parseCLIAuth({ network: 'devnet' })
    expect(config).toMatchObject({ privateKey: '0xdevnetkey' })
    expect(resolveDevnetConfig).toHaveBeenCalled()
  })

  it('does not use the devnet key when a session key is supplied', async () => {
    const config = await parseCLIAuth({ network: 'devnet', walletAddress: '0xowner', sessionKey: '0xsess' })
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
