import { revokeSync } from '@filoz/synapse-core/session-key'
import { type Chain, calibration } from '@filoz/synapse-sdk'
import type { Account, Client, Transport } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it, vi } from 'vitest'
import { FilecoinPinFwssPermissions } from '../../core/session/authorize-session.js'
import { revokeSessionAddress } from '../../core/session/revoke-session.js'
import { APPLICATION_SOURCE } from '../../core/synapse/constants.js'

vi.mock('@filoz/synapse-core/session-key', async () => {
  const actual = await vi.importActual<typeof import('@filoz/synapse-core/session-key')>(
    '@filoz/synapse-core/session-key'
  )
  return {
    ...actual,
    revokeSync: vi.fn(async (_client: unknown, opts: { onHash?: (hash: string) => void }) => {
      opts.onHash?.('0xdef')
      return {
        receipt: {
          transactionHash: '0xdef',
          blockNumber: 77n,
        },
      }
    }),
  }
})

const TEST_KEY = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const SESSION_ADDRESS = '0xF2222d4C6e3aa4ae572Fa686FC9C15eAA0Fb7bcD'

function makeClient(): Client<Transport, Chain, Account> {
  const account = privateKeyToAccount(TEST_KEY)
  return { account, chain: calibration } as unknown as Client<Transport, Chain, Account>
}

describe('revokeSessionAddress', () => {
  it('returns checksummed addresses and revokes the Filecoin Pin permission set', async () => {
    const events: string[] = []
    const result = await revokeSessionAddress(makeClient(), {
      sessionAddress: SESSION_ADDRESS.toLowerCase() as `0x${string}`,
      onProgress: (event) => events.push(event.type),
    })

    expect(result.sessionAddress).toBe(SESSION_ADDRESS)
    expect(result.ownerAddress).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(result.registryAddress).toBe(calibration.contracts.sessionKeyRegistry.address)
    expect(result.txHash).toBe('0xdef')
    expect(result.blockNumber).toBe(77n)
    expect(result.chainId).toBe(calibration.id)
    expect(result.permissions).toEqual(FilecoinPinFwssPermissions)
    expect(events).toEqual([
      'revokeSession:resolving',
      'revokeSession:submitting',
      'revokeSession:submitted',
      'revokeSession:confirmed',
    ])
    expect(revokeSync).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        address: SESSION_ADDRESS,
        permissions: FilecoinPinFwssPermissions,
        origin: APPLICATION_SOURCE,
        contractAddress: calibration.contracts.sessionKeyRegistry.address,
      })
    )
  })
})
