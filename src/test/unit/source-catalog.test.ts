import { readFile } from 'node:fs/promises'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  fetchSquidCatalog,
  isTrustedSquidRouteAddress,
  matchesRequestedSourceSelectors,
  NATIVE_TOKEN_SELECTOR,
  parseSquidCatalog,
  resolveCatalogSource,
  SELECTED_SOURCE_CHAINS,
  verifyResolvedErc20Source,
} from '../../core/payments/acquisition/source-catalog.js'

const FIXTURES = new URL('../fixtures/payments-acquisition/', import.meta.url)
let fixture: { chains: unknown[]; tokens: Array<{ decimals: number }> }

describe('Squid selected-source catalog contract', () => {
  beforeAll(async () => {
    fixture = JSON.parse(
      await readFile(new URL('squid-selected-source-catalog.json', FIXTURES), 'utf8')
    ) as typeof fixture
  })

  it('resolves a unique Base token using the catalog decimal and safe display identity', () => {
    const token = resolveCatalogSource(parseSquidCatalog(fixture.chains, fixture.tokens), 'base', 'usdbc')
    expect(token).toMatchObject({
      chain: { chainId: 8453 },
      token: '0xd9aa3214bcb81c9bd4b8c7a9e20f3c2f6fbe1b0c',
      decimals: 6,
    })
    expect(token.display).toContain(token.token)
  })

  it('keeps exactly the selected eight chains, their stable aliases, and representative tokens', () => {
    expect(SELECTED_SOURCE_CHAINS.map((chain) => [chain.cliName, chain.chainId])).toEqual([
      ['filecoin', 314],
      ['arbitrum', 42161],
      ['ethereum', 1],
      ['base', 8453],
      ['optimism', 10],
      ['polygon', 137],
      ['avalanche', 43114],
      ['bnb', 56],
    ])
    const catalog = parseSquidCatalog(fixture.chains, fixture.tokens)
    const representatives: Array<[string, string, string, number]> = [
      ['filecoin', 'filecoin', 'FILX', 2],
      ['arbitrum', 'arb', 'ARBX', 9],
      ['ethereum', 'eth', 'ETHX', 8],
      ['base', 'base', 'USDbC', 6],
      ['optimism', 'op', 'OPX', 7],
      ['polygon', 'matic', 'POLX', 5],
      ['avalanche', 'avax', 'AVAXX', 4],
      ['bnb', 'bsc', 'BNBX', 3],
    ]
    for (const [chain, alias, symbol, decimals] of representatives) {
      expect(resolveCatalogSource(catalog, alias, symbol)).toMatchObject({ chain: { cliName: chain }, decimals })
    }
  })

  it('rejects duplicate symbols but exact address disambiguates them', () => {
    const catalog = parseSquidCatalog(fixture.chains, fixture.tokens)
    expect(() => resolveCatalogSource(catalog, 'base', 'USD')).toThrow('ambiguous')
    expect(resolveCatalogSource(catalog, 'base', '0x2222222222222222222222222222222222222222').decimals).toBe(18)
  })

  it('uses an explicit native selector and preserves the native marker', () => {
    expect(
      resolveCatalogSource(parseSquidCatalog(fixture.chains, fixture.tokens), 'base', NATIVE_TOKEN_SELECTOR)
    ).toMatchObject({
      native: true,
      decimals: 18,
    })
  })

  it('matches ready-retry selectors only against the stored catalog-verified identity', () => {
    const catalog = parseSquidCatalog(fixture.chains, fixture.tokens)
    const usdbc = resolveCatalogSource(catalog, 'base', 'usdbc')
    const native = resolveCatalogSource(catalog, 'base', NATIVE_TOKEN_SELECTOR)

    expect(matchesRequestedSourceSelectors(usdbc, ' BASE ', 'USDBC')).toBe(true)
    expect(matchesRequestedSourceSelectors(usdbc, 'base', `0x${usdbc.token.slice(2).toUpperCase()}`)).toBe(true)
    expect(matchesRequestedSourceSelectors(native, 'base', 'NATIVE')).toBe(true)
    expect(matchesRequestedSourceSelectors(native, 'base', 'eth')).toBe(true)

    expect(matchesRequestedSourceSelectors(usdbc, 'arb', 'USDBC')).toBe(false)
    expect(matchesRequestedSourceSelectors(usdbc, 'base', 'native')).toBe(false)
    expect(matchesRequestedSourceSelectors(usdbc, 'base', '0x0000000000000000000000000000000000000001')).toBe(false)
    expect(matchesRequestedSourceSelectors(usdbc, 'base', 'USDC')).toBe(false)
    expect(matchesRequestedSourceSelectors(usdbc, 'solana', 'USDBC')).toBe(false)
    expect(matchesRequestedSourceSelectors(usdbc, undefined, 'USDBC')).toBe(false)
    expect(matchesRequestedSourceSelectors(usdbc, 'base', undefined)).toBe(false)
  })

  it('rejects native tokens that conflict with selected-chain native-currency metadata', () => {
    const mismatchedChains = fixture.chains.map((chain, index) =>
      index === 3 ? { ...(chain as object), nativeCurrency: { symbol: 'WETH', decimals: 18 } } : chain
    )
    expect(() => parseSquidCatalog(mismatchedChains, fixture.tokens)).toThrow('native currency conflicts')
    const malformedChains = fixture.chains.map((chain, index) =>
      index === 3 ? { ...(chain as object), nativeCurrency: { symbol: 'ETH', decimals: 1.5 } } : chain
    )
    expect(() => parseSquidCatalog(malformedChains, fixture.tokens)).toThrow('invalid native decimals')
    const mutuallyWrongChains = fixture.chains.map((chain, index) =>
      index === 3 ? { ...(chain as object), nativeCurrency: { symbol: 'WETH', decimals: 17 } } : chain
    )
    const mutuallyWrongTokens = fixture.tokens.map((token, index) =>
      index === 3 ? { ...token, symbol: 'WETH', decimals: 17 } : token
    )
    expect(() => parseSquidCatalog(mutuallyWrongChains, mutuallyWrongTokens)).toThrow('native currency conflicts')
    const wrongNativeToken = fixture.tokens.map((token, index) =>
      index === 3 ? { ...token, symbol: 'WETH', decimals: 17 } : token
    )
    expect(() => parseSquidCatalog(fixture.chains, wrongNativeToken)).toThrow('native token metadata conflicts')
  })

  it('canonicalizes byte-identical token duplicates but rejects conflicting canonical identities', () => {
    const identical = fixture.tokens[8]
    const catalog = parseSquidCatalog(fixture.chains, [...fixture.tokens, identical])
    expect(catalog.tokens.filter((token) => token.token === '0xd9aa3214bcb81c9bd4b8c7a9e20f3c2f6fbe1b0c')).toHaveLength(
      1
    )
    expect(() => parseSquidCatalog(fixture.chains, [...fixture.tokens, { ...identical, decimals: 18 }])).toThrow(
      'duplicated with conflicting metadata'
    )
  })

  it('fails closed for unsupported chains, non-EVM selected chains, and malformed catalog fields', () => {
    expect(() => resolveCatalogSource(parseSquidCatalog(fixture.chains, fixture.tokens), 'solana', 'USDC')).toThrow(
      'Unsupported'
    )
    expect(() => parseSquidCatalog([{ chainId: '8453', networkName: 'Base', type: 'cosmos' }], [])).toThrow(
      'must be EVM'
    )
    expect(() => parseSquidCatalog(fixture.chains, [{ ...fixture.tokens[0], decimals: 1.5 }])).toThrow(
      'invalid decimals'
    )
    expect(() => parseSquidCatalog([{ chainId: 'not-a-chain' }, ...fixture.chains], fixture.tokens)).not.toThrow()
  })

  it('bounds catalog requests to two endpoints and propagates an abort timeout', async () => {
    const fetchFn = vi.fn<typeof fetch>(
      async (_url, init) =>
        await new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        )
    )
    await expect(fetchSquidCatalog({ integratorId: 'test', fetchFn, timeoutMs: 1 })).rejects.toThrow('timed out')
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('aborts the peer request after a catalog failure without relabeling it as a timeout', async () => {
    let peerAborted = false
    const originalFailure = new Error('catalog unavailable')
    const fetchFn = vi.fn<typeof fetch>((url, init) => {
      if (url.toString().endsWith('/chains')) return Promise.reject(originalFailure)
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => {
          peerAborted = init.signal?.aborted === true
          reject(new DOMException('aborted', 'AbortError'))
        })
      )
    })
    await expect(fetchSquidCatalog({ integratorId: 'test', fetchFn, timeoutMs: 1_000 })).rejects.toBe(originalFailure)
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(peerAborted).toBe(true)
  })

  it('aborts a pending peer immediately when an endpoint returns a non-OK response', async () => {
    let peerAborted = false
    const fetchFn = vi.fn<typeof fetch>((url, init) => {
      if (url.toString().endsWith('/chains')) return Promise.resolve(new Response('unavailable', { status: 503 }))
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => {
          peerAborted = init.signal?.aborted === true
          reject(new DOMException('aborted', 'AbortError'))
        })
      )
    })
    await expect(fetchSquidCatalog({ integratorId: 'test', fetchFn, timeoutMs: 1_000 })).rejects.toThrow(
      'Squid catalog request failed (503)'
    )
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(peerAborted).toBe(true)
  })

  it('unwraps the current catalog response shape and rejects missing wrappers', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ chains: fixture.chains })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ tokens: fixture.tokens })))
    await expect(fetchSquidCatalog({ integratorId: 'test', fetchFn })).resolves.toMatchObject({
      tokens: expect.arrayContaining([expect.objectContaining({ symbol: 'USDbC', decimals: 6 })]),
    })
    const malformedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ chainz: fixture.chains })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ tokens: fixture.tokens })))
    await expect(fetchSquidCatalog({ integratorId: 'test', fetchFn: malformedFetch })).rejects.toThrow(
      'chains response must contain chains array'
    )
    const missingTokens = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ chains: fixture.chains })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ tokenz: fixture.tokens })))
    await expect(fetchSquidCatalog({ integratorId: 'test', fetchFn: missingTokens })).rejects.toThrow(
      'tokens response must contain tokens array'
    )
  })

  it('keeps target and spender authorization explicit and fail-closed', () => {
    expect(isTrustedSquidRouteAddress(8453, '0xce16F69375520ab01377ce7B88f5BA8C48F8D666', 'target')).toBe(true)
    expect(isTrustedSquidRouteAddress(8453, '0x1111111111111111111111111111111111111111', 'spender')).toBe(false)
  })

  it('verifies ERC-20 code and catalog identity only when an acquisition caller supplies an RPC client', async () => {
    const source = resolveCatalogSource(parseSquidCatalog(fixture.chains, fixture.tokens), 'base', 'USDbC')
    const client = {
      getChainId: vi.fn().mockResolvedValue(8453),
      getCode: vi.fn().mockResolvedValue('0x6000'),
      readContract: vi.fn().mockResolvedValueOnce(6).mockResolvedValueOnce('USDbC'),
    }
    await expect(verifyResolvedErc20Source(client as never, source)).resolves.toBe(source)
    await expect(
      verifyResolvedErc20Source({ ...client, getCode: vi.fn().mockResolvedValue('0x') } as never, source)
    ).rejects.toThrow('no contract code')
  })

  it('rejects wrong-chain RPC clients before source verification, including native sources', async () => {
    const catalog = parseSquidCatalog(fixture.chains, fixture.tokens)
    const erc20 = resolveCatalogSource(catalog, 'base', 'USDbC')
    const wrongErc20Client = {
      getChainId: vi.fn().mockResolvedValue(1),
      getCode: vi.fn(),
      readContract: vi.fn(),
    }
    await expect(verifyResolvedErc20Source(wrongErc20Client as never, erc20)).rejects.toThrow(
      'Source RPC chain ID 1 does not match selected source chain ID 8453'
    )
    expect(wrongErc20Client.getCode).not.toHaveBeenCalled()
    const native = resolveCatalogSource(catalog, 'base', NATIVE_TOKEN_SELECTOR)
    const wrongNativeClient = {
      getChainId: vi.fn().mockResolvedValue(1),
      getCode: vi.fn(),
      readContract: vi.fn(),
    }
    await expect(verifyResolvedErc20Source(wrongNativeClient as never, native)).rejects.toThrow(
      'Source RPC chain ID 1 does not match selected source chain ID 8453'
    )
    expect(wrongNativeClient.getCode).not.toHaveBeenCalled()
  })

  it('verifies the selected chain for native sources without contract reads', async () => {
    const native = resolveCatalogSource(
      parseSquidCatalog(fixture.chains, fixture.tokens),
      'base',
      NATIVE_TOKEN_SELECTOR
    )
    const client = {
      getChainId: vi.fn().mockResolvedValue(8453),
      getCode: vi.fn(),
      readContract: vi.fn(),
    }
    await expect(verifyResolvedErc20Source(client as never, native)).resolves.toBe(native)
    expect(client.getChainId).toHaveBeenCalledTimes(1)
    expect(client.getCode).not.toHaveBeenCalled()
    expect(client.readContract).not.toHaveBeenCalled()
  })

  it('keeps setup auto source resolution behind the wallet-shortfall boundary', async () => {
    const [fund, auto] = await Promise.all([
      readFile(new URL('../../payments/fund.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../payments/auto.ts', import.meta.url), 'utf8'),
    ])
    expect(auto).toContain('source-catalog')
    expect(auto).toContain('fetchSquidCatalog')
    expect(auto).toContain('only after the existing setup flow finds a wallet shortfall')
    expect(fund).toContain('fetchSquidCatalog')
  })
})
