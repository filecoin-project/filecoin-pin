import { calibration, type Chain } from '@filoz/synapse-sdk'
import type { Account, Client, Transport } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it, vi } from 'vitest'
import { authorizeSessionAddress } from '../../core/session/authorize-session.js'

vi.mock('@filoz/synapse-core/session-key', async () => {
  const actual = await vi.importActual<typeof import('@filoz/synapse-core/session-key')>(
    '@filoz/synapse-core/session-key'
  )
  return {
    ...actual,
    loginSync: vi.fn(async (_client: unknown, opts: { onHash?: (hash: string) => void }) => {
      opts.onHash?.('0xabc')
      return {
        receipt: {
          transactionHash: '0xabc',
          blockNumber: 42n,
        },
      }
    }),
  }
})

const TEST_KEY = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const SESSION_ADDRESS = '0xF2222d4C6e3aa4ae572Fa686FC9C15eAA0Fb7bcD'

function makeClient(): Client<Transport, Chain, Account> {
  const account = privateKeyToAccount(TEST_KEY)
  // Cast: the unit test only exercises code paths that read `account` and
  // `chain` off the client; the underlying transport is mocked at the
  // synapse-core layer.
  return { account, chain: calibration } as unknown as Client<Transport, Chain, Account>
}

describe('authorizeSessionAddress', () => {
  it('rejects non-positive validityDays', async () => {
    await expect(
      authorizeSessionAddress(makeClient(), { sessionAddress: SESSION_ADDRESS, validityDays: 0 })
    ).rejects.toThrow(/positive integer/)
  })

  it('rejects validityDays above the 365-day cap', async () => {
    await expect(
      authorizeSessionAddress(makeClient(), { sessionAddress: SESSION_ADDRESS, validityDays: 366 })
    ).rejects.toThrow(/<= 365/)
  })

  it('returns checksummed addresses and the configured registry on success', async () => {
    const events: string[] = []
    const result = await authorizeSessionAddress(makeClient(), {
      sessionAddress: SESSION_ADDRESS.toLowerCase() as `0x${string}`,
      validityDays: 7,
      onProgress: (event) => events.push(event.type),
    })
    expect(result.sessionAddress).toBe(SESSION_ADDRESS)
    expect(result.ownerAddress).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(result.registryAddress).toBe(calibration.contracts.sessionKeyRegistry.address)
    expect(result.txHash).toBe('0xabc')
    expect(result.blockNumber).toBe(42n)
    expect(result.chainId).toBe(calibration.id)
    expect(result.validityDays).toBe(7)
    expect(events).toEqual([
      'authorizeSession:resolving',
      'authorizeSession:submitting',
      'authorizeSession:submitted',
      'authorizeSession:confirmed',
    ])
  })
})
