import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquirePaymentShortfalls, validateFundingSourceOptions } from '../../payments/squid-funding.js'

const { mockExecute, mockFetchCatalog, mockPlan, mockQuote, mockResolve } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockFetchCatalog: vi.fn(),
  mockPlan: vi.fn(),
  mockQuote: vi.fn(),
  mockResolve: vi.fn(),
}))

vi.mock('squid-evm-funding', () => ({
  NATIVE_TOKEN_ADDRESS: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  executeSquidFunding: mockExecute,
  fetchSquidCatalog: mockFetchCatalog,
  planSquidFunding: mockPlan,
  quoteSquidRoute: mockQuote,
  resolveSourceToken: mockResolve,
}))

const PRIVATE_KEY = `0x${'01'.padStart(64, '0')}` as Hex
const OWNER = privateKeyToAccount(PRIVATE_KEY).address
const ROUTER = '0xce16F69375520ab01377ce7B88f5BA8C48F8D666'
const CHAIN_IDS: Record<string, number> = {
  filecoin: 314,
  arbitrum: 42161,
  ethereum: 1,
  base: 8453,
  optimism: 10,
  polygon: 137,
  avalanche: 43114,
  bnb: 56,
}

let directory: string
let marker: string
const originalEnvironment = {
  databasePath: process.env.DATABASE_PATH,
  integratorId: process.env.SQUID_INTEGRATOR_ID,
  network: process.env.NETWORK,
  rpcUrl: process.env.RPC_URL,
}

function serializeErrorChain(error: unknown): string {
  const chain: unknown[] = []
  let current = error
  while (current instanceof Error) {
    chain.push({ name: current.name, message: current.message, stack: current.stack })
    current = current.cause
  }
  return JSON.stringify(chain)
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    synapse: { chain: { id: 314 }, client: {} } as never,
    owner: OWNER,
    filShortfall: 2n,
    usdfcShortfall: 3n,
    requiredWalletUsdfc: 8n,
    options: {
      fromChain: 'arbitrum',
      fromToken: 'USDC',
      maxSourceAmount: '10',
      sourceRpcUrl: 'https://rpc.example/secret',
      privateKey: PRIVATE_KEY,
    },
    confirm: vi.fn(),
    ...overrides,
  }
}

describe('Squid payment shortfalls', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    directory = await mkdtemp(join(tmpdir(), 'filecoin-pin-squid-'))
    marker = join(directory, 'squid-funding.pending')
    process.env.DATABASE_PATH = join(directory, 'pins.db')
    process.env.SQUID_INTEGRATOR_ID = 'test-integrator'
    delete process.env.NETWORK
    delete process.env.RPC_URL

    mockFetchCatalog.mockResolvedValue({})
    mockResolve.mockImplementation((_catalog, chainId) => ({
      chain: { chainId, networkName: 'source' },
      token: '0x1111111111111111111111111111111111111111',
      symbol: 'USDC',
      decimals: 6,
      native: false,
    }))
    mockPlan.mockImplementation(async ({ source, requirements }) =>
      requirements.map((requirement: Record<string, unknown>, index: number) => ({
        id: `quote-${index}`,
        requirement,
        source,
        sourceAmount: 1_000_000n,
        destinationAmount: requirement.amount,
        target: ROUTER,
        data: '0x12',
        value: 0n,
        gasLimit: 1n,
        expiresAt: 2_000_000_000,
      }))
    )
    mockExecute.mockResolvedValue({ sourceAmount: 2_000_000n, nativeFee: 1n, routes: [] })
  })

  afterEach(async () => {
    for (const [name, value] of Object.entries(originalEnvironment)) {
      const key =
        name === 'databasePath'
          ? 'DATABASE_PATH'
          : name === 'integratorId'
            ? 'SQUID_INTEGRATOR_ID'
            : name === 'network'
              ? 'NETWORK'
              : 'RPC_URL'
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
    await rm(directory, { recursive: true, force: true })
  })

  it('requires all four source options together', () => {
    expect(() => validateFundingSourceOptions({ fromChain: 'arbitrum' })).toThrow(/requires --from-chain/)
    expect(() =>
      validateFundingSourceOptions({
        fromChain: 'arbitrum',
        fromToken: 'USDC',
        maxSourceAmount: '1',
        sourceRpcUrl: 'https://rpc.example',
      })
    ).not.toThrow()
  })

  it('passes exact FIL and USDFC shortfalls and removes the marker after verified execution', async () => {
    await expect(acquirePaymentShortfalls(input())).resolves.toBe(true)

    const planned = mockPlan.mock.calls[0]?.[0]
    expect(planned.requirements.map((requirement: { amount: bigint }) => requirement.amount)).toEqual([2n, 3n])
    expect(mockExecute).toHaveBeenCalledOnce()
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('leaves a mode-0600 marker when execution fails and sanitizes secrets', async () => {
    const privateKey = PRIVATE_KEY.slice(2)
    const rpcUrl = input().options.sourceRpcUrl
    const integratorId = process.env.SQUID_INTEGRATOR_ID as string
    mockExecute.mockRejectedValueOnce(
      new Error(`failed ${PRIVATE_KEY} or ${privateKey} at ${rpcUrl} for ${integratorId}`)
    )

    let failure: unknown
    try {
      await acquirePaymentShortfalls(input({ options: { ...input().options, privateKey } }))
    } catch (error) {
      failure = error
    }
    const serialized = serializeErrorChain(failure)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('[redacted]')
    for (const secret of [PRIVATE_KEY, privateKey, rpcUrl, integratorId]) {
      expect(serialized).not.toContain(secret)
    }
    expect((await stat(marker)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(marker, 'utf8'))).toMatchObject({
      owner: OWNER,
      sourceChain: 42161,
      maxSourceAmount: '10000000',
    })
  })

  it('refuses a pending marker before contacting Squid', async () => {
    await writeFile(marker, '{}', { mode: 0o600 })

    await expect(acquirePaymentShortfalls(input())).rejects.toThrow(marker)
    expect(mockFetchCatalog).not.toHaveBeenCalled()
  })

  it('does nothing when there is no shortfall', async () => {
    await expect(acquirePaymentShortfalls(input({ filShortfall: 0n, usdfcShortfall: 0n }))).resolves.toBe(false)
    expect(mockFetchCatalog).not.toHaveBeenCalled()
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it('rejects a different signing owner before contacting Squid', async () => {
    await expect(
      acquirePaymentShortfalls(input({ owner: '0x2222222222222222222222222222222222222222' }))
    ).rejects.toThrow(/must control the Filecoin payment owner/)
    expect(mockFetchCatalog).not.toHaveBeenCalled()
  })

  it('wires all eight source-chain policies and OP Stack fee accounting', async () => {
    for (const [fromChain, chainId] of Object.entries(CHAIN_IDS)) {
      await acquirePaymentShortfalls(input({ options: { ...input().options, fromChain } }))
      expect(mockResolve).toHaveBeenLastCalledWith({}, chainId, 'USDC')
      const execution = mockExecute.mock.calls.at(-1)?.[0]
      expect(execution.feeMode).toBe(fromChain === 'base' || fromChain === 'optimism' ? 'op-stack' : 'standard')
      if (execution.feeMode === 'op-stack') expect(execution.opStackFeeBuffer(4n)).toBe(5n)
    }
  })

  it('preserves the Filecoin FIL and USDFC reserves when Filecoin is the source', async () => {
    mockResolve.mockReturnValueOnce({
      chain: { chainId: 314, networkName: 'filecoin' },
      token: '0x80B98d3aa09ffff255c3ba4A241111Ff1262F045',
      symbol: 'USDFC',
      decimals: 18,
      native: false,
    })
    await acquirePaymentShortfalls(input({ options: { ...input().options, fromChain: 'filecoin' } }))
    expect(mockExecute.mock.calls[0]?.[0]).toMatchObject({
      sourceBalanceFloor: 8n,
      nativeBalanceFloor: 100_000_000_000_000_000n,
    })
  })
})
