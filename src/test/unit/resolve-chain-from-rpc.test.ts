import { calibration, mainnet } from '@filoz/synapse-sdk'
import * as viem from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveChainFromRpc } from '../../core/synapse/resolve-chain-from-rpc.js'

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>()
  return {
    ...actual,
    createPublicClient: vi.fn(),
  }
})

vi.mock('../../common/get-rpc-url.js', () => ({
  resolveDevnetConfig: vi.fn(() => {
    throw new Error('devnet-info.json not available')
  }),
}))

const mockedCreatePublicClient = vi.mocked(viem.createPublicClient)

function mockChainId(id: number) {
  mockedCreatePublicClient.mockReturnValue({
    getChainId: vi.fn().mockResolvedValue(id),
  } as unknown as ReturnType<typeof viem.createPublicClient>)
}

describe('resolveChainFromRpc', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns mainnet for chainId 314', async () => {
    mockChainId(mainnet.id)
    const transport = viem.http('https://x.test')
    await expect(resolveChainFromRpc(transport)).resolves.toBe(mainnet)
  })

  it('returns calibration for chainId 314159', async () => {
    mockChainId(calibration.id)
    const transport = viem.http('https://x.test')
    await expect(resolveChainFromRpc(transport)).resolves.toBe(calibration)
  })

  it('throws on unknown chainId when devnet config unavailable', async () => {
    mockChainId(9999)
    const transport = viem.http('https://x.test')
    await expect(resolveChainFromRpc(transport)).rejects.toThrow(/Unsupported RPC chainId 9999/)
  })

  it('returns devnet chain when chainId matches devnet config', async () => {
    const devnetChain = { id: 31415926, name: 'devnet' } as const
    const { resolveDevnetConfig } = await import('../../common/get-rpc-url.js')
    vi.mocked(resolveDevnetConfig).mockReturnValueOnce({ chain: devnetChain as never, privateKey: undefined })

    mockChainId(devnetChain.id)
    const transport = viem.http('https://x.test')
    await expect(resolveChainFromRpc(transport)).resolves.toBe(devnetChain)
  })
})
