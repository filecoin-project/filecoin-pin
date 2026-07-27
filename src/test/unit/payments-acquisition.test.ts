import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { calibration } from '@filoz/synapse-sdk'
import type { PublicClient } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import {
  type AcquisitionCheckpoint,
  type AcquisitionCheckpointStore,
  acquireAcquisitionLock,
  createAcquisitionCheckpointStore,
} from '../../core/payments/acquisition/checkpoint.js'
import {
  assertArbitrumSourceChain,
  assertFixedInputRefresh,
  executeTokenAcquisition,
  isWithinCumulativeSourceGasCap,
  MAX_SOURCE_NATIVE_GAS,
  sourceAddressForPrivateKey,
  waitForFilecoinWalletReadiness,
} from '../../core/payments/acquisition/execute.js'
import {
  ensureWalletReadyForFilecoinTransactions,
  type SourceAcquisitionConfirmation,
} from '../../core/payments/acquisition/orchestrate.js'
import {
  parseMaximumSourceAmount,
  planTokenAcquisition,
  refreshFixedInputAcquisitionQuote,
  validateMaximumSourceSpend,
} from '../../core/payments/acquisition/plan.js'
import {
  FILECOIN_NATIVE_TOKEN,
  FILECOIN_USDFC,
  resolveSourceToken,
} from '../../core/payments/acquisition/source-assets.js'
import { type ResolvedSourceToken, SELECTED_SOURCE_CHAINS } from '../../core/payments/acquisition/source-catalog.js'
import { sourceNativeGasCeiling, sourceRouteIdentity } from '../../core/payments/acquisition/source-execution.js'
import {
  getSquidRoute,
  mapSquidStatus,
  pollSquidStatus,
  waitForSquidTerminalStatus,
} from '../../core/payments/acquisition/squid.js'
import type {
  AcquisitionEvidence,
  AcquisitionLeg,
  PlannedAcquisitionQuote,
} from '../../core/payments/acquisition/types.js'
import { MIN_FIL_FOR_GAS } from '../../core/payments/constants.js'
import { planWalletFunding } from '../../core/payments/wallet-funding.js'

const OWNER = '0x000000000000000000000000000000000000F00D' as const
const PRIVATE_KEY = '0x0000000000000000000000000000000000000000000000000000000000000001' as const
const SOURCE_OWNER = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf' as const
const FIXTURES = new URL('../fixtures/payments-acquisition/', import.meta.url)

async function routeFixture(name: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(new URL(name, FIXTURES), 'utf8')) as Record<string, any>
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function setFixtureSourceAmount(fixture: Record<string, any>, sourceAmount: bigint): void {
  fixture.route.params.fromAmount = sourceAmount.toString()
  fixture.route.estimate.fromAmount = sourceAmount.toString()
}

function supportedSource() {
  const source = resolveSourceToken('arb', 'USDC')
  if (source == null) throw new Error('test source missing from allowlist')
  return source
}

function resolvedArbitrumSource(): ResolvedSourceToken {
  const source = supportedSource()
  const chain = SELECTED_SOURCE_CHAINS.find((candidate) => candidate.chainId === source.chainId)
  if (chain == null) throw new Error('Arbitrum source chain missing from catalog')
  if (source.decimals == null) throw new Error('Arbitrum source decimals missing')
  return {
    chain,
    chainId: source.chainId,
    token: source.token as `0x${string}`,
    symbol: source.symbol,
    decimals: source.decimals,
    native: false,
    display: 'Arbitrum USDC',
  }
}

function checkpointStore(
  initial: AcquisitionCheckpoint
): AcquisitionCheckpointStore & { value: AcquisitionCheckpoint | undefined } {
  const store: AcquisitionCheckpointStore & { value: AcquisitionCheckpoint | undefined } = {
    value: initial,
    load: vi.fn(async () => store.value),
    save: vi.fn(async (checkpoint) => {
      store.value = checkpoint
    }),
    clear: vi.fn(async () => {
      store.value = undefined
    }),
  }
  return store
}

function emptyCheckpointStore(): AcquisitionCheckpointStore & { value: AcquisitionCheckpoint | undefined } {
  const store: AcquisitionCheckpointStore & { value: AcquisitionCheckpoint | undefined } = {
    value: undefined,
    load: vi.fn(async () => store.value),
    save: vi.fn(async (checkpoint) => {
      store.value = checkpoint
    }),
    clear: vi.fn(async () => {
      store.value = undefined
    }),
  }
  return store
}

function executionQuote(): PlannedAcquisitionQuote {
  return {
    id: 'execution-route',
    asset: 'usdfc',
    sourceAmount: 1n,
    destinationAmount: 2n,
    target: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
    data: '0x12',
    value: 2n,
    gasLimit: 3n,
    maxFeePerGas: 5n,
    expiresAt: 2_000_000_000,
    estimatedRouteDurationSeconds: 0,
    sourceOwner: SOURCE_OWNER,
    destinationAddress: SOURCE_OWNER,
  }
}

function sourceClientForExecution(allowance: () => bigint): PublicClient {
  return {
    getChainId: vi.fn().mockResolvedValue(42161),
    getBalance: vi.fn().mockResolvedValue(1_000n),
    getGasPrice: vi.fn().mockResolvedValue(5n),
    getTransactionCount: vi.fn().mockResolvedValue(8),
    estimateContractGas: vi.fn().mockResolvedValue(3n),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
      functionName === 'balanceOf' ? 100n : allowance()
    ),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
  } as unknown as PublicClient
}

function withResolvedErc20Identity(source: ResolvedSourceToken, client: PublicClient): PublicClient {
  const readContract = client.readContract
  return {
    ...client,
    getCode: vi.fn().mockResolvedValue('0x01'),
    readContract: vi.fn(async (request: { functionName: string }) => {
      if (request.functionName === 'decimals') return source.decimals
      if (request.functionName === 'symbol') return source.symbol
      return readContract(request as never)
    }),
  } as unknown as PublicClient
}

describe('Squid acquisition provider contract', () => {
  it('uses the sanitised fixture only with the approved owner, assets, router, and credential header', async () => {
    const fixture = await routeFixture('squid-route-usdfc.json')
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(fixture))
    const source = supportedSource()
    const leg: AcquisitionLeg = { asset: 'usdfc', amount: 1n, source }

    const quote = await getSquidRoute(
      { fromAddress: OWNER, sourceAmount: 5_000_000n, leg, slippage: 1 },
      { integratorId: 'test-only-integrator', fetchFn, now: () => 1_700_000_000_000 }
    )

    expect(quote.target.toLowerCase()).toBe('0xce16f69375520ab01377ce7b88f5ba8c48f8d666')
    expect(quote.destinationAmount).toBe(4_894_083_014_213_259_056n)
    expect(fetchFn.mock.calls[0]?.[1]?.headers).toMatchObject({ 'x-integrator-id': 'test-only-integrator' })
    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toMatchObject({
      fromAddress: OWNER,
      toAddress: OWNER,
      toToken: FILECOIN_USDFC,
      quoteOnly: false,
    })
  })

  it('fails closed when a route changes its approved target', async () => {
    const fixture = await routeFixture('squid-route-fil.json')
    fixture.route.transactionRequest.target = '0x0000000000000000000000000000000000000001'
    const source = supportedSource()
    await expect(
      getSquidRoute(
        { fromAddress: OWNER, sourceAmount: 500_000n, leg: { asset: 'fil', amount: 1n, source }, slippage: 1 },
        { integratorId: 'test-only-integrator', fetchFn: vi.fn<typeof fetch>().mockResolvedValue(response(fixture)) }
      )
    ).rejects.toThrow('approved-target')
  })

  it('rejects invalid resolved source decimals before requesting a route', async () => {
    const fetchFn = vi.fn<typeof fetch>()
    const source = { ...supportedSource(), decimals: 256 }

    await expect(
      getSquidRoute(
        { fromAddress: OWNER, sourceAmount: 1n, leg: { asset: 'fil', amount: 1n, source }, slippage: 1 },
        { integratorId: 'test-only-integrator', fetchFn }
      )
    ).rejects.toThrow('invalid decimals')

    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('fails closed when the provider params do not retain the fixed source amount', async () => {
    const fixture = await routeFixture('squid-route-fil.json')
    fixture.route.params.fromAmount = '1'
    await expect(
      getSquidRoute(
        {
          fromAddress: OWNER,
          sourceAmount: 5_000_000n,
          leg: { asset: 'fil', amount: 1n, source: supportedSource() },
          slippage: 1,
        },
        { integratorId: 'test-only-integrator', fetchFn: vi.fn<typeof fetch>().mockResolvedValue(response(fixture)) }
      )
    ).rejects.toThrow('approved-asset')
  })

  it('aborts both hanging route and status requests at the configured per-request timeout', async () => {
    vi.useFakeTimers()
    const abortingFetch = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )
    try {
      const route = getSquidRoute(
        {
          fromAddress: OWNER,
          sourceAmount: 1n,
          leg: { asset: 'fil', amount: 1n, source: supportedSource() },
          slippage: 1,
        },
        { integratorId: 'test-only-integrator', fetchFn: abortingFetch, requestTimeoutMs: 1 }
      )
      const routeTimeout = expect(route).rejects.toThrow('timed out')
      await vi.advanceTimersByTimeAsync(1)
      await routeTimeout

      const status = pollSquidStatus(
        { transactionId: 'source', fromChainId: '42161', toChainId: '314', quoteId: 'quote' },
        { integratorId: 'test-only-integrator', fetchFn: abortingFetch, requestTimeoutMs: 1 }
      )
      const statusTimeout = expect(status).rejects.toThrow('timed out')
      await vi.advanceTimersByTimeAsync(1)
      await statusTimeout
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts route and status JSON body stalls at the configured per-request timeout', async () => {
    vi.useFakeTimers()
    const stalledResponse = {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => new Promise(() => undefined),
    } as unknown as Response
    try {
      const route = getSquidRoute(
        {
          fromAddress: OWNER,
          sourceAmount: 1n,
          leg: { asset: 'fil', amount: 1n, source: supportedSource() },
          slippage: 1,
        },
        {
          integratorId: 'test-only-integrator',
          fetchFn: vi.fn<typeof fetch>().mockResolvedValue(stalledResponse),
          requestTimeoutMs: 1,
        }
      )
      const routeTimeout = expect(route).rejects.toThrow('timed out')
      await vi.advanceTimersByTimeAsync(1)
      await routeTimeout

      const status = pollSquidStatus(
        { transactionId: 'source', fromChainId: '42161', toChainId: '314', quoteId: 'quote' },
        {
          integratorId: 'test-only-integrator',
          fetchFn: vi.fn<typeof fetch>().mockResolvedValue(stalledResponse),
          requestTimeoutMs: 1,
        }
      )
      const statusTimeout = expect(status).rejects.toThrow('timed out')
      await vi.advanceTimersByTimeAsync(1)
      await statusTimeout
    } finally {
      vi.useRealTimers()
    }
  })

  it('accepts equivalent mixed-case EVM addresses in provider route parameters', async () => {
    const fixture = await routeFixture('squid-route-usdfc.json')
    const params = fixture.route.params
    params.fromToken = `0x${String(params.fromToken).slice(2).toUpperCase()}`
    params.toToken = `0x${String(params.toToken).slice(2).toUpperCase()}`
    params.fromAddress = OWNER.toLowerCase()
    params.toAddress = OWNER.toLowerCase()

    await expect(
      getSquidRoute(
        {
          fromAddress: OWNER,
          sourceAmount: 5_000_000n,
          leg: { asset: 'usdfc', amount: 1n, source: supportedSource() },
          slippage: 1,
        },
        {
          integratorId: 'test-only-integrator',
          fetchFn: vi.fn<typeof fetch>().mockResolvedValue(response(fixture)),
          now: () => 1_700_000_000_000,
        }
      )
    ).resolves.toMatchObject({ asset: 'usdfc' })
  })

  it.each([
    ['an invalid wallet address', 'fromAddress', '0x1234'],
    ['a valid but wrong destination token', 'toToken', '0x0000000000000000000000000000000000000001'],
  ])('fails closed for %s in provider route parameters', async (_description, field, value) => {
    const fixture = await routeFixture('squid-route-usdfc.json')
    fixture.route.params[field] = value

    await expect(
      getSquidRoute(
        {
          fromAddress: OWNER,
          sourceAmount: 5_000_000n,
          leg: { asset: 'usdfc', amount: 1n, source: supportedSource() },
          slippage: 1,
        },
        {
          integratorId: 'test-only-integrator',
          fetchFn: vi.fn<typeof fetch>().mockResolvedValue(response(fixture)),
          now: () => 1_700_000_000_000,
        }
      )
    ).rejects.toThrow('approved-asset')
  })

  it('retries one bounded rate-limit response without widening the request contract', async () => {
    const fixture = await routeFixture('squid-route-fil.json')
    setFixtureSourceAmount(fixture, 500_000n)
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(response(fixture))
    await expect(
      getSquidRoute(
        {
          fromAddress: OWNER,
          sourceAmount: 500_000n,
          leg: { asset: 'fil', amount: 1n, source: supportedSource() },
          slippage: 1,
        },
        { integratorId: 'test-only-integrator', fetchFn, now: () => 1_700_000_000_000 }
      )
    ).resolves.toMatchObject({ asset: 'fil' })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('rejects expired routes before any source signature', async () => {
    const fixture = await routeFixture('squid-route-fil.json')
    setFixtureSourceAmount(fixture, 500_000n)
    await expect(
      getSquidRoute(
        {
          fromAddress: OWNER,
          sourceAmount: 500_000n,
          leg: { asset: 'fil', amount: 1n, source: supportedSource() },
          slippage: 1,
        },
        {
          integratorId: 'test-only-integrator',
          fetchFn: vi.fn<typeof fetch>().mockResolvedValue(response(fixture)),
          now: () => 2_000_000_000_000,
        }
      )
    ).rejects.toThrow('expired')
  })

  it('retains the provider request header when the route omits a legacy request id', async () => {
    const fixture = await routeFixture('squid-route-fil.json')
    setFixtureSourceAmount(fixture, 500_000n)
    delete fixture.route.transactionRequest.requestId
    const quote = await getSquidRoute(
      {
        fromAddress: OWNER,
        sourceAmount: 500_000n,
        leg: { asset: 'fil', amount: 1n, source: supportedSource() },
        slippage: 1,
      },
      {
        integratorId: 'test-only-integrator',
        fetchFn: vi.fn<typeof fetch>().mockResolvedValue(
          new Response(JSON.stringify(fixture), {
            headers: { 'content-type': 'application/json', 'x-request-id': 'header-id' },
          })
        ),
        now: () => 1_700_000_000_000,
      }
    )

    expect(quote.requestId).toBe('header-id')
  })

  it('maps provider terminal and unresolved statuses without treating an unresolved route as success', () => {
    expect(mapSquidStatus('success')).toEqual({ status: 'confirmed' })
    expect(mapSquidStatus('partial_success')).toMatchObject({ status: 'partial', errorCode: 'partial-success' })
    expect(mapSquidStatus('needs_gas')).toMatchObject({ status: 'failed', errorCode: 'insufficient-source-gas' })
    expect(mapSquidStatus('ongoing')).toMatchObject({ status: 'submitted', errorCode: 'timed-out' })
    expect(mapSquidStatus('not_found')).toMatchObject({ status: 'submitted' })
    expect(mapSquidStatus('refund')).toMatchObject({ status: 'refunded' })
    expect(mapSquidStatus('unexpected')).toMatchObject({ status: 'failed' })
  })

  it('uses all required route-status identifiers and retains safe source and destination evidence', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        squidTransactionStatus: 'success',
        axelarTransactionUrl: 'https://axelarscan.io/gmp/source',
        fromChain: { transactionUrl: 'https://arbiscan.io/tx/source' },
        toChain: { transactionId: 'destination-hash', transactionUrl: 'https://filfox.info/en/tx/destination' },
      })
    )

    await expect(
      pollSquidStatus(
        {
          transactionId: 'source hash',
          fromChainId: '42161',
          toChainId: '314',
          quoteId: 'quote / id',
          requestId: 'request & id',
        },
        { integratorId: 'test-only-integrator', fetchFn }
      )
    ).resolves.toMatchObject({
      status: 'confirmed',
      destinationTransactionHash: 'destination-hash',
      destinationTransactionUrl: 'https://filfox.info/en/tx/destination',
    })

    const request = new URL(String(fetchFn.mock.calls[0]?.[0]))
    expect(`${request.origin}${request.pathname}`).toBe('https://apiplus.squidrouter.com/v2/status')
    expect(request.searchParams.get('transactionId')).toBe('source hash')
    expect(request.searchParams.get('fromChainId')).toBe('42161')
    expect(request.searchParams.get('toChainId')).toBe('314')
    expect(request.searchParams.get('quoteId')).toBe('quote / id')
    expect(request.searchParams.get('requestId')).toBe('request & id')
  })

  it('keeps an unindexed 404 status in bounded polling until the provider returns a terminal result', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(response({ squidTransactionStatus: 'success' }))
    let now = 0
    const wait = vi.fn(async (milliseconds: number) => {
      now += milliseconds
    })
    const result = await waitForSquidTerminalStatus({
      getStatus: () =>
        pollSquidStatus(
          { transactionId: 'source', fromChainId: '42161', toChainId: '314', quoteId: 'quote' },
          { integratorId: 'test-only-integrator', fetchFn }
        ),
      now: () => now,
      wait,
    })

    expect(result).toEqual({ status: 'confirmed' })
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(wait).toHaveBeenCalledWith(5_000)

    await expect(
      pollSquidStatus(
        { transactionId: 'source', fromChainId: '42161', toChainId: '314', quoteId: 'quote' },
        {
          integratorId: 'test-only-integrator',
          fetchFn: vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 500 })),
        }
      )
    ).rejects.toThrow('status request failed (500)')
  })

  it('polls through the greater of fifteen minutes or twice the route duration using the bounded cadence', async () => {
    let now = 0
    const wait = vi.fn(async (milliseconds: number) => {
      now += milliseconds
    })
    const getStatus = vi.fn(async () =>
      now >= 900_000 ? { status: 'confirmed' as const } : { status: 'submitted' as const }
    )

    await expect(
      waitForSquidTerminalStatus({ getStatus, estimatedRouteDurationSeconds: 60, now: () => now, wait })
    ).resolves.toEqual({ status: 'confirmed' })

    expect(wait.mock.calls[0]).toEqual([5_000])
    expect(wait.mock.calls[23]).toEqual([5_000])
    expect(wait.mock.calls[24]).toEqual([15_000])
    expect(now).toBe(900_000)
  })

  it('caps a malformed provider route duration at one hour of status polling', async () => {
    let now = 0
    const wait = vi.fn(async (milliseconds: number) => {
      now += milliseconds
    })

    await expect(
      waitForSquidTerminalStatus({
        getStatus: vi.fn(async () => ({ status: 'submitted' as const })),
        estimatedRouteDurationSeconds: Number.MAX_SAFE_INTEGER,
        now: () => now,
        wait,
      })
    ).resolves.toEqual({ status: 'submitted' })

    expect(now).toBe(3_600_000)
    expect(wait).toHaveBeenLastCalledWith(15_000)
  })

  it('fails closed on Calibration before a provider request can be made', async () => {
    const fetchFn = vi.fn<typeof fetch>()
    await expect(
      ensureWalletReadyForFilecoinTransactions({
        destinationChainId: calibration.id,
        walletUsdfcBalance: 0n,
        walletFilBalance: 0n,
        requiredUsdfc: 1n,
        fromChain: 'arb',
        fromToken: 'USDC',
        maxSourceAmount: '1',
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
        provider: { integratorId: 'test-only-integrator', fetchFn },
        rereadWalletBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
      })
    ).rejects.toThrow('only on Filecoin mainnet')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('returns directly ready for a resolved source without provider or source-RPC calls', async () => {
    const chain = SELECTED_SOURCE_CHAINS.find((item) => item.chainId === 8453)
    if (chain == null) throw new Error('Base test chain missing')
    const fetchFn = vi.fn<typeof fetch>()
    const rereadWalletBalances = vi.fn().mockResolvedValue({ fil: MIN_FIL_FOR_GAS, usdfc: 1n })
    await expect(
      ensureWalletReadyForFilecoinTransactions({
        destinationChainId: 314,
        walletUsdfcBalance: 0n,
        walletFilBalance: 0n,
        requiredUsdfc: 1n,
        resolvedSource: {
          chain,
          chainId: chain.chainId,
          token: '0x0000000000000000000000000000000000000003',
          symbol: 'USDbC',
          decimals: 8,
          native: false,
          display: 'Base USDbC',
        },
        provider: { integratorId: 'test-only-integrator', fetchFn },
        rereadWalletBalances,
      })
    ).resolves.toEqual([])
    expect(rereadWalletBalances).toHaveBeenCalledOnce()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('plans a resolved Base source with its dynamic Squid chain and surfaces its gas ceiling for confirmation', async () => {
    const chain = SELECTED_SOURCE_CHAINS.find((item) => item.chainId === 8453)
    if (chain == null) throw new Error('Base test chain missing')
    const source: ResolvedSourceToken = {
      chain,
      chainId: chain.chainId,
      token: '0x0000000000000000000000000000000000000003',
      symbol: 'USDbC',
      decimals: 8,
      native: false,
      display: 'Base USDbC',
    }
    const fixture = await routeFixture('squid-route-usdfc.json')
    fixture.route.transactionRequest.expiry = '2000000000'
    const fetchFn = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, string>
      fixture.route.params.fromChain = body.fromChain
      fixture.route.params.fromToken = body.fromToken
      fixture.route.params.fromAmount = body.fromAmount
      fixture.route.params.toChain = body.toChain
      fixture.route.params.toAddress = body.toAddress
      fixture.route.params.fromAddress = body.fromAddress
      fixture.route.estimate.fromAmount = body.fromAmount
      return response(fixture)
    })
    const confirmation = vi.fn(async (_summary: SourceAcquisitionConfirmation) => {
      throw new Error('stop after resolved confirmation')
    })

    await expect(
      ensureWalletReadyForFilecoinTransactions({
        destinationChainId: 314,
        walletUsdfcBalance: 0n,
        walletFilBalance: MIN_FIL_FOR_GAS,
        requiredUsdfc: 1n,
        resolvedSource: source,
        maxSourceAmount: '1',
        privateKey: PRIVATE_KEY,
        provider: { integratorId: 'test-only-integrator', fetchFn },
        confirmSourceAcquisition: confirmation,
        rereadWalletBalances: vi.fn().mockResolvedValue({ fil: MIN_FIL_FOR_GAS, usdfc: 0n }),
      })
    ).rejects.toThrow('stop after resolved confirmation')

    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toMatchObject({
      fromChain: '8453',
      fromToken: source.token,
    })
    expect(confirmation).toHaveBeenCalledWith(
      expect.objectContaining({ sourceChainId: 8453, maxNativeGas: sourceNativeGasCeiling(8453) })
    )
  })

  it('rejects a strict checkpoint before legacy provider planning or confirmation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'filecoin-pin-acquisition-home-'))
    const originalHome = process.env.HOME
    process.env.HOME = directory
    try {
      const chain = SELECTED_SOURCE_CHAINS.find((item) => item.chainId === 8453)
      if (chain == null) throw new Error('Base test chain missing')
      const source: ResolvedSourceToken = {
        chain,
        chainId: chain.chainId,
        token: '0x0000000000000000000000000000000000000003',
        symbol: 'USDbC',
        decimals: 8,
        native: false,
        display: 'Base USDbC',
      }
      const owner = sourceAddressForPrivateKey(PRIVATE_KEY)
      const store = createAcquisitionCheckpointStore(owner)
      await store.save({
        version: 2,
        owner,
        sourceChainId: source.chainId,
        destinationChainId: 314,
        source: sourceRouteIdentity(source),
        maxSourceAmount: 10n,
        maxNativeGas: sourceNativeGasCeiling(source.chainId),
        committedNativeGas: 0n,
        requiredWallet: { fil: MIN_FIL_FOR_GAS, usdfc: 1n },
        evidence: [],
      })
      const fetchFn = vi.fn<typeof fetch>()
      const confirmation = vi.fn(async (_summary: SourceAcquisitionConfirmation) => undefined)

      await expect(
        ensureWalletReadyForFilecoinTransactions({
          destinationChainId: 314,
          walletUsdfcBalance: 0n,
          walletFilBalance: 0n,
          requiredUsdfc: 1n,
          fromChain: 'arb',
          fromToken: 'USDC',
          maxSourceAmount: '10',
          privateKey: PRIVATE_KEY,
          provider: { integratorId: 'test-only-integrator', fetchFn },
          confirmSourceAcquisition: confirmation,
          rereadWalletBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
        })
      ).rejects.toThrow('requires the exact selected source')

      expect(fetchFn).not.toHaveBeenCalled()
      expect(confirmation).not.toHaveBeenCalled()
      await expect(store.load()).resolves.toMatchObject({ version: 2, source: sourceRouteIdentity(source) })

      await expect(
        ensureWalletReadyForFilecoinTransactions({
          destinationChainId: 314,
          walletUsdfcBalance: 0n,
          walletFilBalance: 0n,
          requiredUsdfc: 1n,
          fromChain: 'arb',
          fromToken: 'USDC',
          maxSourceAmount: '10',
          privateKey: PRIVATE_KEY,
          provider: { integratorId: 'test-only-integrator', fetchFn },
          confirmSourceAcquisition: confirmation,
          rereadWalletBalances: vi.fn().mockResolvedValue({ fil: MIN_FIL_FOR_GAS, usdfc: 1n }),
        })
      ).rejects.toThrow('requires the exact selected source')

      await expect(store.load()).resolves.toMatchObject({ version: 2, source: sourceRouteIdentity(source) })
    } finally {
      if (originalHome == null) delete process.env.HOME
      else process.env.HOME = originalHome
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('uses a fresh ready wallet view and clears a completed checkpoint with an incompatible cap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'filecoin-pin-acquisition-home-'))
    const originalHome = process.env.HOME
    process.env.HOME = directory
    try {
      const owner = sourceAddressForPrivateKey(PRIVATE_KEY)
      const store = createAcquisitionCheckpointStore(owner)
      const source = resolvedArbitrumSource()
      await store.save({
        version: 2,
        owner,
        sourceChainId: 42161,
        destinationChainId: 314,
        committedNativeGas: 1n,
        source: sourceRouteIdentity(source),
        maxSourceAmount: 999n,
        maxNativeGas: sourceNativeGasCeiling(source.chainId) + 1n,
        requiredWallet: { fil: 100_000_000_000_000_000n, usdfc: 1n },
        evidence: [
          {
            asset: 'usdfc',
            quoteId: 'manual-top-up-arrived',
            sourceAmount: '1',
            sourceTransactionHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            status: 'submitted',
          },
        ],
      })
      const fetchFn = vi.fn<typeof fetch>()
      const confirmation = vi.fn(async (_summary: SourceAcquisitionConfirmation) => undefined)
      const rereadWalletBalances = vi.fn().mockResolvedValue({ fil: 100_000_000_000_000_000n, usdfc: 1n })

      await expect(
        ensureWalletReadyForFilecoinTransactions({
          destinationChainId: 314,
          walletUsdfcBalance: 0n,
          walletFilBalance: 0n,
          requiredUsdfc: 1n,
          resolvedSource: source,
          maxSourceAmount: '1',
          privateKey: PRIVATE_KEY,
          provider: { integratorId: 'test-only-integrator', fetchFn },
          confirmSourceAcquisition: confirmation,
          rereadWalletBalances,
        })
      ).resolves.toEqual([])

      expect(rereadWalletBalances).toHaveBeenCalledOnce()
      expect(fetchFn).not.toHaveBeenCalled()
      expect(confirmation).not.toHaveBeenCalled()
      await expect(store.load()).resolves.toBeUndefined()
    } finally {
      if (originalHome == null) delete process.env.HOME
      else process.env.HOME = originalHome
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('clears a compatible route checkpoint when delayed Filecoin arrival makes a retry ready', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'filecoin-pin-acquisition-home-'))
    const originalHome = process.env.HOME
    process.env.HOME = directory
    try {
      const owner = sourceAddressForPrivateKey(PRIVATE_KEY)
      const store = createAcquisitionCheckpointStore(owner)
      await store.save({
        version: 1,
        owner,
        sourceChainId: 42161,
        destinationChainId: 314,
        committedNativeGas: 1n,
        requiredWallet: { fil: 100_000_000_000_000_000n, usdfc: 1n },
        evidence: [
          {
            asset: 'usdfc',
            quoteId: 'delayed-arrival-route',
            sourceAmount: '1',
            sourceTransactionHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            status: 'submitted',
          },
        ],
      })
      const fetchFn = vi.fn<typeof fetch>()

      await expect(
        ensureWalletReadyForFilecoinTransactions({
          destinationChainId: 314,
          walletUsdfcBalance: 1n,
          walletFilBalance: 100_000_000_000_000_000n,
          requiredUsdfc: 1n,
          fromChain: 'arb',
          fromToken: 'USDC',
          resolvedSource: resolvedArbitrumSource(),
          maxSourceAmount: '1',
          privateKey: PRIVATE_KEY,
          provider: { integratorId: undefined, fetchFn },
          rereadWalletBalances: vi.fn().mockResolvedValue({ fil: 100_000_000_000_000_000n, usdfc: 1n }),
        })
      ).resolves.toEqual([])

      await expect(store.load()).resolves.toBeUndefined()
      expect(fetchFn).not.toHaveBeenCalled()
    } finally {
      if (originalHome == null) delete process.env.HOME
      else process.env.HOME = originalHome
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('retains a completed larger-target checkpoint until its recorded Filecoin balances arrive', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'filecoin-pin-acquisition-home-'))
    const originalHome = process.env.HOME
    process.env.HOME = directory
    try {
      const owner = sourceAddressForPrivateKey(PRIVATE_KEY)
      const store = createAcquisitionCheckpointStore(owner)
      await store.save({
        version: 1,
        owner,
        sourceChainId: 42161,
        destinationChainId: 314,
        committedNativeGas: 1n,
        requiredWallet: { fil: 200_000_000_000_000_000n, usdfc: 5n },
        evidence: [
          {
            asset: 'usdfc',
            quoteId: 'larger-target-route',
            sourceAmount: '1',
            sourceTransactionHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            status: 'submitted',
          },
        ],
      })
      const fetchFn = vi.fn<typeof fetch>()

      await expect(
        ensureWalletReadyForFilecoinTransactions({
          destinationChainId: 314,
          walletUsdfcBalance: 1n,
          walletFilBalance: 100_000_000_000_000_000n,
          requiredUsdfc: 1n,
          fromChain: 'arb',
          fromToken: 'USDC',
          resolvedSource: resolvedArbitrumSource(),
          maxSourceAmount: '1',
          privateKey: PRIVATE_KEY,
          provider: { integratorId: undefined, fetchFn },
          rereadWalletBalances: vi.fn().mockResolvedValue({ fil: 100_000_000_000_000_000n, usdfc: 1n }),
        })
      ).resolves.toEqual([])

      await expect(store.load()).resolves.toMatchObject({
        requiredWallet: { fil: 200_000_000_000_000_000n, usdfc: 5n },
      })
      expect(fetchFn).not.toHaveBeenCalled()

      await expect(
        ensureWalletReadyForFilecoinTransactions({
          destinationChainId: 314,
          walletUsdfcBalance: 5n,
          walletFilBalance: 200_000_000_000_000_000n,
          requiredUsdfc: 1n,
          fromChain: 'arb',
          fromToken: 'USDC',
          maxSourceAmount: '1',
          privateKey: PRIVATE_KEY,
          provider: { integratorId: undefined, fetchFn },
          rereadWalletBalances: vi.fn().mockResolvedValue({ fil: 200_000_000_000_000_000n, usdfc: 5n }),
        })
      ).resolves.toEqual([])

      await expect(store.load()).resolves.toBeUndefined()
      expect(fetchFn).not.toHaveBeenCalled()
    } finally {
      if (originalHome == null) delete process.env.HOME
      else process.env.HOME = originalHome
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps a foreign checkpoint when a ready retry cannot safely recover it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'filecoin-pin-acquisition-home-'))
    const originalHome = process.env.HOME
    process.env.HOME = directory
    try {
      const owner = sourceAddressForPrivateKey(PRIVATE_KEY)
      const store = createAcquisitionCheckpointStore(owner)
      await store.save({
        version: 1,
        owner: OWNER,
        sourceChainId: 42161,
        destinationChainId: 314,
        committedNativeGas: 1n,
        requiredWallet: { fil: 100_000_000_000_000_000n, usdfc: 1n },
        evidence: [],
      })

      await expect(
        ensureWalletReadyForFilecoinTransactions({
          destinationChainId: 314,
          walletUsdfcBalance: 1n,
          walletFilBalance: 100_000_000_000_000_000n,
          requiredUsdfc: 1n,
          fromChain: 'arb',
          fromToken: 'USDC',
          resolvedSource: resolvedArbitrumSource(),
          maxSourceAmount: '1',
          privateKey: PRIVATE_KEY,
          provider: { integratorId: undefined },
          rereadWalletBalances: vi.fn().mockResolvedValue({ fil: 100_000_000_000_000_000n, usdfc: 1n }),
        })
      ).resolves.toEqual([])

      await expect(store.load()).resolves.toMatchObject({ owner: OWNER })
    } finally {
      if (originalHome == null) delete process.env.HOME
      else process.env.HOME = originalHome
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps a compatible pre-broadcast route intent for duplicate-spend recovery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'filecoin-pin-acquisition-home-'))
    const originalHome = process.env.HOME
    process.env.HOME = directory
    try {
      const owner = sourceAddressForPrivateKey(PRIVATE_KEY)
      const store = createAcquisitionCheckpointStore(owner)
      await store.save({
        version: 1,
        owner,
        sourceChainId: 42161,
        destinationChainId: 314,
        committedNativeGas: 1n,
        routeIntent: {
          nonce: 8,
          quoteId: 'route-without-hash',
          asset: 'usdfc',
          sourceAmount: '1',
          target: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
          dataHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          value: '0',
          gasLimit: '1',
          maxFeePerGas: '1',
        },
        requiredWallet: { fil: 100_000_000_000_000_000n, usdfc: 1n },
        evidence: [],
      })

      await expect(
        ensureWalletReadyForFilecoinTransactions({
          destinationChainId: 314,
          walletUsdfcBalance: 1n,
          walletFilBalance: 100_000_000_000_000_000n,
          requiredUsdfc: 1n,
          fromChain: 'arb',
          fromToken: 'USDC',
          maxSourceAmount: '1',
          privateKey: PRIVATE_KEY,
          provider: { integratorId: undefined },
          rereadWalletBalances: vi.fn().mockResolvedValue({ fil: 100_000_000_000_000_000n, usdfc: 1n }),
        })
      ).resolves.toEqual([])

      await expect(store.load()).resolves.toMatchObject({ routeIntent: expect.any(Object) })
    } finally {
      if (originalHome == null) delete process.env.HOME
      else process.env.HOME = originalHome
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('fails closed on a durable pre-broadcast intent before requesting a new provider quote', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'filecoin-pin-acquisition-home-'))
    const originalHome = process.env.HOME
    process.env.HOME = directory
    try {
      const owner = sourceAddressForPrivateKey(PRIVATE_KEY)
      const store = createAcquisitionCheckpointStore(owner)
      await store.save({
        version: 1,
        owner,
        sourceChainId: 42161,
        destinationChainId: 314,
        committedNativeGas: 1n,
        approvalIntent: {
          nonce: 8,
          token: '0x0000000000000000000000000000000000000001',
          spender: '0x0000000000000000000000000000000000000002',
          amount: '10',
          gasLimit: '100',
          maxFeePerGas: '2',
        },
        requiredWallet: { fil: 0n, usdfc: 1n },
        evidence: [],
      })
      const fetchFn = vi.fn<typeof fetch>()

      await expect(
        ensureWalletReadyForFilecoinTransactions({
          destinationChainId: 314,
          walletUsdfcBalance: 0n,
          walletFilBalance: 0n,
          requiredUsdfc: 1n,
          fromChain: 'arb',
          fromToken: 'USDC',
          maxSourceAmount: '1',
          privateKey: PRIVATE_KEY,
          provider: { integratorId: undefined, fetchFn },
          rereadWalletBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
        })
      ).rejects.toThrow('pre-broadcast intent without a transaction hash')

      expect(fetchFn).not.toHaveBeenCalled()
    } finally {
      if (originalHome == null) delete process.env.HOME
      else process.env.HOME = originalHome
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('confirms a newly planned quote before continuing a partial checkpoint recovery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'filecoin-pin-acquisition-home-'))
    const originalHome = process.env.HOME
    process.env.HOME = directory
    try {
      const owner = sourceAddressForPrivateKey(PRIVATE_KEY)
      const store = createAcquisitionCheckpointStore(owner)
      await store.save({
        version: 1,
        owner,
        sourceChainId: 42161,
        destinationChainId: 314,
        committedNativeGas: 1n,
        requiredWallet: { fil: 100_000_000_000_000_000n, usdfc: 1n },
        evidence: [
          {
            asset: 'fil',
            quoteId: 'completed-fil-route',
            sourceAmount: '1',
            sourceTransactionHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            status: 'confirmed',
          },
        ],
      })
      const fixture = await routeFixture('squid-route-usdfc.json')
      fixture.route.params.fromAddress = owner
      fixture.route.params.toAddress = owner
      fixture.route.transactionRequest.expiry = '2000000000'
      setFixtureSourceAmount(fixture, 500_000n)
      const confirmation = vi.fn(async (_summary: SourceAcquisitionConfirmation) => {
        throw new Error('confirmation reached before execution')
      })

      await expect(
        ensureWalletReadyForFilecoinTransactions({
          destinationChainId: 314,
          walletUsdfcBalance: 0n,
          walletFilBalance: 100_000_000_000_000_000n,
          requiredUsdfc: 1n,
          fromChain: 'arb',
          fromToken: 'USDC',
          maxSourceAmount: '10',
          privateKey: PRIVATE_KEY,
          provider: {
            integratorId: 'test-only-integrator',
            fetchFn: vi.fn<typeof fetch>().mockResolvedValue(response(fixture)),
          },
          confirmSourceAcquisition: confirmation,
          rereadWalletBalances: vi.fn().mockResolvedValue({ fil: 100_000_000_000_000_000n, usdfc: 0n }),
        })
      ).rejects.toThrow('confirmation reached before execution')

      expect(confirmation).toHaveBeenCalledOnce()
      expect(confirmation).toHaveBeenCalledWith({
        sourceAmount: 500_000n,
        maxSourceAmount: 9_999_999n,
        legs: [
          {
            asset: 'usdfc',
            minimumDestinationAmount: 4_894_083_014_213_259_056n,
            expiresAt: 2_000_000_000,
          },
        ],
      })
      await expect(store.load()).resolves.toMatchObject({ evidence: [{ asset: 'fil' }] })
    } finally {
      if (originalHome == null) delete process.env.HOME
      else process.env.HOME = originalHome
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reconciles a hashed approval intent before resuming a completed checkpoint without duplicate submission', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'filecoin-pin-acquisition-home-'))
    const originalHome = process.env.HOME
    process.env.HOME = directory
    let approvalReceiptCalls = 0
    const sourceRpc = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => {
        body += String(chunk)
      })
      request.on('end', () => {
        const { id, method } = JSON.parse(body) as { id: number | string; method: string }
        if (method === 'eth_getTransactionReceipt') approvalReceiptCalls += 1
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            result:
              method === 'eth_getTransactionReceipt'
                ? {
                    transactionHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    blockHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                    blockNumber: '0x1',
                    status: '0x1',
                    transactionIndex: '0x0',
                    logs: [],
                    logsBloom: `0x${'0'.repeat(512)}`,
                    cumulativeGasUsed: '0x1',
                    gasUsed: '0x1',
                    effectiveGasPrice: '0x1',
                    type: '0x2',
                  }
                : '0xa4b1',
          })
        )
      })
    })
    await new Promise<void>((resolve) => sourceRpc.listen(0, '127.0.0.1', resolve))
    const address = sourceRpc.address()
    if (address == null || typeof address === 'string') throw new Error('test source RPC did not bind a TCP port')
    try {
      const owner = sourceAddressForPrivateKey(PRIVATE_KEY)
      const store = createAcquisitionCheckpointStore(owner)
      await store.save({
        version: 1,
        owner,
        sourceChainId: 42161,
        destinationChainId: 314,
        committedNativeGas: 1n,
        approvalIntent: {
          nonce: 8,
          token: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
          spender: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
          amount: '1',
          gasLimit: '1',
          maxFeePerGas: '1',
        },
        approvalTransactionHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        requiredWallet: { fil: 100_000_000_000_000_000n, usdfc: 1n },
        evidence: [
          {
            asset: 'usdfc',
            quoteId: 'completed-usdfc-route',
            sourceAmount: '1',
            sourceTransactionHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            status: 'submitted',
          },
        ],
      })
      const confirmation = vi.fn(async (_summary: SourceAcquisitionConfirmation) => undefined)
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response({ squidTransactionStatus: 'success' }))
      const rereadWalletBalances = vi
        .fn()
        .mockResolvedValueOnce({ fil: 100_000_000_000_000_000n, usdfc: 0n })
        .mockResolvedValue({ fil: 100_000_000_000_000_000n, usdfc: 1n })

      await expect(
        ensureWalletReadyForFilecoinTransactions({
          destinationChainId: 314,
          walletUsdfcBalance: 0n,
          walletFilBalance: 100_000_000_000_000_000n,
          requiredUsdfc: 1n,
          fromChain: 'arb',
          fromToken: 'USDC',
          maxSourceAmount: '10',
          sourceRpcUrl: `http://127.0.0.1:${address.port}`,
          privateKey: PRIVATE_KEY,
          provider: { integratorId: 'test-only-integrator', fetchFn },
          confirmSourceAcquisition: confirmation,
          rereadWalletBalances,
        })
      ).resolves.toMatchObject([{ asset: 'usdfc', status: 'confirmed' }])

      expect(confirmation).not.toHaveBeenCalled()
      expect(approvalReceiptCalls).toBe(1)
      expect(fetchFn).not.toHaveBeenCalled()
      await expect(store.load()).resolves.toBeUndefined()
    } finally {
      await new Promise<void>((resolve, reject) =>
        sourceRpc.close((error) => (error == null ? resolve() : reject(error)))
      )
      if (originalHome == null) delete process.env.HOME
      else process.env.HOME = originalHome
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('wallet shortfall acquisition planning', () => {
  it('plans FIL-only and combined shortfalls as independent exact destination legs', () => {
    const source = supportedSource()
    const filOnly = planWalletFunding({
      requiredUsdfc: 10n,
      walletUsdfcBalance: 10n,
      requiredFilReserve: 20n,
      walletFilBalance: 5n,
      source,
    })
    const combined = planWalletFunding({
      requiredUsdfc: 10n,
      walletUsdfcBalance: 2n,
      requiredFilReserve: 20n,
      walletFilBalance: 5n,
      source,
    })

    expect(filOnly).toMatchObject({ path: 'acquire-fil', filShortfall: 15n, usdfcShortfall: 0n })
    expect(filOnly.legs).toEqual([{ asset: 'fil', amount: 15n, source }])
    expect(combined).toMatchObject({ path: 'acquire-both', filShortfall: 15n, usdfcShortfall: 8n })
    expect(combined.legs.map((leg) => [leg.asset, leg.amount])).toEqual([
      ['fil', 15n],
      ['usdfc', 8n],
    ])
  })

  it('fails closed for unsupported source inputs and non-positive source caps', () => {
    expect(resolveSourceToken('eth', 'USDC')).toBeUndefined()
    expect(resolveSourceToken('arb', 'DAI')).toBeUndefined()
    expect(() => parseMaximumSourceAmount('0')).toThrow('greater than zero')
    expect(() => parseMaximumSourceAmount('-1')).toThrow('greater than zero')
  })

  it('rejects invalid source decimals before planning contacts the provider', async () => {
    const source = { ...supportedSource(), decimals: 256 }
    const plan = planWalletFunding({
      requiredUsdfc: 1n,
      walletUsdfcBalance: 0n,
      requiredFilReserve: 0n,
      walletFilBalance: 0n,
      source,
    })
    const fetchFn = vi.fn<typeof fetch>()

    await expect(
      planTokenAcquisition({
        plan,
        owner: OWNER,
        maxSourceAmount: 1n,
        slippage: 1,
        provider: { integratorId: 'test-only-integrator', fetchFn },
      })
    ).rejects.toThrow('invalid decimals')

    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('rejects same-asset Filecoin self-funding before requesting a route', async () => {
    const nativeFil = {
      chainId: 314,
      token: FILECOIN_NATIVE_TOKEN.toUpperCase(),
      symbol: 'not-an-authorization-primitive',
      decimals: 18,
      native: true,
    }
    const usdfc = {
      chainId: 314,
      token: FILECOIN_USDFC.toUpperCase(),
      symbol: 'not-an-authorization-primitive',
      decimals: 18,
      native: false,
    }
    const cases = [
      {
        source: nativeFil,
        plan: planWalletFunding({
          requiredUsdfc: 0n,
          walletUsdfcBalance: 0n,
          requiredFilReserve: 1n,
          walletFilBalance: 0n,
          source: nativeFil,
        }),
      },
      {
        source: usdfc,
        plan: planWalletFunding({
          requiredUsdfc: 1n,
          walletUsdfcBalance: 0n,
          requiredFilReserve: 0n,
          walletFilBalance: 0n,
          source: usdfc,
        }),
      },
    ]
    for (const current of cases) {
      const fetchFn = vi.fn<typeof fetch>()
      await expect(
        planTokenAcquisition({
          plan: current.plan,
          owner: OWNER,
          maxSourceAmount: 1n,
          slippage: 1,
          provider: { integratorId: 'test-only-integrator', fetchFn },
        })
      ).rejects.toThrow('cannot fund the same wallet shortfall')
      expect(fetchFn).not.toHaveBeenCalled()
    }
  })

  it('permits Filecoin cross-asset funding routes', async () => {
    const source = {
      chainId: 314,
      token: FILECOIN_NATIVE_TOKEN,
      symbol: 'FIL',
      decimals: 18,
      native: true,
    }
    const plan = planWalletFunding({
      requiredUsdfc: 1n,
      walletUsdfcBalance: 0n,
      requiredFilReserve: 0n,
      walletFilBalance: 0n,
      source,
    })
    const fixture = await routeFixture('squid-route-usdfc.json')
    const fetchFn = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, string>
      fixture.route.params.fromChain = body.fromChain
      fixture.route.params.fromToken = body.fromToken
      fixture.route.params.fromAmount = body.fromAmount
      fixture.route.params.toChain = body.toChain
      fixture.route.params.toToken = body.toToken
      fixture.route.params.fromAddress = body.fromAddress
      fixture.route.params.toAddress = body.toAddress
      fixture.route.estimate.fromAmount = body.fromAmount
      return response(fixture)
    })

    await expect(
      planTokenAcquisition({
        plan,
        owner: OWNER,
        maxSourceAmount: 5n * 10n ** 17n,
        slippage: 1,
        provider: { integratorId: 'test-only-integrator', fetchFn, now: () => 1_700_000_000_000 },
      })
    ).resolves.toHaveLength(1)

    expect(fetchFn).toHaveBeenCalled()
  })

  it('plans a zero-decimal source with a base-unit probe', async () => {
    const source = { ...supportedSource(), decimals: 0 }
    const plan = planWalletFunding({
      requiredUsdfc: 1n,
      walletUsdfcBalance: 0n,
      requiredFilReserve: 0n,
      walletFilBalance: 0n,
      source,
    })
    const fixture = await routeFixture('squid-route-usdfc.json')
    setFixtureSourceAmount(fixture, 5n)
    const oneBaseUnitFixture = structuredClone(fixture)
    setFixtureSourceAmount(oneBaseUnitFixture, 1n)
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(fixture))
      .mockResolvedValueOnce(response(oneBaseUnitFixture))

    await expect(
      planTokenAcquisition({
        plan,
        owner: OWNER,
        maxSourceAmount: 5n,
        slippage: 1,
        provider: { integratorId: 'test-only-integrator', fetchFn, now: () => 1_700_000_000_000 },
      })
    ).resolves.toHaveLength(1)

    await expect(
      planTokenAcquisition({
        plan,
        owner: OWNER,
        maxSourceAmount: 1n,
        initialSourceAmount: 1n,
        slippage: 1,
        provider: { integratorId: 'test-only-integrator', fetchFn, now: () => 1_700_000_000_000 },
      })
    ).resolves.toHaveLength(1)

    expect(fetchFn.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).fromAmount)).toEqual(['5', '1'])
  })

  it('retains exact downstream shortfalls and scales fixed source input without re-estimating Filecoin funding', async () => {
    const source = supportedSource()
    const plan = planWalletFunding({
      requiredUsdfc: 2_000_000_000_000_000_000n,
      walletUsdfcBalance: 0n,
      requiredFilReserve: 100n,
      walletFilBalance: 100n,
      source,
    })
    const fixture = await routeFixture('squid-route-usdfc.json')
    setFixtureSourceAmount(fixture, 500_000n)
    fixture.route.estimate.toAmountMin = '1000000000000000000'
    const scaledFixture = structuredClone(fixture)
    setFixtureSourceAmount(scaledFixture, 1_000_000n)
    scaledFixture.route.estimate.toAmountMin = '2000000000000000000'
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(fixture))
      .mockResolvedValueOnce(response(scaledFixture))

    const quotes = await planTokenAcquisition({
      plan,
      owner: OWNER,
      maxSourceAmount: 2_000_000n,
      slippage: 1,
      provider: { integratorId: 'test-only-integrator', fetchFn, now: () => 1_700_000_000_000 },
    })

    expect(plan.usdfcShortfall).toBe(2_000_000_000_000_000_000n)
    expect(quotes).toHaveLength(1)
    expect(quotes[0]?.sourceAmount).toBe(1_000_000n)
  })

  it('refreshes a route once at its original fixed source input', async () => {
    const sourceAmount = 500_000n
    const leg: AcquisitionLeg = { asset: 'usdfc', amount: 2_000_000_000_000_000_000n, source: supportedSource() }
    const quote: PlannedAcquisitionQuote = {
      ...executionQuote(),
      asset: 'usdfc',
      sourceAmount,
      destinationAmount: leg.amount,
    }
    const fixture = await routeFixture('squid-route-usdfc.json')
    setFixtureSourceAmount(fixture, sourceAmount)
    fixture.route.estimate.toAmountMin = leg.amount.toString()
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(fixture))

    await expect(
      refreshFixedInputAcquisitionQuote({
        quote,
        leg,
        owner: OWNER,
        slippage: 1,
        provider: { integratorId: 'test-only-integrator', fetchFn, now: () => 1_700_000_000_000 },
      })
    ).resolves.toMatchObject({ sourceAmount, destinationAmount: leg.amount })

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toMatchObject({ fromAmount: sourceAmount.toString() })
  })

  it('does not scale or re-quote when a fixed-input refresh no longer covers its wallet shortfall', async () => {
    const sourceAmount = 500_000n
    const leg: AcquisitionLeg = { asset: 'usdfc', amount: 2_000_000_000_000_000_000n, source: supportedSource() }
    const quote: PlannedAcquisitionQuote = {
      ...executionQuote(),
      asset: 'usdfc',
      sourceAmount,
      destinationAmount: leg.amount,
    }
    const fixture = await routeFixture('squid-route-usdfc.json')
    setFixtureSourceAmount(fixture, sourceAmount)
    fixture.route.estimate.toAmountMin = (leg.amount - 1n).toString()
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(fixture))

    await expect(
      refreshFixedInputAcquisitionQuote({
        quote,
        leg,
        owner: OWNER,
        slippage: 1,
        provider: { integratorId: 'test-only-integrator', fetchFn, now: () => 1_700_000_000_000 },
      })
    ).rejects.toThrow('no longer covers the planned wallet shortfall')

    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('retries a zero-output seed quote and rejects repeated zero outputs with a clear acquisition error', async () => {
    const source = supportedSource()
    const plan = planWalletFunding({
      requiredUsdfc: 2_000_000_000_000_000_000n,
      walletUsdfcBalance: 0n,
      requiredFilReserve: 100n,
      walletFilBalance: 100n,
      source,
    })
    const zeroFixture = await routeFixture('squid-route-usdfc.json')
    setFixtureSourceAmount(zeroFixture, 500_000n)
    zeroFixture.route.estimate.toAmountMin = '0'
    const usableFixture = structuredClone(zeroFixture)
    usableFixture.route.estimate.toAmountMin = '2000000000000000000'
    const retryFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(zeroFixture))
      .mockResolvedValueOnce(response(usableFixture))

    await expect(
      planTokenAcquisition({
        plan,
        owner: OWNER,
        maxSourceAmount: 500_000n,
        slippage: 1,
        provider: { integratorId: 'test-only-integrator', fetchFn: retryFetch, now: () => 1_700_000_000_000 },
      })
    ).resolves.toHaveLength(1)
    expect(retryFetch).toHaveBeenCalledTimes(2)

    const repeatedZeroFetch = vi.fn<typeof fetch>().mockImplementation(async () => response(zeroFixture))
    await expect(
      planTokenAcquisition({
        plan,
        owner: OWNER,
        maxSourceAmount: 500_000n,
        slippage: 1,
        provider: { integratorId: 'test-only-integrator', fetchFn: repeatedZeroFetch, now: () => 1_700_000_000_000 },
      })
    ).rejects.toThrow('zero minimum destination amount')
    expect(repeatedZeroFetch).toHaveBeenCalledTimes(4)
  })

  it('counts ERC-20 approval gas together with route commitments before allowing a source spend', () => {
    const quote: PlannedAcquisitionQuote = {
      id: 'q',
      asset: 'fil',
      sourceAmount: 1n,
      destinationAmount: 1n,
      target: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
      data: '0x12',
      value: 2n,
      gasLimit: 3n,
      maxFeePerGas: 5n,
      expiresAt: 2_000_000_000,
      estimatedRouteDurationSeconds: 90,
    }
    expect(() =>
      validateMaximumSourceSpend({ quotes: [quote], maxSourceAmount: 1n, maxNativeGas: 20n, approvalGas: [4n] })
    ).toThrow('source-native gas cap')
  })

  it('rejects a refreshed route when consumed plus remaining source gas exceeds the hard cap', () => {
    expect(
      isWithinCumulativeSourceGasCap({
        committedNativeGas: 10n,
        nextCommitment: 91n,
        cap: 100n,
      })
    ).toBe(false)
    expect(
      isWithinCumulativeSourceGasCap({
        committedNativeGas: 10n,
        nextCommitment: 90n,
        cap: 100n,
      })
    ).toBe(true)
  })

  it('persists cumulative commitments and rejects a second leg even if its current native balance rises', async () => {
    const first = {
      ...executionQuote(),
      id: 'first-leg',
      value: 0n,
      gasLimit: 1n,
      maxFeePerGas: MAX_SOURCE_NATIVE_GAS - 10n,
    }
    const second = {
      ...first,
      id: 'second-leg',
      sourceAmount: 2n,
      destinationAmount: 4n,
      maxFeePerGas: 5n,
    }
    const allowanceValues = [
      first.sourceAmount,
      first.sourceAmount,
      first.sourceAmount,
      second.sourceAmount,
      second.sourceAmount,
    ]
    const sourceClient = {
      getChainId: vi.fn().mockResolvedValue(42161),
      getBalance: vi
        .fn()
        .mockResolvedValueOnce(MAX_SOURCE_NATIVE_GAS + 100n)
        .mockResolvedValueOnce(MAX_SOURCE_NATIVE_GAS * 2n)
        .mockResolvedValueOnce(MAX_SOURCE_NATIVE_GAS * 3n),
      getGasPrice: vi.fn().mockResolvedValue(0n),
      getTransactionCount: vi.fn().mockResolvedValue(8),
      estimateContractGas: vi.fn().mockResolvedValue(0n),
      readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
        functionName === 'balanceOf' ? 100n : (allowanceValues.shift() ?? second.sourceAmount)
      ),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
    } as unknown as PublicClient
    const walletClient = {
      writeContract: vi.fn(),
      sendTransaction: vi.fn().mockResolvedValue('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
    }
    const store = emptyCheckpointStore()
    const refreshQuote = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce({ ...second, maxFeePerGas: 20n })

    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        sourceClient,
        walletClient: walletClient as never,
        quotes: [first, second],
        refreshQuote,
        getProviderStatus: vi.fn().mockResolvedValue({ status: 'confirmed' }),
        checkpointStore: store,
        destinationChainId: 314,
        getFilecoinBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
        waitForFilecoinArrival: vi.fn(),
      })
    ).rejects.toThrow('source-native gas cap')

    expect(walletClient.sendTransaction).toHaveBeenCalledTimes(1)
    expect(store.value?.committedNativeGas).toBe(MAX_SOURCE_NATIVE_GAS - 10n)
  })

  it('reserves known remaining commitments after a refreshed first leg before broadcasting it', async () => {
    const first = {
      ...executionQuote(),
      id: 'first-refresh-reserve',
      asset: 'fil' as const,
      value: 0n,
      gasLimit: 1n,
      maxFeePerGas: MAX_SOURCE_NATIVE_GAS - 20n,
    }
    const second = {
      ...executionQuote(),
      id: 'second-refresh-reserve',
      sourceAmount: 2n,
      destinationAmount: 4n,
      value: 0n,
      gasLimit: 1n,
      maxFeePerGas: 10n,
    }
    const sourceClient = {
      getChainId: vi.fn().mockResolvedValue(42161),
      getBalance: vi.fn().mockResolvedValue(MAX_SOURCE_NATIVE_GAS * 2n),
      getGasPrice: vi.fn().mockResolvedValue(0n),
      estimateContractGas: vi.fn().mockResolvedValue(0n),
      readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
        functionName === 'balanceOf' ? 100n : first.sourceAmount
      ),
    } as unknown as PublicClient
    const walletClient = { writeContract: vi.fn(), sendTransaction: vi.fn() }
    const refreshedFirst = { ...first, maxFeePerGas: MAX_SOURCE_NATIVE_GAS - 5n }

    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        sourceClient,
        walletClient: walletClient as never,
        quotes: [first, second],
        refreshQuote: vi.fn().mockResolvedValue(refreshedFirst),
        getProviderStatus: vi.fn(),
        checkpointStore: emptyCheckpointStore(),
        destinationChainId: 314,
        getFilecoinBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
        waitForFilecoinArrival: vi.fn(),
      })
    ).rejects.toThrow('source-native gas cap')

    expect(walletClient.writeContract).not.toHaveBeenCalled()
    expect(walletClient.sendTransaction).not.toHaveBeenCalled()
  })

  it('fails closed for concurrent acquisition ownership and releases only its own lock', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'filecoin-pin-acquisition-lock-'))
    try {
      const first = await acquireAcquisitionLock(OWNER, { directory })
      await expect(acquireAcquisitionLock(OWNER, { directory })).rejects.toThrow('already active')
      if (process.platform !== 'win32') {
        expect((await stat(directory)).mode & 0o777).toBe(0o700)
        expect((await stat(join(directory, `${OWNER.toLowerCase()}.lock`))).mode & 0o777).toBe(0o600)
      }
      await first.release()
      const second = await acquireAcquisitionLock(OWNER, { directory })
      await second.release()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('fails closed when the explicit source RPC is not Arbitrum', () => {
    expect(() => assertArbitrumSourceChain(1)).toThrow('not Arbitrum')
    expect(() => assertArbitrumSourceChain(42161)).not.toThrow()
  })

  it('rejects a pre- or post-approval refresh that changes fixed input or lowers minimum output', () => {
    const quote: PlannedAcquisitionQuote = {
      id: 'fixed-input',
      asset: 'usdfc',
      sourceAmount: 10n,
      destinationAmount: 20n,
      target: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
      data: '0x12',
      value: 0n,
      gasLimit: 1n,
      maxFeePerGas: 1n,
      expiresAt: 2_000_000_000,
      estimatedRouteDurationSeconds: 90,
    }
    expect(() => assertFixedInputRefresh(quote, { ...quote, sourceAmount: 11n })).toThrow('changed after refresh')
    expect(() => assertFixedInputRefresh(quote, { ...quote, destinationAmount: 19n })).toThrow('changed after refresh')
    expect(() => assertFixedInputRefresh(quote, quote)).not.toThrow()
  })

  it('refreshes before approval and again before a route signature, failing closed before a changed route is sent', async () => {
    const quote = executionQuote()
    const refreshQuote = vi
      .fn()
      .mockResolvedValueOnce(quote)
      .mockResolvedValueOnce({ ...quote, destinationAmount: quote.destinationAmount - 1n })
    const walletClient = {
      writeContract: vi.fn(),
      sendTransaction: vi.fn(),
    }

    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        sourceRpcUrl: 'https://unused.example/rpc',
        sourceClient: sourceClientForExecution(() => quote.sourceAmount),
        walletClient: walletClient as never,
        quotes: [quote],
        refreshQuote,
        getProviderStatus: vi.fn(),
        checkpointStore: emptyCheckpointStore(),
        destinationChainId: 314,
        getFilecoinBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
        waitForFilecoinArrival: vi.fn(),
      })
    ).rejects.toThrow('changed after refresh')

    expect(refreshQuote).toHaveBeenCalledTimes(2)
    expect(walletClient.writeContract).not.toHaveBeenCalled()
    expect(walletClient.sendTransaction).not.toHaveBeenCalled()
  })

  it('does not broadcast a route that expires while recording its durable route intent', async () => {
    const quote = { ...executionQuote(), expiresAt: 2 }
    const store = emptyCheckpointStore()
    const walletClient = {
      writeContract: vi.fn(),
      sendTransaction: vi.fn(),
    }
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_000).mockReturnValue(2_000)

    try {
      await expect(
        executeTokenAcquisition({
          privateKey: PRIVATE_KEY,
          sourceClient: sourceClientForExecution(() => quote.sourceAmount),
          walletClient: walletClient as never,
          quotes: [quote],
          refreshQuote: vi.fn(async (current) => current),
          getProviderStatus: vi.fn(),
          checkpointStore: store,
          destinationChainId: 314,
          getFilecoinBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
          waitForFilecoinArrival: vi.fn(),
        })
      ).rejects.toThrow('route expired before submission')
    } finally {
      now.mockRestore()
    }

    expect(walletClient.sendTransaction).not.toHaveBeenCalled()
    expect(store.value).toMatchObject({
      routeIntent: expect.objectContaining({ quoteId: quote.id }),
    })
    expect(store.clear).not.toHaveBeenCalled()
  })

  it('does not reserve approval gas when the exact allowance already makes approval a no-op', async () => {
    const quote = executionQuote()
    const estimateContractGas = vi.fn().mockResolvedValue(3n)
    const sourceClient = {
      getChainId: vi.fn().mockResolvedValue(42161),
      getBalance: vi.fn().mockResolvedValue(17n),
      getGasPrice: vi.fn().mockResolvedValue(5n),
      getTransactionCount: vi.fn().mockResolvedValue(8),
      estimateContractGas,
      readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
        functionName === 'balanceOf' ? 100n : quote.sourceAmount
      ),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
    } as unknown as PublicClient
    const walletClient = {
      writeContract: vi.fn(),
      sendTransaction: vi.fn().mockResolvedValue('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
    }

    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        sourceClient,
        walletClient: walletClient as never,
        quotes: [quote],
        refreshQuote: vi.fn(async (current) => current),
        getProviderStatus: vi.fn().mockResolvedValue({ status: 'confirmed' }),
        checkpointStore: emptyCheckpointStore(),
        destinationChainId: 314,
        getFilecoinBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
        waitForFilecoinArrival: vi.fn(),
      })
    ).resolves.toHaveLength(1)

    expect(estimateContractGas).not.toHaveBeenCalled()
    expect(walletClient.writeContract).not.toHaveBeenCalled()
    expect(walletClient.sendTransaction).toHaveBeenCalledTimes(1)
  })

  it('reserves a replacement approval for a second equal-amount route after the first consumes allowance', async () => {
    const first = executionQuote()
    const second = { ...executionQuote(), id: 'second-equal-allowance', destinationAmount: 4n }
    const estimateContractGas = vi.fn().mockResolvedValue(3n)
    const sourceClient = {
      getChainId: vi.fn().mockResolvedValue(42161),
      getBalance: vi.fn().mockResolvedValue(34n),
      getGasPrice: vi.fn().mockResolvedValue(5n),
      estimateContractGas,
      readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
        functionName === 'balanceOf' ? 100n : first.sourceAmount
      ),
    } as unknown as PublicClient
    const walletClient = { writeContract: vi.fn(), sendTransaction: vi.fn() }

    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        sourceClient,
        walletClient: walletClient as never,
        quotes: [first, second],
        refreshQuote: vi.fn(async (current) => current),
        getProviderStatus: vi.fn(),
        checkpointStore: emptyCheckpointStore(),
        destinationChainId: 314,
        getFilecoinBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
        waitForFilecoinArrival: vi.fn(),
      })
    ).rejects.toThrow('Insufficient source native gas')

    expect(estimateContractGas).toHaveBeenCalledTimes(1)
    expect(walletClient.writeContract).not.toHaveBeenCalled()
    expect(walletClient.sendTransaction).not.toHaveBeenCalled()
  })

  it('records exact bounded approval and route intents before each broadcast', async () => {
    const quote = executionQuote()
    const allowanceValues = [999n, 999n, quote.sourceAmount]
    const sourceClient = sourceClientForExecution(() => allowanceValues.shift() ?? quote.sourceAmount)
    const store = emptyCheckpointStore()
    const walletClient = {
      writeContract: vi.fn(async () => {
        expect(store.save).toHaveBeenCalledWith(
          expect.objectContaining({
            approvalIntent: expect.objectContaining({
              amount: quote.sourceAmount.toString(),
              gasLimit: '3',
              maxFeePerGas: '5',
            }),
          })
        )
        return '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      }),
      sendTransaction: vi.fn(async () => '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
    }

    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        sourceRpcUrl: 'https://unused.example/rpc',
        sourceClient,
        walletClient: walletClient as never,
        quotes: [quote],
        refreshQuote: vi.fn(async (current) => current),
        getProviderStatus: vi.fn().mockResolvedValue({ status: 'confirmed' }),
        checkpointStore: store,
        destinationChainId: 314,
        getFilecoinBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
        waitForFilecoinArrival: vi.fn(),
      })
    ).resolves.toHaveLength(1)

    expect(walletClient.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['0xce16F69375520ab01377ce7B88f5BA8C48F8D666', quote.sourceAmount],
        gas: 3n,
        maxFeePerGas: 5n,
        nonce: 8,
      })
    )
    expect(walletClient.sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ nonce: 8 }))
    expect(store.save).toHaveBeenCalledWith(
      expect.objectContaining({
        routeIntent: expect.objectContaining({
          target: quote.target,
          value: quote.value.toString(),
          gasLimit: quote.gasLimit.toString(),
          maxFeePerGas: quote.maxFeePerGas.toString(),
          dataHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        }),
      })
    )
  })

  it('replaces a stale allowance with each exact current leg amount, never an aggregate approval', async () => {
    const first = executionQuote()
    const second = { ...executionQuote(), id: 'execution-route-2', sourceAmount: 2n, destinationAmount: 4n }
    const allowanceValues = [first.sourceAmount, first.sourceAmount, first.sourceAmount, 0n, second.sourceAmount]
    const walletClient = {
      writeContract: vi.fn(async () => '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      sendTransaction: vi
        .fn()
        .mockResolvedValueOnce('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
        .mockResolvedValueOnce('0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'),
    }

    await executeTokenAcquisition({
      privateKey: PRIVATE_KEY,
      sourceRpcUrl: 'https://unused.example/rpc',
      sourceClient: sourceClientForExecution(() => allowanceValues.shift() ?? second.sourceAmount),
      walletClient: walletClient as never,
      quotes: [first, second],
      refreshQuote: vi.fn(async (current) => current),
      getProviderStatus: vi.fn().mockResolvedValue({ status: 'confirmed' }),
      checkpointStore: emptyCheckpointStore(),
      destinationChainId: 314,
      getFilecoinBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
      waitForFilecoinArrival: vi.fn(),
    })

    expect(walletClient.writeContract).toHaveBeenCalledTimes(1)
    expect(walletClient.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ args: ['0xce16F69375520ab01377ce7B88f5BA8C48F8D666', second.sourceAmount] })
    )
    expect(walletClient.sendTransaction).toHaveBeenCalledTimes(2)
  })

  it('rejects route source spend above the operator maximum before execution', () => {
    const quote: PlannedAcquisitionQuote = {
      id: 'over-cap',
      asset: 'usdfc',
      sourceAmount: 101n,
      destinationAmount: 1n,
      target: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
      data: '0x12',
      value: 0n,
      gasLimit: 1n,
      maxFeePerGas: 1n,
      expiresAt: 2_000_000_000,
      estimatedRouteDurationSeconds: 90,
    }

    expect(() => validateMaximumSourceSpend({ quotes: [quote], maxSourceAmount: 100n, maxNativeGas: 2n })).toThrow(
      '--max-source-amount'
    )
  })

  it('rejects a strict non-USDC checkpoint from legacy recovery before route handling', async () => {
    const chain = SELECTED_SOURCE_CHAINS.find((item) => item.chainId === 8453)
    if (chain == null) throw new Error('Base test chain missing')
    const source: ResolvedSourceToken = {
      chain,
      chainId: chain.chainId,
      token: '0x0000000000000000000000000000000000000003',
      symbol: 'USDbC',
      decimals: 8,
      native: false,
      display: 'Base USDbC',
    }
    const store = checkpointStore({
      version: 2,
      owner: SOURCE_OWNER,
      sourceChainId: source.chainId,
      destinationChainId: 314,
      source: sourceRouteIdentity(source),
      maxSourceAmount: 10n,
      maxNativeGas: sourceNativeGasCeiling(source.chainId),
      committedNativeGas: 0n,
      requiredWallet: { fil: 1n, usdfc: 1n },
      evidence: [],
    })
    const refreshQuote = vi.fn()
    const getProviderStatus = vi.fn()
    const walletClient = { writeContract: vi.fn(), sendTransaction: vi.fn() }

    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        sourceClient: { getChainId: vi.fn().mockResolvedValue(42161) } as unknown as PublicClient,
        walletClient: walletClient as never,
        quotes: [executionQuote()],
        refreshQuote,
        getProviderStatus,
        checkpointStore: store,
        destinationChainId: 314,
        getFilecoinBalances: vi.fn(),
        waitForFilecoinArrival: vi.fn(),
      })
    ).rejects.toThrow('requires the exact selected source')

    expect(refreshQuote).not.toHaveBeenCalled()
    expect(getProviderStatus).not.toHaveBeenCalled()
    expect(walletClient.writeContract).not.toHaveBeenCalled()
    expect(walletClient.sendTransaction).not.toHaveBeenCalled()
  })

  it('rejects an external-source checkpoint whose saved Filecoin target is below the current request', async () => {
    const chain = SELECTED_SOURCE_CHAINS.find((item) => item.chainId === 8453)
    if (chain == null) throw new Error('Base test chain missing')
    const source: ResolvedSourceToken = {
      chain,
      chainId: chain.chainId,
      token: '0x0000000000000000000000000000000000000003',
      symbol: 'USDbC',
      decimals: 8,
      native: false,
      display: 'Base USDbC',
    }
    const quote = {
      ...executionQuote(),
      value: 0n,
      source: sourceRouteIdentity(source),
      approvalSpender: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
    }
    const store = checkpointStore({
      version: 2,
      owner: SOURCE_OWNER,
      sourceChainId: source.chainId,
      destinationChainId: 314,
      source: sourceRouteIdentity(source),
      maxSourceAmount: 10n,
      maxNativeGas: sourceNativeGasCeiling(source.chainId),
      committedNativeGas: 0n,
      requiredWallet: { fil: 10n, usdfc: quote.destinationAmount },
      evidence: [],
    })
    const walletClient = { writeContract: vi.fn(), sendTransaction: vi.fn() }
    const refreshQuote = vi.fn()

    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        source,
        sourceClient: withResolvedErc20Identity(source, {
          getChainId: vi.fn().mockResolvedValue(chain.chainId),
        } as unknown as PublicClient),
        walletClient: walletClient as never,
        quotes: [quote],
        maxSourceAmount: 10n,
        requiredDestinationWallet: { fil: 11n, usdfc: quote.destinationAmount },
        refreshQuote,
        getProviderStatus: vi.fn(),
        checkpointStore: store,
        destinationChainId: 314,
        getFilecoinBalances: vi.fn(),
        waitForFilecoinArrival: vi.fn(),
      })
    ).rejects.toThrow('destination target')

    expect(refreshQuote).not.toHaveBeenCalled()
    expect(walletClient.writeContract).not.toHaveBeenCalled()
    expect(walletClient.sendTransaction).not.toHaveBeenCalled()
  })

  it('resumes a confirmed interrupted route from durable state without quoting or submitting another source transaction', async () => {
    const quote: PlannedAcquisitionQuote = {
      id: 'route-1',
      asset: 'usdfc',
      sourceAmount: 1_000_000n,
      destinationAmount: 1_000_000_000_000_000_000n,
      target: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
      data: '0x12',
      value: 0n,
      gasLimit: 1n,
      maxFeePerGas: 1n,
      expiresAt: 2_000_000_000,
      estimatedRouteDurationSeconds: 90,
    }
    const store = checkpointStore({
      version: 1,
      owner: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf' as const,
      sourceChainId: 42161,
      destinationChainId: 314,
      committedNativeGas: 0n,
      requiredWallet: { fil: 10n, usdfc: quote.destinationAmount },
      evidence: [
        {
          asset: 'usdfc',
          quoteId: quote.id,
          sourceAmount: quote.sourceAmount.toString(),
          sourceTransactionHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          status: 'submitted',
        },
      ],
    })
    const refreshQuote = vi.fn()
    const getProviderStatus = vi.fn().mockResolvedValue({ status: 'confirmed' as const })
    const waitForFilecoinArrival = vi.fn().mockResolvedValue(undefined)

    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        sourceRpcUrl: 'https://unused.example/rpc',
        sourceClient: {
          getChainId: vi.fn().mockResolvedValue(42161),
          waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
        } as unknown as PublicClient,
        quotes: [quote],
        refreshQuote,
        getProviderStatus,
        checkpointStore: store,
        destinationChainId: 314,
        getFilecoinBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
        waitForFilecoinArrival,
      })
    ).resolves.toMatchObject([{ status: 'confirmed' }])

    expect(refreshQuote).not.toHaveBeenCalled()
    expect(getProviderStatus).toHaveBeenCalledTimes(1)
    expect(waitForFilecoinArrival).toHaveBeenCalledWith({ fil: 10n, usdfc: quote.destinationAmount })
    expect(store.clear).toHaveBeenCalledTimes(1)
  })

  it('executes the remaining legacy route before waiting for a partial recovered target', async () => {
    const first = { ...executionQuote(), id: 'confirmed-fil', asset: 'fil' as const, sourceAmount: 10n }
    const second = {
      ...executionQuote(),
      id: 'remaining-usdfc',
      sourceAmount: 20n,
      destinationAmount: 4n,
    }
    const store = checkpointStore({
      version: 1,
      owner: SOURCE_OWNER,
      sourceChainId: 42161,
      destinationChainId: 314,
      committedNativeGas: 0n,
      requiredWallet: { fil: first.destinationAmount, usdfc: second.destinationAmount },
      evidence: [
        {
          asset: 'fil',
          quoteId: first.id,
          sourceAmount: first.sourceAmount.toString(),
          sourceTransactionHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          status: 'submitted',
        },
      ],
    })
    const walletClient = {
      writeContract: vi.fn(),
      sendTransaction: vi.fn().mockResolvedValue('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
    }
    const waitForFilecoinArrival = vi.fn(async () => {
      if (walletClient.sendTransaction.mock.calls.length === 0) {
        throw new Error('partial recovery waited before submitting its remaining route')
      }
    })

    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        sourceClient: sourceClientForExecution(() => second.sourceAmount),
        walletClient: walletClient as never,
        quotes: [first, second],
        maxSourceAmount: 100n,
        refreshQuote: vi.fn(async (current) => current),
        getProviderStatus: vi.fn().mockResolvedValue({ status: 'confirmed' as const }),
        checkpointStore: store,
        destinationChainId: 314,
        getFilecoinBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
        waitForFilecoinArrival,
      })
    ).resolves.toMatchObject([
      { asset: 'fil', status: 'confirmed' },
      { asset: 'usdfc', status: 'confirmed' },
    ])

    expect(walletClient.sendTransaction).toHaveBeenCalledTimes(1)
    expect(waitForFilecoinArrival).toHaveBeenCalledWith({
      fil: first.destinationAmount,
      usdfc: second.destinationAmount,
    })
    expect(store.clear).toHaveBeenCalledTimes(1)
  })

  it('clears a partial recovery when a delayed wallet top-up already meets its stored target', async () => {
    const first = { ...executionQuote(), id: 'recovered-fil', asset: 'fil' as const, destinationAmount: 3n }
    const second = { ...executionQuote(), id: 'unneeded-usdfc', destinationAmount: 4n }
    const store = checkpointStore({
      version: 1,
      owner: SOURCE_OWNER,
      sourceChainId: 42161,
      destinationChainId: 314,
      committedNativeGas: 0n,
      requiredWallet: { fil: first.destinationAmount, usdfc: second.destinationAmount },
      evidence: [
        {
          asset: 'fil',
          quoteId: first.id,
          sourceAmount: first.sourceAmount.toString(),
          sourceTransactionHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          status: 'submitted',
        },
      ],
    })
    const refreshQuote = vi.fn()
    const getProviderStatus = vi.fn()
    const walletClient = { writeContract: vi.fn(), sendTransaction: vi.fn() }

    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        sourceClient: {
          getChainId: vi.fn().mockResolvedValue(42161),
          waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
        } as unknown as PublicClient,
        walletClient: walletClient as never,
        quotes: [first, second],
        refreshQuote,
        getProviderStatus,
        checkpointStore: store,
        destinationChainId: 314,
        getFilecoinBalances: vi
          .fn()
          .mockResolvedValue({ fil: first.destinationAmount, usdfc: second.destinationAmount }),
        waitForFilecoinArrival: vi.fn(),
      })
    ).resolves.toMatchObject([{ asset: 'fil', status: 'confirmed' }])

    expect(getProviderStatus).not.toHaveBeenCalled()
    expect(refreshQuote).not.toHaveBeenCalled()
    expect(walletClient.writeContract).not.toHaveBeenCalled()
    expect(walletClient.sendTransaction).not.toHaveBeenCalled()
    expect(store.clear).toHaveBeenCalledTimes(1)
  })

  it('keeps a confirmed approval commitment after a crash and rejects the later route above the cumulative cap', async () => {
    const quote = {
      ...executionQuote(),
      value: 0n,
      gasLimit: 1n,
      maxFeePerGas: 11n,
    }
    const store = checkpointStore({
      version: 1,
      owner: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
      sourceChainId: 42161,
      destinationChainId: 314,
      committedNativeGas: MAX_SOURCE_NATIVE_GAS - 10n,
      approvalIntent: {
        nonce: 8,
        token: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
        spender: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
        amount: quote.sourceAmount.toString(),
        gasLimit: '1',
        maxFeePerGas: '1',
      },
      approvalTransactionHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      requiredWallet: { fil: 0n, usdfc: 0n },
      evidence: [],
    })
    const sourceClient = {
      getChainId: vi.fn().mockResolvedValue(42161),
      getBalance: vi.fn().mockResolvedValue(MAX_SOURCE_NATIVE_GAS * 2n),
      getGasPrice: vi.fn().mockResolvedValue(0n),
      getTransactionCount: vi.fn().mockResolvedValue(8),
      estimateContractGas: vi.fn().mockResolvedValue(0n),
      readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
        functionName === 'balanceOf' ? 100n : quote.sourceAmount
      ),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
    } as unknown as PublicClient
    const walletClient = { writeContract: vi.fn(), sendTransaction: vi.fn() }

    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        sourceClient,
        walletClient: walletClient as never,
        quotes: [quote],
        refreshQuote: vi.fn(async (current) => current),
        getProviderStatus: vi.fn(),
        checkpointStore: store,
        destinationChainId: 314,
        getFilecoinBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
        waitForFilecoinArrival: vi.fn(),
      })
    ).rejects.toThrow('source-native gas cap')

    expect(sourceClient.waitForTransactionReceipt).toHaveBeenCalledWith({
      hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    })
    expect(store.value).toMatchObject({ committedNativeGas: MAX_SOURCE_NATIVE_GAS - 10n })
    expect(store.value?.approvalIntent).toBeUndefined()
    expect(store.value?.approvalTransactionHash).toBeUndefined()
    expect(store.clear).not.toHaveBeenCalled()
    expect(walletClient.writeContract).not.toHaveBeenCalled()
    expect(walletClient.sendTransaction).not.toHaveBeenCalled()
  })

  it('clears a partial recovery when Filecoin balance proof meets its stored target', async () => {
    const first = { ...executionQuote(), id: 'first-fil-arrived', asset: 'fil' as const, sourceAmount: 10n }
    const second = {
      ...executionQuote(),
      id: 'second-usdfc-pending',
      sourceAmount: 20n,
      destinationAmount: 4n,
    }
    const store = checkpointStore({
      version: 1,
      owner: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
      sourceChainId: 42161,
      destinationChainId: 314,
      committedNativeGas: 0n,
      requiredWallet: { fil: first.destinationAmount, usdfc: 0n },
      evidence: [
        {
          asset: 'fil',
          quoteId: first.id,
          sourceAmount: first.sourceAmount.toString(),
          sourceTransactionHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          status: 'submitted',
        },
      ],
    })
    const walletClient = {
      writeContract: vi.fn(),
      sendTransaction: vi.fn().mockResolvedValue('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
    }
    const getProviderStatus = vi.fn(async (evidence: AcquisitionEvidence) =>
      evidence.asset === 'fil' ? { status: 'submitted' as const } : { status: 'confirmed' as const }
    )
    const getFilecoinBalances = vi.fn().mockResolvedValue({ fil: first.destinationAmount, usdfc: 0n })
    const waitForFilecoinArrival = vi.fn().mockResolvedValue(undefined)

    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        sourceClient: sourceClientForExecution(() => second.sourceAmount),
        walletClient: walletClient as never,
        quotes: [first, second],
        maxSourceAmount: 100n,
        refreshQuote: vi.fn(async (current) => current),
        getProviderStatus,
        checkpointStore: store,
        destinationChainId: 314,
        getFilecoinBalances,
        waitForFilecoinArrival,
      })
    ).resolves.toMatchObject([{ asset: 'fil', status: 'confirmed' }])

    expect(walletClient.sendTransaction).not.toHaveBeenCalled()
    expect(getProviderStatus).not.toHaveBeenCalled()
    expect(waitForFilecoinArrival).not.toHaveBeenCalled()
    expect(store.clear).toHaveBeenCalledTimes(1)
  })

  it('keeps a confirmed first route under the native cap and never broadcasts it again while resuming the second leg', async () => {
    const first = { ...executionQuote(), id: 'first-fil', asset: 'fil' as const, sourceAmount: 10n }
    const second = {
      ...executionQuote(),
      id: 'second-usdfc',
      sourceAmount: 20n,
      destinationAmount: 4n,
      value: 0n,
      gasLimit: 1n,
      maxFeePerGas: 11n,
    }
    const store = checkpointStore({
      version: 1,
      owner: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
      sourceChainId: 42161,
      destinationChainId: 314,
      committedNativeGas: MAX_SOURCE_NATIVE_GAS - 10n,
      requiredWallet: { fil: first.destinationAmount, usdfc: 0n },
      evidence: [
        {
          asset: 'fil',
          quoteId: first.id,
          sourceAmount: first.sourceAmount.toString(),
          sourceTransactionHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          status: 'submitted',
        },
      ],
    })
    const sourceClient = {
      getChainId: vi.fn().mockResolvedValue(42161),
      getBalance: vi.fn().mockResolvedValue(MAX_SOURCE_NATIVE_GAS * 2n),
      getGasPrice: vi.fn().mockResolvedValue(0n),
      getTransactionCount: vi.fn().mockResolvedValue(8),
      estimateContractGas: vi.fn().mockResolvedValue(0n),
      readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
        functionName === 'balanceOf' ? 100n : second.sourceAmount
      ),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
    } as unknown as PublicClient
    const walletClient = { writeContract: vi.fn(), sendTransaction: vi.fn() }
    const getProviderStatus = vi.fn().mockResolvedValue({ status: 'confirmed' as const })

    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        sourceClient,
        walletClient: walletClient as never,
        quotes: [first, second],
        maxSourceAmount: 100n,
        refreshQuote: vi.fn(async (current) => current),
        getProviderStatus,
        checkpointStore: store,
        destinationChainId: 314,
        getFilecoinBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
        waitForFilecoinArrival: vi.fn(),
      })
    ).rejects.toThrow('source-native gas cap')

    expect(getProviderStatus).toHaveBeenCalledTimes(1)
    expect(walletClient.sendTransaction).not.toHaveBeenCalled()
    expect(store.clear).not.toHaveBeenCalled()
  })

  it('keeps confirmed source input under --max-source-amount when a remaining-leg price changes on recovery', async () => {
    const first = { ...executionQuote(), id: 'first-fil-cap', asset: 'fil' as const, sourceAmount: 10n }
    const repricedSecond = { ...executionQuote(), id: 'second-usdfc-cap', sourceAmount: 41n, destinationAmount: 4n }
    const store = checkpointStore({
      version: 1,
      owner: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
      sourceChainId: 42161,
      destinationChainId: 314,
      committedNativeGas: 1n,
      requiredWallet: { fil: first.destinationAmount, usdfc: 0n },
      evidence: [
        {
          asset: 'fil',
          quoteId: first.id,
          sourceAmount: first.sourceAmount.toString(),
          sourceTransactionHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          status: 'submitted',
        },
      ],
    })
    const getProviderStatus = vi.fn().mockResolvedValue({ status: 'confirmed' as const })
    const walletClient = { writeContract: vi.fn(), sendTransaction: vi.fn() }

    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        sourceClient: {
          getChainId: vi.fn().mockResolvedValue(42161),
          waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
        } as unknown as PublicClient,
        walletClient: walletClient as never,
        quotes: [first, repricedSecond],
        maxSourceAmount: 50n,
        refreshQuote: vi.fn(),
        getProviderStatus,
        checkpointStore: store,
        destinationChainId: 314,
        getFilecoinBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
        waitForFilecoinArrival: vi.fn(),
      })
    ).rejects.toThrow('remaining --max-source-amount')

    expect(getProviderStatus).toHaveBeenCalledTimes(1)
    expect(walletClient.sendTransaction).not.toHaveBeenCalled()
    expect(store.clear).not.toHaveBeenCalled()
  })

  it('fails closed on a durable pre-broadcast approval or route intent instead of resubmitting', async () => {
    const sourceClient = {
      getChainId: vi.fn().mockResolvedValue(42161),
      waitForTransactionReceipt: vi.fn(),
    } as unknown as PublicClient
    const intents: Array<Pick<AcquisitionCheckpoint, 'approvalIntent' | 'routeIntent'>> = [
      {
        approvalIntent: {
          nonce: 8,
          token: '0x0000000000000000000000000000000000000001',
          spender: '0x0000000000000000000000000000000000000002',
          amount: '10',
          gasLimit: '100',
          maxFeePerGas: '2',
        },
      },
      {
        routeIntent: {
          nonce: 9,
          quoteId: 'route-9',
          asset: 'fil' as const,
          sourceAmount: '10',
          target: '0x0000000000000000000000000000000000000002',
          dataHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          value: '0',
          gasLimit: '100',
          maxFeePerGas: '2',
        },
      },
    ]
    for (const checkpoint of intents) {
      const store = checkpointStore({
        version: 1,
        owner: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
        sourceChainId: 42161,
        destinationChainId: 314,
        committedNativeGas: 0n,
        requiredWallet: { fil: 0n, usdfc: 0n },
        evidence: [],
        ...checkpoint,
      })
      await expect(
        executeTokenAcquisition({
          privateKey: PRIVATE_KEY,
          sourceRpcUrl: 'https://unused.example/rpc',
          sourceClient,
          quotes: [],
          refreshQuote: vi.fn(),
          getProviderStatus: vi.fn(),
          checkpointStore: store,
          destinationChainId: 314,
          getFilecoinBalances: vi.fn(),
          waitForFilecoinArrival: vi.fn(),
        })
      ).rejects.toThrow('pre-broadcast intent')
      expect(store.clear).not.toHaveBeenCalled()
    }
  })

  it('uses bounded Filecoin wallet polling against absolute readiness targets', async () => {
    const getBalances = vi
      .fn()
      .mockResolvedValueOnce({ fil: 9n, usdfc: 20n })
      .mockResolvedValueOnce({ fil: 10n, usdfc: 20n })
    const wait = vi.fn().mockResolvedValue(undefined)

    await waitForFilecoinWalletReadiness({
      required: { fil: 10n, usdfc: 20n },
      getBalances,
      attempts: 2,
      wait,
    })

    expect(getBalances).toHaveBeenCalledTimes(2)
    expect(wait).toHaveBeenCalledWith(5_000)
  })

  it('uses only remaining gas for a partial-rerun balance check while preserving the original destination proof', async () => {
    const chain = SELECTED_SOURCE_CHAINS.find((item) => item.chainId === 8453)
    if (chain == null) throw new Error('Base test chain missing')
    const source: ResolvedSourceToken = {
      chain,
      chainId: chain.chainId,
      token: '0x0000000000000000000000000000000000000003',
      symbol: 'USDbC',
      decimals: 8,
      native: false,
      display: 'Base USDbC',
    }
    const quote = {
      ...executionQuote(),
      id: 'remaining-usdfc',
      sourceAmount: 10n,
      destinationAmount: 20n,
      value: 0n,
      gasLimit: 10n,
      maxFeePerGas: 1n,
      source: sourceRouteIdentity(source),
      approvalSpender: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
    }
    const prior = {
      ...quote,
      id: 'confirmed-fil',
      asset: 'fil' as const,
      sourceAmount: 9n,
      destinationAmount: 30n,
    }
    const priorGas = 100n
    const store = checkpointStore({
      version: 2,
      owner: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
      sourceChainId: chain.chainId,
      destinationChainId: 314,
      source: sourceRouteIdentity(source),
      maxSourceAmount: 100n,
      maxNativeGas: sourceNativeGasCeiling(chain.chainId),
      committedNativeGas: priorGas,
      requiredWallet: { fil: prior.destinationAmount, usdfc: quote.destinationAmount },
      evidence: [
        {
          asset: 'fil',
          quoteId: prior.id,
          sourceAmount: prior.sourceAmount.toString(),
          sourceTransactionHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          status: 'submitted',
        },
      ],
    })
    const sourceClient = {
      getChainId: vi.fn().mockResolvedValue(chain.chainId),
      // The remaining route costs 10 and the conservative approval reservation costs 3; priorGas is already spent.
      getBalance: vi.fn().mockResolvedValue(13n),
      getGasPrice: vi.fn().mockResolvedValue(1n),
      getTransactionCount: vi.fn().mockResolvedValue(8),
      estimateContractGas: vi.fn().mockResolvedValue(3n),
      readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
        functionName === 'balanceOf' ? 10n : 10n
      ),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
    } as unknown as PublicClient
    const walletClient = {
      writeContract: vi.fn(),
      sendTransaction: vi.fn().mockResolvedValue('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
    }
    const waitForFilecoinArrival = vi.fn().mockResolvedValue(undefined)

    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        source,
        sourceClient: withResolvedErc20Identity(source, sourceClient),
        walletClient: walletClient as never,
        quotes: [prior, quote],
        maxSourceAmount: 100n,
        refreshQuote: vi.fn(async (current) => current),
        getProviderStatus: vi.fn().mockResolvedValue({ status: 'confirmed' as const }),
        checkpointStore: store,
        destinationChainId: 314,
        getFilecoinBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
        waitForFilecoinArrival,
      })
    ).resolves.toHaveLength(2)

    expect(walletClient.sendTransaction).toHaveBeenCalledTimes(1)
    expect(waitForFilecoinArrival).toHaveBeenCalledWith({
      fil: prior.destinationAmount,
      usdfc: quote.destinationAmount,
    })
  })

  it('refuses a provider target change after approval and never broadcasts the stale route', async () => {
    const chain = SELECTED_SOURCE_CHAINS.find((item) => item.chainId === 8453)
    if (chain == null) throw new Error('Base test chain missing')
    const source: ResolvedSourceToken = {
      chain,
      chainId: chain.chainId,
      token: '0x0000000000000000000000000000000000000003',
      symbol: 'USDbC',
      decimals: 8,
      native: false,
      display: 'Base USDbC',
    }
    const quote = {
      ...executionQuote(),
      sourceAmount: 100_000_000n,
      value: 0n,
      gasLimit: 1n,
      maxFeePerGas: 1n,
      source: sourceRouteIdentity(source),
      approvalSpender: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
    }
    const allowanceValues = [100_000_000n, 0n, 100_000_000n]
    const sourceClient = {
      getChainId: vi.fn().mockResolvedValue(chain.chainId),
      getBalance: vi.fn().mockResolvedValue(4n),
      getGasPrice: vi.fn().mockResolvedValue(1n),
      getTransactionCount: vi.fn().mockResolvedValue(8),
      estimateContractGas: vi.fn().mockResolvedValue(3n),
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === 'balanceOf') return 100_000_000n
        return allowanceValues.shift() as bigint
      }),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
    } as unknown as PublicClient
    const walletClient = {
      writeContract: vi.fn().mockResolvedValue('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      sendTransaction: vi.fn(),
    }

    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        source,
        sourceClient: withResolvedErc20Identity(source, sourceClient),
        walletClient: walletClient as never,
        quotes: [quote],
        maxSourceAmount: 1_000_000_000n,
        refreshQuote: vi
          .fn()
          .mockResolvedValueOnce(quote)
          .mockResolvedValueOnce({ ...quote, target: '0x0000000000000000000000000000000000000005' }),
        getProviderStatus: vi.fn(),
        checkpointStore: emptyCheckpointStore(),
        destinationChainId: 314,
        getFilecoinBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
        waitForFilecoinArrival: vi.fn(),
      })
    ).rejects.toThrow('trusted target/spender')

    expect(walletClient.writeContract).toHaveBeenCalledTimes(1)
    expect(walletClient.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ args: [quote.approvalSpender, 100_000_000n] })
    )
    expect(walletClient.sendTransaction).not.toHaveBeenCalled()
  })

  it('retains an approval-only checkpoint gas commitment when enforcing the rerun ceiling', async () => {
    const chain = SELECTED_SOURCE_CHAINS.find((item) => item.chainId === 8453)
    if (chain == null) throw new Error('Base test chain missing')
    const source: ResolvedSourceToken = {
      chain,
      chainId: chain.chainId,
      token: '0x0000000000000000000000000000000000000003',
      symbol: 'USDbC',
      decimals: 8,
      native: false,
      display: 'Base USDbC',
    }
    const quote = {
      ...executionQuote(),
      value: 0n,
      gasLimit: 2n,
      maxFeePerGas: 1n,
      source: sourceRouteIdentity(source),
      approvalSpender: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
    }
    const ceiling = sourceNativeGasCeiling(chain.chainId)
    const store = checkpointStore({
      version: 2,
      owner: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
      sourceChainId: chain.chainId,
      destinationChainId: 314,
      source: sourceRouteIdentity(source),
      maxSourceAmount: 10n,
      maxNativeGas: ceiling,
      committedNativeGas: ceiling - 1n,
      approvalTransactionHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      requiredWallet: { fil: 0n, usdfc: quote.destinationAmount },
      evidence: [],
    })
    const sourceClient = {
      getChainId: vi.fn().mockResolvedValue(chain.chainId),
      getBalance: vi.fn().mockResolvedValue(ceiling),
      getGasPrice: vi.fn().mockResolvedValue(1n),
      getTransactionCount: vi.fn().mockResolvedValue(8),
      estimateContractGas: vi.fn().mockResolvedValue(0n),
      readContract: vi.fn().mockResolvedValue(10n),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
    } as unknown as PublicClient
    const walletClient = { writeContract: vi.fn(), sendTransaction: vi.fn() }

    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        source,
        sourceClient: withResolvedErc20Identity(source, sourceClient),
        walletClient: walletClient as never,
        quotes: [quote],
        maxSourceAmount: 10n,
        refreshQuote: vi.fn(async (current) => current),
        getProviderStatus: vi.fn(),
        checkpointStore: store,
        destinationChainId: 314,
        getFilecoinBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
        waitForFilecoinArrival: vi.fn(),
      })
    ).rejects.toThrow('ceiling')

    expect(walletClient.writeContract).not.toHaveBeenCalled()
    expect(walletClient.sendTransaction).not.toHaveBeenCalled()
    expect(store.clear).not.toHaveBeenCalled()
  })

  it('persists partial provider status and URLs before refusing to resubmit the route', async () => {
    const chain = SELECTED_SOURCE_CHAINS.find((item) => item.chainId === 10)
    if (chain == null) throw new Error('Optimism test chain missing')
    const source: ResolvedSourceToken = {
      chain,
      chainId: chain.chainId,
      token: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      symbol: 'ETH',
      decimals: 18,
      native: true,
      display: 'Optimism ETH',
    }
    const quote = {
      ...executionQuote(),
      source: sourceRouteIdentity(source),
      approvalSpender: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
      value: 1n,
    }
    const store = emptyCheckpointStore()
    const walletClient = {
      writeContract: vi.fn(),
      sendTransaction: vi.fn().mockResolvedValue('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    }
    const nativeClient = {
      getChainId: vi.fn().mockResolvedValue(chain.chainId),
      getCode: vi.fn(),
      getBalance: vi.fn().mockResolvedValue(100n),
      getGasPrice: vi.fn().mockResolvedValue(1n),
      getTransactionCount: vi.fn().mockResolvedValue(8),
      estimateContractGas: vi.fn(),
      readContract: vi.fn(),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
    } as unknown as PublicClient
    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        source,
        sourceClient: nativeClient,
        walletClient: walletClient as never,
        quotes: [quote],
        maxSourceAmount: 10n,
        refreshQuote: vi.fn(async (current) => current),
        getProviderStatus: vi.fn().mockResolvedValue({
          status: 'partial' as const,
          sourceTransactionUrl: 'https://provider.example/source',
          providerExplorerUrl: 'https://provider.example/route',
        }),
        checkpointStore: store,
        destinationChainId: 314,
        getFilecoinBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
        waitForFilecoinArrival: vi.fn(),
      })
    ).rejects.toThrow('partial')

    expect(store.value?.evidence).toMatchObject([
      {
        status: 'partial',
        sourceTransactionUrl: 'https://provider.example/source',
        providerExplorerUrl: 'https://provider.example/route',
      },
    ])
    expect(nativeClient.getCode).not.toHaveBeenCalled()
    expect(nativeClient.readContract).not.toHaveBeenCalled()
    expect(walletClient.writeContract).not.toHaveBeenCalled()
    expect(store.clear).not.toHaveBeenCalled()
  })

  it.each([
    ['decimals', 7, 'USDbC', 'decimals conflict'],
    ['symbol', 8, 'WRONG', 'symbol conflicts'],
  ])('rejects a catalog %s mismatch before any source signing work', async (_field, decimals, symbol, error) => {
    const chain = SELECTED_SOURCE_CHAINS.find((item) => item.chainId === 8453)
    if (chain == null) throw new Error('Base test chain missing')
    const source: ResolvedSourceToken = {
      chain,
      chainId: chain.chainId,
      token: '0x0000000000000000000000000000000000000003',
      symbol: 'USDbC',
      decimals: 8,
      native: false,
      display: 'Base USDbC',
    }
    const quote = {
      ...executionQuote(),
      value: 0n,
      source: sourceRouteIdentity(source),
      approvalSpender: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
    }
    const estimateContractGas = vi.fn()
    const client = {
      getChainId: vi.fn().mockResolvedValue(chain.chainId),
      getCode: vi.fn().mockResolvedValue('0x01'),
      readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
        functionName === 'decimals' ? decimals : symbol
      ),
      getBalance: vi.fn(),
      getGasPrice: vi.fn(),
      estimateContractGas,
    } as unknown as PublicClient
    const walletClient = { writeContract: vi.fn(), sendTransaction: vi.fn() }

    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        source,
        sourceClient: client,
        walletClient: walletClient as never,
        quotes: [quote],
        maxSourceAmount: 10n,
        refreshQuote: vi.fn(),
        getProviderStatus: vi.fn(),
        checkpointStore: emptyCheckpointStore(),
        destinationChainId: 314,
        getFilecoinBalances: vi.fn(),
        waitForFilecoinArrival: vi.fn(),
      })
    ).rejects.toThrow(error)

    expect(estimateContractGas).not.toHaveBeenCalled()
    expect(walletClient.writeContract).not.toHaveBeenCalled()
    expect(walletClient.sendTransaction).not.toHaveBeenCalled()
  })

  it('rejects untrusted initial route targets and approval spenders before any signature', async () => {
    const chain = SELECTED_SOURCE_CHAINS.find((item) => item.chainId === 8453)
    if (chain == null) throw new Error('Base test chain missing')
    const source: ResolvedSourceToken = {
      chain,
      chainId: chain.chainId,
      token: '0x0000000000000000000000000000000000000003',
      symbol: 'USDbC',
      decimals: 8,
      native: false,
      display: 'Base USDbC',
    }
    const trustedQuote = {
      ...executionQuote(),
      value: 0n,
      source: sourceRouteIdentity(source),
      approvalSpender: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
    }
    for (const quote of [
      { ...trustedQuote, target: '0x0000000000000000000000000000000000000005' },
      { ...trustedQuote, approvalSpender: '0x0000000000000000000000000000000000000005' },
    ]) {
      const walletClient = { writeContract: vi.fn(), sendTransaction: vi.fn() }
      await expect(
        executeTokenAcquisition({
          privateKey: PRIVATE_KEY,
          source,
          sourceClient: withResolvedErc20Identity(source, {
            getChainId: vi.fn().mockResolvedValue(chain.chainId),
          } as unknown as PublicClient),
          walletClient: walletClient as never,
          quotes: [quote],
          maxSourceAmount: 10n,
          refreshQuote: vi.fn(),
          getProviderStatus: vi.fn(),
          checkpointStore: emptyCheckpointStore(),
          destinationChainId: 314,
          getFilecoinBalances: vi.fn(),
          waitForFilecoinArrival: vi.fn(),
        })
      ).rejects.toThrow('locally trusted')
      expect(walletClient.writeContract).not.toHaveBeenCalled()
      expect(walletClient.sendTransaction).not.toHaveBeenCalled()
    }
  })

  it.each([
    ['source owner', { sourceOwner: OWNER }],
    ['destination', { destinationAddress: OWNER }],
  ])('rejects a refreshed %s binding before any route signature', async (_name, changedBinding) => {
    const chain = SELECTED_SOURCE_CHAINS.find((item) => item.chainId === 42161)
    if (chain == null) throw new Error('Arbitrum test chain missing')
    const source: ResolvedSourceToken = {
      chain,
      chainId: chain.chainId,
      token: '0x0000000000000000000000000000000000000003',
      symbol: 'USDC',
      decimals: 6,
      native: false,
      display: 'Arbitrum USDC',
    }
    const quote = {
      ...executionQuote(),
      value: 0n,
      source: sourceRouteIdentity(source),
      approvalSpender: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
    }
    const walletClient = { writeContract: vi.fn(), sendTransaction: vi.fn() }

    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        source,
        sourceClient: withResolvedErc20Identity(
          source,
          sourceClientForExecution(() => quote.sourceAmount)
        ),
        walletClient: walletClient as never,
        quotes: [quote],
        maxSourceAmount: 10n,
        refreshQuote: vi.fn(async () => ({ ...quote, ...changedBinding })),
        getProviderStatus: vi.fn(),
        checkpointStore: emptyCheckpointStore(),
        destinationChainId: 314,
        getFilecoinBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
        waitForFilecoinArrival: vi.fn(),
      })
    ).rejects.toThrow('owner or destination changed')

    expect(walletClient.writeContract).not.toHaveBeenCalled()
    expect(walletClient.sendTransaction).not.toHaveBeenCalled()
  })

  it('rechecks Filecoin native balance against a higher post-refresh route cost before signing', async () => {
    const chain = SELECTED_SOURCE_CHAINS.find((item) => item.chainId === 314)
    if (chain == null) throw new Error('Filecoin test chain missing')
    const source: ResolvedSourceToken = {
      chain,
      chainId: chain.chainId,
      token: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      symbol: 'FIL',
      decimals: 18,
      native: true,
      display: 'Filecoin FIL',
    }
    const quote = {
      ...executionQuote(),
      value: 1n,
      gasLimit: 1n,
      maxFeePerGas: 1n,
      source: sourceRouteIdentity(source),
      approvalSpender: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
    }
    const client = {
      getChainId: vi.fn().mockResolvedValue(chain.chainId),
      getBalance: vi.fn().mockResolvedValueOnce(100n).mockResolvedValueOnce(100n).mockResolvedValueOnce(15n),
      getGasPrice: vi.fn().mockResolvedValue(1n),
      getTransactionCount: vi.fn().mockResolvedValue(8),
      estimateContractGas: vi.fn(),
      readContract: vi.fn(),
      waitForTransactionReceipt: vi.fn(),
    } as unknown as PublicClient
    const walletClient = { writeContract: vi.fn(), sendTransaction: vi.fn() }

    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        source,
        sourceClient: client,
        walletClient: walletClient as never,
        quotes: [quote],
        maxSourceAmount: 10n,
        requiredFilecoinReserve: 10n,
        requiredDestinationWallet: { fil: 10n, usdfc: quote.destinationAmount },
        refreshQuote: vi.fn(async (current) => ({ ...current, gasLimit: 5n })),
        getProviderStatus: vi.fn(),
        checkpointStore: emptyCheckpointStore(),
        destinationChainId: 314,
        getFilecoinBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
        waitForFilecoinArrival: vi.fn(),
      })
    ).rejects.toThrow('FIL reserve')

    expect(walletClient.sendTransaction).not.toHaveBeenCalled()
  })

  it('rejects an injected same-asset Filecoin route before any signing-capable RPC call', async () => {
    const chain = SELECTED_SOURCE_CHAINS.find((item) => item.chainId === 314)
    if (chain == null) throw new Error('Filecoin test chain missing')
    const source: ResolvedSourceToken = {
      chain,
      chainId: chain.chainId,
      token: FILECOIN_NATIVE_TOKEN,
      symbol: 'FIL',
      decimals: 18,
      native: true,
      display: 'Filecoin FIL',
    }
    const quote = { ...executionQuote(), asset: 'fil' as const, source: sourceRouteIdentity(source) }
    const getBalance = vi.fn()
    const getTransactionCount = vi.fn()
    const walletClient = { writeContract: vi.fn(), sendTransaction: vi.fn() }

    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        source,
        sourceClient: {
          getChainId: vi.fn().mockResolvedValue(chain.chainId),
          getBalance,
          getTransactionCount,
        } as unknown as PublicClient,
        walletClient: walletClient as never,
        quotes: [quote],
        maxSourceAmount: 10n,
        refreshQuote: vi.fn(),
        getProviderStatus: vi.fn(),
        checkpointStore: emptyCheckpointStore(),
        destinationChainId: 314,
        getFilecoinBalances: vi.fn(),
        waitForFilecoinArrival: vi.fn(),
      })
    ).rejects.toThrow('cannot fund the same wallet shortfall')

    expect(getBalance).not.toHaveBeenCalled()
    expect(getTransactionCount).not.toHaveBeenCalled()
    expect(walletClient.writeContract).not.toHaveBeenCalled()
    expect(walletClient.sendTransaction).not.toHaveBeenCalled()
  })

  it('does not repoll confirmed strict recovery evidence before executing the remaining leg', async () => {
    const chain = SELECTED_SOURCE_CHAINS.find((item) => item.chainId === 8453)
    if (chain == null) throw new Error('Base test chain missing')
    const source: ResolvedSourceToken = {
      chain,
      chainId: chain.chainId,
      token: '0x0000000000000000000000000000000000000003',
      symbol: 'USDbC',
      decimals: 8,
      native: false,
      display: 'Base USDbC',
    }
    const routeFields = {
      value: 0n,
      gasLimit: 1n,
      maxFeePerGas: 1n,
      source: sourceRouteIdentity(source),
      approvalSpender: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
      sourceOwner: SOURCE_OWNER,
      destinationAddress: SOURCE_OWNER,
    }
    const first = { ...executionQuote(), ...routeFields, id: 'confirmed-fil', asset: 'fil' as const }
    const second = { ...executionQuote(), ...routeFields, id: 'remaining-usdfc' }
    const store = checkpointStore({
      version: 2,
      owner: SOURCE_OWNER,
      sourceChainId: source.chainId,
      destinationChainId: 314,
      source: sourceRouteIdentity(source),
      maxSourceAmount: 10n,
      maxNativeGas: sourceNativeGasCeiling(source.chainId),
      committedNativeGas: 0n,
      requiredWallet: { fil: first.destinationAmount, usdfc: second.destinationAmount },
      evidence: [
        {
          asset: 'fil',
          quoteId: first.id,
          sourceAmount: first.sourceAmount.toString(),
          sourceTransactionHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          status: 'confirmed',
        },
      ],
    })
    const getProviderStatus = vi.fn().mockResolvedValue({ status: 'confirmed' as const })
    const walletClient = {
      writeContract: vi.fn(),
      sendTransaction: vi.fn().mockResolvedValue('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
    }
    const client = {
      getChainId: vi.fn().mockResolvedValue(chain.chainId),
      getCode: vi.fn().mockResolvedValue('0x01'),
      getBalance: vi.fn().mockResolvedValue(100n),
      getGasPrice: vi.fn().mockResolvedValue(1n),
      getTransactionCount: vi.fn().mockResolvedValue(8),
      estimateContractGas: vi.fn(),
      readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
        functionName === 'balanceOf' ? 100n : second.sourceAmount
      ),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
    } as unknown as PublicClient

    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        source,
        sourceClient: withResolvedErc20Identity(source, client),
        walletClient: walletClient as never,
        quotes: [first, second],
        maxSourceAmount: 10n,
        refreshQuote: vi.fn(async (quote) => quote),
        getProviderStatus,
        checkpointStore: store,
        destinationChainId: 314,
        getFilecoinBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
        waitForFilecoinArrival: vi.fn(),
      })
    ).resolves.toMatchObject([
      { asset: 'fil', status: 'confirmed' },
      { asset: 'usdfc', status: 'confirmed' },
    ])

    expect(getProviderStatus).toHaveBeenCalledTimes(1)
    expect(getProviderStatus).toHaveBeenCalledWith(expect.objectContaining({ quoteId: second.id }))
    expect(walletClient.sendTransaction).toHaveBeenCalledTimes(1)
  })

  it('reserves later strict-route gas when a post-approval refresh raises the current cost', async () => {
    const chain = SELECTED_SOURCE_CHAINS.find((item) => item.chainId === 8453)
    if (chain == null) throw new Error('Base test chain missing')
    const source: ResolvedSourceToken = {
      chain,
      chainId: chain.chainId,
      token: '0x0000000000000000000000000000000000000003',
      symbol: 'USDbC',
      decimals: 8,
      native: false,
      display: 'Base USDbC',
    }
    const first = {
      ...executionQuote(),
      id: 'strict-first-refresh-cap',
      asset: 'fil' as const,
      value: 0n,
      gasLimit: 1n,
      maxFeePerGas: 1n,
      source: sourceRouteIdentity(source),
      approvalSpender: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
    }
    const second = {
      ...first,
      id: 'strict-second-refresh-cap',
      asset: 'usdfc' as const,
    }
    const ceiling = sourceNativeGasCeiling(chain.chainId)
    let firstRefreshes = 0
    const client = {
      getChainId: vi.fn().mockResolvedValue(chain.chainId),
      getBalance: vi.fn().mockResolvedValue(ceiling * 2n),
      getGasPrice: vi.fn().mockResolvedValue(1n),
      getTransactionCount: vi.fn().mockResolvedValue(8),
      estimateContractGas: vi.fn().mockResolvedValue(1n),
      readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
        functionName === 'balanceOf' ? 100n : first.sourceAmount
      ),
      waitForTransactionReceipt: vi.fn(),
    } as unknown as PublicClient
    const walletClient = { writeContract: vi.fn(), sendTransaction: vi.fn() }

    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        source,
        sourceClient: withResolvedErc20Identity(source, client),
        walletClient: walletClient as never,
        quotes: [first, second],
        maxSourceAmount: 10n,
        refreshQuote: vi.fn(async (quote) => {
          if (quote.id !== first.id || ++firstRefreshes === 1) return quote
          return { ...quote, gasLimit: ceiling }
        }),
        getProviderStatus: vi.fn(),
        checkpointStore: emptyCheckpointStore(),
        destinationChainId: 314,
        getFilecoinBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
        waitForFilecoinArrival: vi.fn(),
      })
    ).rejects.toThrow('exceeds chain 8453 ceiling')

    expect(walletClient.writeContract).not.toHaveBeenCalled()
    expect(walletClient.sendTransaction).not.toHaveBeenCalled()
  })

  it('reserves later strict-route gas against the native balance before signing', async () => {
    const chain = SELECTED_SOURCE_CHAINS.find((item) => item.chainId === 8453)
    if (chain == null) throw new Error('Base test chain missing')
    const source: ResolvedSourceToken = {
      chain,
      chainId: chain.chainId,
      token: '0x0000000000000000000000000000000000000003',
      symbol: 'USDbC',
      decimals: 8,
      native: false,
      display: 'Base USDbC',
    }
    const first = {
      ...executionQuote(),
      id: 'strict-first-refresh-balance',
      asset: 'fil' as const,
      value: 0n,
      gasLimit: 1n,
      maxFeePerGas: 1n,
      source: sourceRouteIdentity(source),
      approvalSpender: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
    }
    const second = {
      ...first,
      id: 'strict-second-refresh-balance',
      asset: 'usdfc' as const,
      gasLimit: 10n,
    }
    const client = {
      getChainId: vi.fn().mockResolvedValue(chain.chainId),
      getBalance: vi.fn().mockResolvedValue(15n),
      getGasPrice: vi.fn().mockResolvedValue(1n),
      getTransactionCount: vi.fn().mockResolvedValue(8),
      estimateContractGas: vi.fn().mockResolvedValue(1n),
      readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
        functionName === 'balanceOf' ? 100n : first.sourceAmount
      ),
      waitForTransactionReceipt: vi.fn(),
    } as unknown as PublicClient
    const walletClient = { writeContract: vi.fn(), sendTransaction: vi.fn() }
    let firstRefreshes = 0

    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        source,
        sourceClient: withResolvedErc20Identity(source, client),
        walletClient: walletClient as never,
        quotes: [first, second],
        maxSourceAmount: 10n,
        refreshQuote: vi.fn(async (quote) => {
          if (quote.id !== first.id || ++firstRefreshes === 1) return quote
          return { ...quote, gasLimit: 10n }
        }),
        getProviderStatus: vi.fn(),
        checkpointStore: emptyCheckpointStore(),
        destinationChainId: 314,
        getFilecoinBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
        waitForFilecoinArrival: vi.fn(),
      })
    ).rejects.toThrow('Insufficient source native balance for the next signed action')

    expect(walletClient.writeContract).not.toHaveBeenCalled()
    expect(walletClient.sendTransaction).not.toHaveBeenCalled()
  })

  it('reserves the second strict-leg approval after an exact first allowance before signing', async () => {
    const chain = SELECTED_SOURCE_CHAINS.find((item) => item.chainId === 8453)
    if (chain == null) throw new Error('Base test chain missing')
    const source: ResolvedSourceToken = {
      chain,
      chainId: chain.chainId,
      token: '0x0000000000000000000000000000000000000003',
      symbol: 'USDbC',
      decimals: 8,
      native: false,
      display: 'Base USDbC',
    }
    const first = {
      ...executionQuote(),
      id: 'strict-first-approval-cap',
      asset: 'fil' as const,
      value: 0n,
      gasLimit: 1n,
      maxFeePerGas: 1n,
      source: sourceRouteIdentity(source),
      approvalSpender: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
    }
    const second = { ...first, id: 'strict-second-approval-cap', asset: 'usdfc' as const, sourceAmount: 2n }
    const estimateContractGas = vi.fn().mockResolvedValue(sourceNativeGasCeiling(chain.chainId))
    const client = {
      getChainId: vi.fn().mockResolvedValue(chain.chainId),
      getBalance: vi.fn().mockResolvedValue(sourceNativeGasCeiling(chain.chainId) * 2n),
      getGasPrice: vi.fn().mockResolvedValue(1n),
      getTransactionCount: vi.fn(),
      estimateContractGas,
      readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
        functionName === 'balanceOf' ? 100n : first.sourceAmount
      ),
      waitForTransactionReceipt: vi.fn(),
    } as unknown as PublicClient
    const walletClient = { writeContract: vi.fn(), sendTransaction: vi.fn() }

    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        source,
        sourceClient: withResolvedErc20Identity(source, client),
        walletClient: walletClient as never,
        quotes: [first, second],
        maxSourceAmount: 10n,
        refreshQuote: vi.fn(async (quote) => quote),
        getProviderStatus: vi.fn(),
        checkpointStore: emptyCheckpointStore(),
        destinationChainId: 314,
        getFilecoinBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
        waitForFilecoinArrival: vi.fn(),
      })
    ).rejects.toThrow('exceeds chain 8453 ceiling')

    expect(estimateContractGas).toHaveBeenCalledWith(
      expect.objectContaining({ args: [second.approvalSpender, second.sourceAmount] })
    )
    expect(walletClient.writeContract).not.toHaveBeenCalled()
    expect(walletClient.sendTransaction).not.toHaveBeenCalled()
  })

  it('reserves the second strict-leg approval against the native balance before signing', async () => {
    const chain = SELECTED_SOURCE_CHAINS.find((item) => item.chainId === 8453)
    if (chain == null) throw new Error('Base test chain missing')
    const source: ResolvedSourceToken = {
      chain,
      chainId: chain.chainId,
      token: '0x0000000000000000000000000000000000000003',
      symbol: 'USDbC',
      decimals: 8,
      native: false,
      display: 'Base USDbC',
    }
    const first = {
      ...executionQuote(),
      id: 'strict-first-approval-balance',
      asset: 'fil' as const,
      value: 0n,
      gasLimit: 1n,
      maxFeePerGas: 1n,
      source: sourceRouteIdentity(source),
      approvalSpender: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
    }
    const second = {
      ...first,
      id: 'strict-second-approval-balance',
      asset: 'usdfc' as const,
      sourceAmount: 2n,
    }
    const estimateContractGas = vi.fn().mockResolvedValue(10n)
    const client = {
      getChainId: vi.fn().mockResolvedValue(chain.chainId),
      getBalance: vi.fn().mockResolvedValue(11n),
      getGasPrice: vi.fn().mockResolvedValue(1n),
      getTransactionCount: vi.fn(),
      estimateContractGas,
      readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
        functionName === 'balanceOf' ? 100n : 0n
      ),
      waitForTransactionReceipt: vi.fn(),
    } as unknown as PublicClient
    const walletClient = { writeContract: vi.fn(), sendTransaction: vi.fn() }

    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        source,
        sourceClient: withResolvedErc20Identity(source, client),
        walletClient: walletClient as never,
        quotes: [first, second],
        maxSourceAmount: 10n,
        refreshQuote: vi.fn(async (quote) => quote),
        getProviderStatus: vi.fn(),
        checkpointStore: emptyCheckpointStore(),
        destinationChainId: 314,
        getFilecoinBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
        waitForFilecoinArrival: vi.fn(),
      })
    ).rejects.toThrow('Insufficient source native balance for route value and selected-chain gas ceiling')

    expect(estimateContractGas).toHaveBeenCalledWith(
      expect.objectContaining({ args: [second.approvalSpender, second.sourceAmount] })
    )
    expect(walletClient.writeContract).not.toHaveBeenCalled()
    expect(walletClient.sendTransaction).not.toHaveBeenCalled()
  })

  it('does not preflight a later reset-required approval against a stale nonzero allowance', async () => {
    const chain = SELECTED_SOURCE_CHAINS.find((item) => item.chainId === 8453)
    if (chain == null) throw new Error('Base test chain missing')
    const source: ResolvedSourceToken = {
      chain,
      chainId: chain.chainId,
      token: '0x0000000000000000000000000000000000000003',
      symbol: 'USDbC',
      decimals: 8,
      native: false,
      display: 'Base USDbC',
    }
    const first = {
      ...executionQuote(),
      id: 'strict-first-reset-required',
      asset: 'fil' as const,
      value: 0n,
      gasLimit: 1n,
      maxFeePerGas: 1n,
      source: sourceRouteIdentity(source),
      approvalSpender: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
    }
    const second = {
      ...first,
      id: 'strict-second-reset-required',
      asset: 'usdfc' as const,
      sourceAmount: 2n,
      gasLimit: sourceNativeGasCeiling(chain.chainId),
    }
    const estimateContractGas = vi.fn(async ({ args }: { args: readonly unknown[] }) => {
      if (args[1] === second.sourceAmount) throw new Error('must reset allowance first')
      return 1n
    })
    const client = {
      getChainId: vi.fn().mockResolvedValue(chain.chainId),
      getBalance: vi.fn().mockResolvedValue(100n),
      getGasPrice: vi.fn().mockResolvedValue(1n),
      getTransactionCount: vi.fn(),
      estimateContractGas,
      readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
        functionName === 'balanceOf' ? 100n : 3n
      ),
      waitForTransactionReceipt: vi.fn(),
    } as unknown as PublicClient
    const walletClient = { writeContract: vi.fn(), sendTransaction: vi.fn() }

    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        source,
        sourceClient: withResolvedErc20Identity(source, client),
        walletClient: walletClient as never,
        quotes: [first, second],
        maxSourceAmount: 10n,
        refreshQuote: vi.fn(async (quote) => quote),
        getProviderStatus: vi.fn(),
        checkpointStore: emptyCheckpointStore(),
        destinationChainId: 314,
        getFilecoinBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
        waitForFilecoinArrival: vi.fn(),
      })
    ).rejects.toThrow('exceeds chain 8453 ceiling')

    expect(estimateContractGas).toHaveBeenCalledWith(expect.objectContaining({ args: [first.approvalSpender, 0n] }))
    expect(estimateContractGas).not.toHaveBeenCalledWith(
      expect.objectContaining({ args: [second.approvalSpender, second.sourceAmount] })
    )
    expect(walletClient.writeContract).not.toHaveBeenCalled()
    expect(walletClient.sendTransaction).not.toHaveBeenCalled()
  })

  it('requires a rerun after a reset-required strict approval before exact approval or routing', async () => {
    const chain = SELECTED_SOURCE_CHAINS.find((item) => item.chainId === 8453)
    if (chain == null) throw new Error('Base test chain missing')
    const source: ResolvedSourceToken = {
      chain,
      chainId: chain.chainId,
      token: '0x0000000000000000000000000000000000000003',
      symbol: 'USDbC',
      decimals: 8,
      native: false,
      display: 'Base USDbC',
    }
    const quote = {
      ...executionQuote(),
      value: 0n,
      gasLimit: 1n,
      maxFeePerGas: 1n,
      source: sourceRouteIdentity(source),
      approvalSpender: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
    }
    let allowance = 2n
    const estimateContractGas = vi.fn(async ({ args }: { args: readonly unknown[] }) => {
      if (args[1] === quote.sourceAmount && allowance > 0n) throw new Error('reset required')
      return 1n
    })
    const client = {
      getChainId: vi.fn().mockResolvedValue(chain.chainId),
      getBalance: vi.fn().mockResolvedValue(100n),
      getGasPrice: vi.fn().mockResolvedValue(1n),
      getTransactionCount: vi.fn().mockResolvedValue(8),
      estimateContractGas,
      readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
        functionName === 'balanceOf' ? quote.sourceAmount : allowance
      ),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
    } as unknown as PublicClient
    const walletClient = {
      writeContract: vi.fn(async ({ args }: { args: readonly [string, bigint] }) => {
        allowance = args[1]
        return '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      }),
      sendTransaction: vi.fn().mockResolvedValue('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
    }

    const options = {
      privateKey: PRIVATE_KEY,
      source,
      sourceClient: withResolvedErc20Identity(source, client),
      walletClient: walletClient as never,
      quotes: [quote],
      maxSourceAmount: 10n,
      refreshQuote: vi.fn(async (current) => current),
      getProviderStatus: vi.fn().mockResolvedValue({ status: 'confirmed' as const }),
      checkpointStore: emptyCheckpointStore(),
      destinationChainId: 314,
      getFilecoinBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
      waitForFilecoinArrival: vi.fn(),
    }

    await expect(executeTokenAcquisition(options)).rejects.toThrow('allowance reset is confirmed; rerun acquisition')

    expect(walletClient.writeContract).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ args: [quote.approvalSpender, 0n] })
    )
    expect(walletClient.writeContract).toHaveBeenCalledTimes(1)
    expect(walletClient.sendTransaction).not.toHaveBeenCalled()

    await expect(executeTokenAcquisition(options)).resolves.toHaveLength(1)

    expect(walletClient.writeContract).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ args: [quote.approvalSpender, quote.sourceAmount] })
    )
    expect(walletClient.sendTransaction).toHaveBeenCalledTimes(1)
  })

  it('executes a strict ERC-20 route with exact allowance and provider-required native value', async () => {
    const chain = SELECTED_SOURCE_CHAINS.find((item) => item.chainId === 8453)
    if (chain == null) throw new Error('Base test chain missing')
    const source: ResolvedSourceToken = {
      chain,
      chainId: chain.chainId,
      token: '0x0000000000000000000000000000000000000003',
      symbol: 'USDbC',
      decimals: 8,
      native: false,
      display: 'Base USDbC',
    }
    const quote = {
      ...executionQuote(),
      value: 1n,
      gasLimit: 1n,
      maxFeePerGas: 1n,
      source: sourceRouteIdentity(source),
      approvalSpender: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
    }
    const estimateContractGas = vi.fn().mockResolvedValue(100n)
    const client = {
      getChainId: vi.fn().mockResolvedValue(chain.chainId),
      getBalance: vi.fn().mockResolvedValue(2n),
      getGasPrice: vi.fn().mockResolvedValue(1n),
      getTransactionCount: vi.fn().mockResolvedValue(8),
      estimateContractGas,
      readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
        functionName === 'balanceOf' ? quote.sourceAmount : quote.sourceAmount
      ),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
    } as unknown as PublicClient
    const walletClient = {
      writeContract: vi.fn(),
      sendTransaction: vi.fn().mockResolvedValue('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    }

    const store = emptyCheckpointStore()
    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        source,
        sourceClient: withResolvedErc20Identity(source, client),
        walletClient: walletClient as never,
        quotes: [quote],
        maxSourceAmount: 10n,
        refreshQuote: vi.fn(async (current) => current),
        getProviderStatus: vi.fn().mockResolvedValue({ status: 'confirmed' as const }),
        checkpointStore: store,
        destinationChainId: 314,
        getFilecoinBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
        waitForFilecoinArrival: vi.fn(),
      })
    ).resolves.toHaveLength(1)

    expect(estimateContractGas).not.toHaveBeenCalled()
    expect(walletClient.writeContract).not.toHaveBeenCalled()
    expect(walletClient.sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ value: quote.value }))
    expect(store.save).toHaveBeenCalledWith(expect.objectContaining({ committedNativeGas: 2n }))
  })

  it.each([
    {
      name: 'native commitment cap',
      value: sourceNativeGasCeiling(8453),
      nativeBalance: sourceNativeGasCeiling(8453) * 2n,
      error: 'exceeds chain 8453 ceiling',
    },
    {
      name: 'native balance',
      value: 2n,
      nativeBalance: 2n,
      error: 'Insufficient source native balance for route value and selected-chain gas ceiling',
    },
  ])('rejects a fresh strict ERC-20 route that exceeds the $name before any broadcast', async (scenario) => {
    const chain = SELECTED_SOURCE_CHAINS.find((item) => item.chainId === 8453)
    if (chain == null) throw new Error('Base test chain missing')
    const source: ResolvedSourceToken = {
      chain,
      chainId: chain.chainId,
      token: '0x0000000000000000000000000000000000000003',
      symbol: 'USDbC',
      decimals: 8,
      native: false,
      display: 'Base USDbC',
    }
    const quote = {
      ...executionQuote(),
      value: scenario.value,
      gasLimit: 1n,
      maxFeePerGas: 1n,
      source: sourceRouteIdentity(source),
      approvalSpender: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
    }
    const client = {
      getChainId: vi.fn().mockResolvedValue(chain.chainId),
      getBalance: vi.fn().mockResolvedValue(scenario.nativeBalance),
      getGasPrice: vi.fn().mockResolvedValue(1n),
      getTransactionCount: vi.fn().mockResolvedValue(8),
      estimateContractGas: vi.fn(),
      readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
        functionName === 'balanceOf' ? quote.sourceAmount : quote.sourceAmount
      ),
      waitForTransactionReceipt: vi.fn(),
    } as unknown as PublicClient
    const walletClient = { writeContract: vi.fn(), sendTransaction: vi.fn() }

    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        source,
        sourceClient: withResolvedErc20Identity(source, client),
        walletClient: walletClient as never,
        quotes: [quote],
        maxSourceAmount: 10n,
        refreshQuote: vi.fn(async (current) => current),
        getProviderStatus: vi.fn(),
        checkpointStore: emptyCheckpointStore(),
        destinationChainId: 314,
        getFilecoinBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
        waitForFilecoinArrival: vi.fn(),
      })
    ).rejects.toThrow(scenario.error)

    expect(walletClient.writeContract).not.toHaveBeenCalled()
    expect(walletClient.sendTransaction).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'native commitment cap',
      value: sourceNativeGasCeiling(8453),
      nativeBalances: [sourceNativeGasCeiling(8453) * 2n],
      error: 'exceeds chain 8453 ceiling',
    },
    {
      name: 'native balance',
      value: 2n,
      nativeBalances: [100n, 2n],
      error: 'Insufficient source native balance for the next signed action',
    },
  ])('rejects a post-refresh strict ERC-20 $name increase before any broadcast', async (scenario) => {
    const chain = SELECTED_SOURCE_CHAINS.find((item) => item.chainId === 8453)
    if (chain == null) throw new Error('Base test chain missing')
    const source: ResolvedSourceToken = {
      chain,
      chainId: chain.chainId,
      token: '0x0000000000000000000000000000000000000003',
      symbol: 'USDbC',
      decimals: 8,
      native: false,
      display: 'Base USDbC',
    }
    const quote = {
      ...executionQuote(),
      value: 0n,
      gasLimit: 1n,
      maxFeePerGas: 1n,
      source: sourceRouteIdentity(source),
      approvalSpender: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
    }
    const nativeBalances = [...scenario.nativeBalances]
    const client = {
      getChainId: vi.fn().mockResolvedValue(chain.chainId),
      getBalance: vi.fn(async () => nativeBalances.shift() ?? 0n),
      getGasPrice: vi.fn().mockResolvedValue(1n),
      getTransactionCount: vi.fn().mockResolvedValue(8),
      estimateContractGas: vi.fn(),
      readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
        functionName === 'balanceOf' ? quote.sourceAmount : quote.sourceAmount
      ),
      waitForTransactionReceipt: vi.fn(),
    } as unknown as PublicClient
    const walletClient = { writeContract: vi.fn(), sendTransaction: vi.fn() }
    let refreshes = 0

    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        source,
        sourceClient: withResolvedErc20Identity(source, client),
        walletClient: walletClient as never,
        quotes: [quote],
        maxSourceAmount: 10n,
        refreshQuote: vi.fn(async (current) => (++refreshes === 1 ? current : { ...current, value: scenario.value })),
        getProviderStatus: vi.fn(),
        checkpointStore: emptyCheckpointStore(),
        destinationChainId: 314,
        getFilecoinBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
        waitForFilecoinArrival: vi.fn(),
      })
    ).rejects.toThrow(scenario.error)

    expect(walletClient.writeContract).not.toHaveBeenCalled()
    expect(walletClient.sendTransaction).not.toHaveBeenCalled()
  })

  it('preflights a zero allowance with the exact approval that can be signed now', async () => {
    const chain = SELECTED_SOURCE_CHAINS.find((item) => item.chainId === 8453)
    if (chain == null) throw new Error('Base test chain missing')
    const source: ResolvedSourceToken = {
      chain,
      chainId: chain.chainId,
      token: '0x0000000000000000000000000000000000000003',
      symbol: 'USDbC',
      decimals: 8,
      native: false,
      display: 'Base USDbC',
    }
    const quote = {
      ...executionQuote(),
      value: 0n,
      gasLimit: 1n,
      maxFeePerGas: 1n,
      source: sourceRouteIdentity(source),
      approvalSpender: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
    }
    const allowances = [0n, 0n, quote.sourceAmount, quote.sourceAmount]
    const estimateContractGas = vi.fn().mockResolvedValue(1n)
    const client = {
      getChainId: vi.fn().mockResolvedValue(chain.chainId),
      getBalance: vi.fn().mockResolvedValue(3n),
      getGasPrice: vi.fn().mockResolvedValue(1n),
      getTransactionCount: vi.fn().mockResolvedValue(8),
      estimateContractGas,
      readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
        functionName === 'balanceOf' ? quote.sourceAmount : (allowances.shift() as bigint)
      ),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
    } as unknown as PublicClient
    const walletClient = {
      writeContract: vi.fn().mockResolvedValue('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      sendTransaction: vi.fn().mockResolvedValue('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
    }

    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        source,
        sourceClient: withResolvedErc20Identity(source, client),
        walletClient: walletClient as never,
        quotes: [quote],
        maxSourceAmount: 10n,
        refreshQuote: vi.fn(async (current) => current),
        getProviderStatus: vi.fn().mockResolvedValue({ status: 'confirmed' as const }),
        checkpointStore: emptyCheckpointStore(),
        destinationChainId: 314,
        getFilecoinBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
        waitForFilecoinArrival: vi.fn(),
      })
    ).resolves.toHaveLength(1)

    expect(estimateContractGas).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ args: [quote.approvalSpender, quote.sourceAmount] })
    )
    expect(walletClient.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ args: [quote.approvalSpender, quote.sourceAmount] })
    )
  })

  it('resets a stale Filecoin ERC-20 allowance without signing an exact approval or route', async () => {
    const chain = SELECTED_SOURCE_CHAINS.find((item) => item.chainId === 314)
    if (chain == null) throw new Error('Filecoin test chain missing')
    const source: ResolvedSourceToken = {
      chain,
      chainId: chain.chainId,
      token: '0x0000000000000000000000000000000000000003',
      symbol: 'USDFC',
      decimals: 18,
      native: false,
      display: 'Filecoin USDFC',
    }
    const quote = {
      ...executionQuote(),
      value: 1n,
      gasLimit: 1n,
      maxFeePerGas: 1n,
      source: sourceRouteIdentity(source),
      approvalSpender: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
    }
    const client = {
      getChainId: vi.fn().mockResolvedValue(chain.chainId),
      getBalance: vi.fn().mockResolvedValueOnce(100n).mockResolvedValueOnce(11n),
      getGasPrice: vi.fn().mockResolvedValue(1n),
      getTransactionCount: vi.fn().mockResolvedValue(8),
      estimateContractGas: vi.fn().mockResolvedValue(1n),
      readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
        functionName === 'balanceOf' ? quote.sourceAmount : 2n
      ),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
    } as unknown as PublicClient
    const walletClient = {
      writeContract: vi.fn().mockResolvedValue('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      sendTransaction: vi.fn(),
    }
    const store = emptyCheckpointStore()

    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        source,
        sourceClient: withResolvedErc20Identity(source, client),
        walletClient: walletClient as never,
        quotes: [quote],
        maxSourceAmount: 10n,
        requiredFilecoinReserve: 10n,
        requiredDestinationWallet: { fil: 10n, usdfc: quote.destinationAmount },
        refreshQuote: vi.fn(async (current) => current),
        getProviderStatus: vi.fn(),
        checkpointStore: store,
        destinationChainId: 314,
        getFilecoinBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
        waitForFilecoinArrival: vi.fn(),
      })
    ).rejects.toThrow('allowance reset is confirmed; rerun acquisition')

    expect(walletClient.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ args: [quote.approvalSpender, 0n] })
    )
    expect(walletClient.writeContract).toHaveBeenCalledTimes(1)
    expect(walletClient.sendTransaction).not.toHaveBeenCalled()
    expect(store.value).toBeDefined()
  })

  it('stops after a Filecoin ERC-20 allowance reset before an exact approval or route', async () => {
    const chain = SELECTED_SOURCE_CHAINS.find((item) => item.chainId === 314)
    if (chain == null) throw new Error('Filecoin test chain missing')
    const source: ResolvedSourceToken = {
      chain,
      chainId: chain.chainId,
      token: '0x0000000000000000000000000000000000000003',
      symbol: 'USDFC',
      decimals: 18,
      native: false,
      display: 'Filecoin USDFC',
    }
    const quote = {
      ...executionQuote(),
      value: 0n,
      gasLimit: 1n,
      maxFeePerGas: 1n,
      source: sourceRouteIdentity(source),
      approvalSpender: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
    }
    const allowances = [2n, 2n, quote.sourceAmount, quote.sourceAmount]
    const estimateContractGas = vi.fn().mockResolvedValue(1n)
    let nextGasPrice = 0n
    const getGasPrice = vi.fn(async () => {
      nextGasPrice += 1n
      return nextGasPrice
    })
    const client = {
      getChainId: vi.fn().mockResolvedValue(chain.chainId),
      getBalance: vi
        .fn()
        .mockResolvedValueOnce(100n)
        .mockResolvedValueOnce(100n)
        .mockResolvedValueOnce(100n)
        .mockResolvedValueOnce(14n),
      getGasPrice,
      getTransactionCount: vi.fn().mockResolvedValue(8),
      estimateContractGas,
      readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
        functionName === 'balanceOf' ? quote.sourceAmount : (allowances.shift() as bigint)
      ),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
    } as unknown as PublicClient
    const walletClient = {
      writeContract: vi.fn().mockResolvedValue('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      sendTransaction: vi.fn(),
    }

    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        source,
        sourceClient: withResolvedErc20Identity(source, client),
        walletClient: walletClient as never,
        quotes: [quote],
        maxSourceAmount: 10n,
        requiredFilecoinReserve: 10n,
        requiredDestinationWallet: { fil: 10n, usdfc: quote.destinationAmount },
        refreshQuote: vi
          .fn()
          .mockResolvedValueOnce(quote)
          .mockResolvedValueOnce({ ...quote, gasLimit: 5n }),
        getProviderStatus: vi.fn(),
        checkpointStore: emptyCheckpointStore(),
        destinationChainId: 314,
        getFilecoinBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
        waitForFilecoinArrival: vi.fn(),
      })
    ).rejects.toThrow('allowance reset is confirmed; rerun acquisition')

    expect(estimateContractGas).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ args: [quote.approvalSpender, 0n] })
    )
    expect(walletClient.writeContract).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ args: [quote.approvalSpender, 0n] })
    )
    expect(walletClient.writeContract).toHaveBeenCalledTimes(1)
    expect(getGasPrice).toHaveBeenCalled()
    expect(walletClient.sendTransaction).not.toHaveBeenCalled()
  })

  it.each(
    SELECTED_SOURCE_CHAINS
  )('executes the strict native route contract for selected chain $chainId', async (chain) => {
    const source: ResolvedSourceToken = {
      chain,
      chainId: chain.chainId,
      token: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      symbol: chain.nativeSymbol,
      decimals: chain.nativeDecimals,
      native: true,
      display: `${chain.cliName} ${chain.nativeSymbol}`,
    }
    const quote = {
      ...executionQuote(),
      value: 1n,
      gasLimit: 1n,
      maxFeePerGas: 1n,
      source: sourceRouteIdentity(source),
      approvalSpender: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
    }
    const client = {
      getChainId: vi.fn().mockResolvedValue(chain.chainId),
      getBalance: vi.fn().mockResolvedValue(100n),
      getGasPrice: vi.fn().mockResolvedValue(1n),
      getTransactionCount: vi.fn().mockResolvedValue(8),
      estimateContractGas: vi.fn(),
      readContract: vi.fn(),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
    } as unknown as PublicClient
    const walletClient = {
      writeContract: vi.fn(),
      sendTransaction: vi.fn().mockResolvedValue('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    }
    const waitForFilecoinArrival = vi.fn().mockResolvedValue(undefined)

    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        source,
        sourceClient: client,
        walletClient: walletClient as never,
        quotes: [quote],
        maxSourceAmount: 10n,
        ...(chain.chainId === 314
          ? {
              requiredFilecoinReserve: 1n,
              requiredDestinationWallet: { fil: MIN_FIL_FOR_GAS, usdfc: quote.destinationAmount },
            }
          : {}),
        refreshQuote: vi.fn(async (current) => current),
        getProviderStatus: vi.fn().mockResolvedValue({ status: 'confirmed' as const }),
        checkpointStore: emptyCheckpointStore(),
        destinationChainId: 314,
        getFilecoinBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
        waitForFilecoinArrival,
      })
    ).resolves.toMatchObject([{ status: 'confirmed' }])

    expect(walletClient.writeContract).not.toHaveBeenCalled()
    expect(client.readContract).not.toHaveBeenCalled()
    expect(walletClient.sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ value: quote.sourceAmount }))
    expect(waitForFilecoinArrival).toHaveBeenCalledWith(
      chain.chainId === 314
        ? { fil: MIN_FIL_FOR_GAS, usdfc: quote.destinationAmount }
        : { fil: 0n, usdfc: quote.destinationAmount }
    )
  })

  it('never resubmits a strict route across before-hash and after-hash recovery', async () => {
    const chain = SELECTED_SOURCE_CHAINS.find((item) => item.chainId === 8453)
    if (chain == null) throw new Error('Base test chain missing')
    const source: ResolvedSourceToken = {
      chain,
      chainId: chain.chainId,
      token: '0x0000000000000000000000000000000000000003',
      symbol: 'USDbC',
      decimals: 8,
      native: false,
      display: 'Base USDbC',
    }
    const quote = {
      ...executionQuote(),
      value: 0n,
      source: sourceRouteIdentity(source),
      approvalSpender: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
    }
    const checkpoint = {
      version: 2 as const,
      owner: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf' as const,
      sourceChainId: chain.chainId,
      destinationChainId: 314,
      source: sourceRouteIdentity(source),
      maxSourceAmount: 10n,
      maxNativeGas: sourceNativeGasCeiling(chain.chainId),
      committedNativeGas: 1n,
      requiredWallet: { fil: 0n, usdfc: quote.destinationAmount },
      evidence: [],
    }
    const walletClient = { writeContract: vi.fn(), sendTransaction: vi.fn() }
    const client = {
      getChainId: vi.fn().mockResolvedValue(chain.chainId),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
    } as unknown as PublicClient
    const routeIntent = {
      nonce: 8,
      quoteId: quote.id,
      asset: quote.asset,
      sourceAmount: quote.sourceAmount.toString(),
      target: quote.target as `0x${string}`,
      dataHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const,
      value: '0',
      gasLimit: '1',
      maxFeePerGas: '1',
    }
    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        source,
        sourceClient: withResolvedErc20Identity(source, client),
        walletClient: walletClient as never,
        quotes: [quote],
        maxSourceAmount: 10n,
        refreshQuote: vi.fn(),
        getProviderStatus: vi.fn(),
        checkpointStore: checkpointStore({ ...checkpoint, routeIntent }),
        destinationChainId: 314,
        getFilecoinBalances: vi.fn(),
        waitForFilecoinArrival: vi.fn(),
      })
    ).rejects.toThrow('pre-broadcast intent')

    const recoveredStore = checkpointStore({
      ...checkpoint,
      evidence: [
        {
          asset: quote.asset,
          quoteId: quote.id,
          sourceAmount: quote.sourceAmount.toString(),
          sourceTransactionHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          status: 'submitted',
        },
      ],
    })
    const waitForFilecoinArrival = vi.fn().mockResolvedValue(undefined)
    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        source,
        sourceClient: withResolvedErc20Identity(source, client),
        walletClient: walletClient as never,
        quotes: [quote],
        maxSourceAmount: 10n,
        refreshQuote: vi.fn(),
        getProviderStatus: vi.fn().mockResolvedValue({ status: 'confirmed' as const }),
        checkpointStore: recoveredStore,
        destinationChainId: 314,
        getFilecoinBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
        waitForFilecoinArrival,
      })
    ).resolves.toMatchObject([{ status: 'confirmed' }])
    expect(walletClient.writeContract).not.toHaveBeenCalled()
    expect(walletClient.sendTransaction).not.toHaveBeenCalled()
    expect(waitForFilecoinArrival).toHaveBeenCalledWith(checkpoint.requiredWallet)
  })

  it('recovers strict multi-leg evidence from Filecoin balances while the provider still lags', async () => {
    const chain = SELECTED_SOURCE_CHAINS.find((item) => item.chainId === 8453)
    if (chain == null) throw new Error('Base test chain missing')
    const source: ResolvedSourceToken = {
      chain,
      chainId: chain.chainId,
      token: '0x0000000000000000000000000000000000000003',
      symbol: 'USDbC',
      decimals: 8,
      native: false,
      display: 'Base USDbC',
    }
    const fil = {
      ...executionQuote(),
      id: 'strict-recovered-fil',
      asset: 'fil' as const,
      sourceAmount: 10n,
      destinationAmount: 3n,
      value: 0n,
      source: sourceRouteIdentity(source),
      approvalSpender: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
    }
    const usdfc = {
      ...executionQuote(),
      id: 'strict-recovered-usdfc',
      sourceAmount: 20n,
      destinationAmount: 4n,
      value: 0n,
      source: sourceRouteIdentity(source),
      approvalSpender: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
    }
    const requiredWallet = { fil: fil.destinationAmount, usdfc: usdfc.destinationAmount }
    const store = checkpointStore({
      version: 2,
      owner: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
      sourceChainId: chain.chainId,
      destinationChainId: 314,
      source: sourceRouteIdentity(source),
      maxSourceAmount: 100n,
      maxNativeGas: sourceNativeGasCeiling(chain.chainId),
      committedNativeGas: 2n,
      requiredWallet,
      evidence: [
        {
          asset: fil.asset,
          quoteId: fil.id,
          sourceAmount: fil.sourceAmount.toString(),
          sourceTransactionHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          status: 'submitted',
        },
        {
          asset: usdfc.asset,
          quoteId: usdfc.id,
          sourceAmount: usdfc.sourceAmount.toString(),
          sourceTransactionHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          status: 'submitted',
        },
      ],
    })
    const walletClient = { writeContract: vi.fn(), sendTransaction: vi.fn() }
    const getProviderStatus = vi.fn().mockResolvedValue({ status: 'ongoing' as const })
    const waitForFilecoinArrival = vi.fn().mockResolvedValue(undefined)
    const sourceClient = {
      getChainId: vi.fn().mockResolvedValue(chain.chainId),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
    } as unknown as PublicClient

    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        source,
        sourceClient: withResolvedErc20Identity(source, sourceClient),
        walletClient: walletClient as never,
        quotes: [fil, usdfc],
        maxSourceAmount: 100n,
        refreshQuote: vi.fn(),
        getProviderStatus,
        checkpointStore: store,
        destinationChainId: 314,
        getFilecoinBalances: vi.fn().mockResolvedValue(requiredWallet),
        waitForFilecoinArrival,
      })
    ).resolves.toMatchObject([
      { asset: 'fil', status: 'confirmed' },
      { asset: 'usdfc', status: 'confirmed' },
    ])

    expect(sourceClient.waitForTransactionReceipt).toHaveBeenCalledTimes(2)
    expect(getProviderStatus).not.toHaveBeenCalled()
    expect(walletClient.writeContract).not.toHaveBeenCalled()
    expect(walletClient.sendTransaction).not.toHaveBeenCalled()
    expect(waitForFilecoinArrival).not.toHaveBeenCalled()
    expect(store.clear).toHaveBeenCalledTimes(1)
  })

  it('rechecks the ERC-20 route balance before recording or broadcasting the strict route', async () => {
    const chain = SELECTED_SOURCE_CHAINS.find((item) => item.chainId === 8453)
    if (chain == null) throw new Error('Base test chain missing')
    const source: ResolvedSourceToken = {
      chain,
      chainId: chain.chainId,
      token: '0x0000000000000000000000000000000000000003',
      symbol: 'USDbC',
      decimals: 8,
      native: false,
      display: 'Base USDbC',
    }
    const quote = {
      ...executionQuote(),
      value: 0n,
      gasLimit: 1n,
      maxFeePerGas: 1n,
      source: sourceRouteIdentity(source),
      approvalSpender: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
    }
    const routeBalances = [quote.sourceAmount, 0n]
    const sourceClient = {
      getChainId: vi.fn().mockResolvedValue(chain.chainId),
      getBalance: vi.fn().mockResolvedValue(100n),
      getGasPrice: vi.fn().mockResolvedValue(1n),
      getTransactionCount: vi.fn().mockResolvedValue(8),
      estimateContractGas: vi.fn().mockResolvedValue(1n),
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === 'balanceOf') return routeBalances.shift()
        return quote.sourceAmount
      }),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
    } as unknown as PublicClient
    const store = emptyCheckpointStore()
    const walletClient = { writeContract: vi.fn(), sendTransaction: vi.fn() }

    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        source,
        sourceClient: withResolvedErc20Identity(source, sourceClient),
        walletClient: walletClient as never,
        quotes: [quote],
        maxSourceAmount: 10n,
        refreshQuote: vi.fn(async (current) => current),
        getProviderStatus: vi.fn(),
        checkpointStore: store,
        destinationChainId: 314,
        getFilecoinBalances: vi.fn().mockResolvedValue({ fil: 0n, usdfc: 0n }),
        waitForFilecoinArrival: vi.fn(),
      })
    ).rejects.toThrow('Insufficient selected source token balance for the next route')

    expect(walletClient.writeContract).not.toHaveBeenCalled()
    expect(walletClient.sendTransaction).not.toHaveBeenCalled()
    expect(store.value).toBeUndefined()
  })

  it('executes a Filecoin ERC-20 route with exact approval and an absolute post-route reserve target', async () => {
    const chain = SELECTED_SOURCE_CHAINS.find((item) => item.chainId === 314)
    if (chain == null) throw new Error('Filecoin test chain missing')
    const source: ResolvedSourceToken = {
      chain,
      chainId: chain.chainId,
      token: '0x0000000000000000000000000000000000000003',
      symbol: 'USDFC',
      decimals: 18,
      native: false,
      display: 'Filecoin USDFC',
    }
    const quote = {
      ...executionQuote(),
      value: 0n,
      gasLimit: 1n,
      maxFeePerGas: 1n,
      source: sourceRouteIdentity(source),
      approvalSpender: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
    }
    const allowanceValues = [0n, 0n, quote.sourceAmount, quote.sourceAmount]
    const sourceClient = {
      getChainId: vi.fn().mockResolvedValue(chain.chainId),
      getBalance: vi.fn().mockResolvedValue(MIN_FIL_FOR_GAS + 1n),
      getGasPrice: vi.fn().mockResolvedValue(1n),
      getTransactionCount: vi.fn().mockResolvedValue(8),
      estimateContractGas: vi.fn().mockResolvedValue(0n),
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === 'balanceOf') return quote.sourceAmount
        return allowanceValues.shift() as bigint
      }),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
    } as unknown as PublicClient
    const walletClient = {
      writeContract: vi.fn().mockResolvedValue('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      sendTransaction: vi.fn().mockResolvedValue('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
    }
    const absoluteTarget = { fil: MIN_FIL_FOR_GAS, usdfc: quote.destinationAmount }
    const waitForFilecoinArrival = vi.fn().mockResolvedValue(undefined)

    await expect(
      executeTokenAcquisition({
        privateKey: PRIVATE_KEY,
        source,
        sourceClient: withResolvedErc20Identity(source, sourceClient),
        walletClient: walletClient as never,
        quotes: [quote],
        maxSourceAmount: 10n,
        requiredFilecoinReserve: MIN_FIL_FOR_GAS,
        requiredDestinationWallet: absoluteTarget,
        refreshQuote: vi.fn(async (current) => current),
        getProviderStatus: vi.fn().mockResolvedValue({ status: 'confirmed' as const }),
        checkpointStore: emptyCheckpointStore(),
        destinationChainId: 314,
        getFilecoinBalances: vi.fn().mockResolvedValue({ fil: MIN_FIL_FOR_GAS - 1n, usdfc: 0n }),
        waitForFilecoinArrival,
      })
    ).resolves.toMatchObject([{ status: 'confirmed' }])
    expect(walletClient.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: source.token, args: [quote.approvalSpender, quote.sourceAmount] })
    )
    expect(walletClient.sendTransaction).toHaveBeenCalledTimes(1)
    expect(waitForFilecoinArrival).toHaveBeenCalledWith(absoluteTarget)
  })
})
