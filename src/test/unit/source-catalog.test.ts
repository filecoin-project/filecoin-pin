import { readFile } from 'node:fs/promises'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  fetchSquidCatalog,
  isTrustedSquidRouteAddress,
  NATIVE_TOKEN_SELECTOR,
  parseSquidCatalog,
  resolveCatalogSource,
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
      getCode: vi.fn().mockResolvedValue('0x6000'),
      readContract: vi.fn().mockResolvedValueOnce(6).mockResolvedValueOnce('USDbC'),
    }
    await expect(verifyResolvedErc20Source(client as never, source)).resolves.toBe(source)
    await expect(
      verifyResolvedErc20Source({ ...client, getCode: vi.fn().mockResolvedValue('0x') } as never, source)
    ).rejects.toThrow('no contract code')
  })
})
