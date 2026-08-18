import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquirePaymentShortfalls, validateFundingSourceOptions } from '../../payments/squid-funding.js'

const { mockExecute, mockPlan } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockPlan: vi.fn(),
}))

vi.mock('squid-evm-funding', () => ({
  NATIVE_TOKEN_ADDRESS: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  executeSquidFunding: mockExecute,
  planSquidFunding: mockPlan,
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

    mockPlan.mockImplementation(async ({ owner, sourceChainId, requirements, maxSourceAmount }) => ({
      owner,
      source: {
        chainId: sourceChainId,
        token: '0x1111111111111111111111111111111111111111',
        symbol: 'USDC',
        decimals: 6,
      },
      quotes: requirements.map((requirement: Record<string, unknown>, index: number) => ({
        id: `quote-${index}`,
        requirement,
        sourceAmount: 1_000_000n,
        destinationAmount: requirement.amount,
        target: ROUTER,
        data: '0x12',
        value: 0n,
        expiresAt: 2_000_000_000,
      })),
      maxSourceAmount: BigInt(maxSourceAmount) * 1_000_000n,
      slippage: 1,
    }))
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
    expect(validateFundingSourceOptions({})).toBe(false)
    expect(() => validateFundingSourceOptions({ fromChain: 'arbitrum' })).toThrow(/requires --from-chain/)
    expect(
      validateFundingSourceOptions({
        fromChain: 'arbitrum',
        fromToken: 'USDC',
        maxSourceAmount: '1',
        sourceRpcUrl: 'https://rpc.example',
      })
    ).toBe(true)
  })

  it('passes exact FIL and USDFC shortfalls and removes the marker after verified execution', async () => {
    await expect(acquirePaymentShortfalls(input())).resolves.toBeUndefined()

    const planned = mockPlan.mock.calls[0]?.[0]
    expect(planned.requirements.map((requirement: { amount: bigint }) => requirement.amount)).toEqual([2n, 3n])
    expect(mockExecute).toHaveBeenCalledOnce()
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('leaves a private marker when execution fails and sanitizes secrets', async () => {
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
    if (process.platform !== 'win32') expect((await stat(marker)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(marker, 'utf8'))).toMatchObject({
      owner: OWNER,
      sourceChain: 42161,
      maxSourceAmount: '10000000',
    })
  })

  it('uses atomic marker creation to block an ambiguous rerun', async () => {
    await writeFile(marker, '{}', { mode: 0o600 })

    await expect(acquirePaymentShortfalls(input())).rejects.toThrow(marker)
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it('does nothing when there is no shortfall', async () => {
    await expect(acquirePaymentShortfalls(input({ filShortfall: 0n, usdfcShortfall: 0n }))).resolves.toBeUndefined()
    expect(mockPlan).not.toHaveBeenCalled()
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it('rejects a different signing owner before contacting Squid', async () => {
    await expect(
      acquirePaymentShortfalls(input({ owner: '0x2222222222222222222222222222222222222222' }))
    ).rejects.toThrow(/must control the Filecoin payment owner/)
    expect(mockPlan).not.toHaveBeenCalled()
  })

  it('owns Mainnet and private-key authentication checks in the adapter', async () => {
    await expect(
      acquirePaymentShortfalls(input({ synapse: { chain: { id: 314159 }, client: {} } as never }))
    ).rejects.toThrow(/only for Filecoin Mainnet/)
    await expect(
      acquirePaymentShortfalls(input({ options: { ...input().options, walletAddress: OWNER } }))
    ).rejects.toThrow(/owner private-key auth/)
    expect(mockPlan).not.toHaveBeenCalled()
  })

  it('wires all eight source-chain policies and OP Stack fee accounting', async () => {
    for (const [fromChain, chainId] of Object.entries(CHAIN_IDS)) {
      const request = input({ options: { ...input().options, fromChain } })
      await acquirePaymentShortfalls(request)
      expect(mockPlan).toHaveBeenLastCalledWith(
        expect.objectContaining({ sourceChainId: chainId, sourceToken: 'USDC' }),
        expect.anything()
      )
      const execution = mockExecute.mock.calls.at(-1)?.[0]
      expect(execution.feeMode).toBe(fromChain === 'base' || fromChain === 'optimism' ? 'op-stack' : 'standard')
      if (execution.feeMode === 'op-stack') expect(execution.opStackFeeBuffer(4n)).toBe(5n)
      if (fromChain === 'ethereum') {
        expect(request.confirm).toHaveBeenCalledWith(
          expect.objectContaining({
            maxNativeFee: 30_000_000_000_000_000n,
            nativeCurrency: expect.objectContaining({ symbol: 'ETH', decimals: 18 }),
          })
        )
      }
    }
  })

  it('allows Filecoin USDFC to acquire a FIL shortfall without spending reserved USDFC', async () => {
    mockPlan.mockResolvedValueOnce({
      owner: OWNER,
      source: {
        chainId: 314,
        token: '0x80B98d3aa09ffff255c3ba4A241111Ff1262F045',
        symbol: 'USDFC',
        decimals: 18,
      },
      quotes: [],
      maxSourceAmount: 10n,
      slippage: 1,
    })
    await acquirePaymentShortfalls(input({ options: { ...input().options, fromChain: 'filecoin' } }))
    expect(mockPlan.mock.calls[0]?.[0].requirements[0].amount).toBe(30_000_000_000_000_002n)
    expect(mockExecute.mock.calls[0]?.[0]).toMatchObject({
      sourceBalanceFloor: 8n,
      nativeBalanceFloor: 0n,
    })
  })

  it('preserves the Filecoin FIL reserve when FIL funds a USDFC-only shortfall', async () => {
    mockPlan.mockResolvedValueOnce({
      owner: OWNER,
      source: {
        chainId: 314,
        token: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        symbol: 'FIL',
        decimals: 18,
      },
      quotes: [],
      maxSourceAmount: 10n,
      slippage: 1,
    })
    await acquirePaymentShortfalls(input({ filShortfall: 0n, options: { ...input().options, fromChain: 'filecoin' } }))
    expect(mockExecute.mock.calls[0]?.[0]).toMatchObject({
      sourceBalanceFloor: 100_000_000_000_000_000n,
      nativeBalanceFloor: 100_000_000_000_000_000n,
    })
  })
})
