import {
  AddPiecesPermission,
  CreateDataSetPermission,
  getExpirations,
  SchedulePieceRemovalsPermission,
} from '@filoz/synapse-core/session-key'
import {
  type Address,
  type Chain,
  type Client,
  encodeAbiParameters,
  type Hex,
  type Transport,
  toEventSelector,
} from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readScopeGrants, watchAuthorization } from '../../core/session/watch-authorization.js'

// Keep the real event decoder and permission constants; only the multicall read is faked.
vi.mock('@filoz/synapse-core/session-key', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@filoz/synapse-core/session-key')>()
  return { ...actual, getExpirations: vi.fn() }
})

const OWNER: Address = '0x00000000000000000000000000000000000000aa'
const SESSION: Address = '0x00000000000000000000000000000000000000bb'
const OTHER_SESSION: Address = '0x00000000000000000000000000000000000000cc'
const REGISTRY: Address = '0x00000000000000000000000000000000000000dd'
const FUTURE = BigInt(Math.floor(Date.now() / 1000) + 86400)
const PAST = 1000n

const TOPIC = toEventSelector('AuthorizationsUpdated(address,address,uint256,bytes32[],string)')

/** Build a raw eth_getLogs entry for AuthorizationsUpdated(identity indexed, signer, expiry, permissions, origin). */
function authorizationLog(identity: Address, signer: Address, permissions: Hex[]): Record<string, unknown> {
  const data = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes32[]' }, { type: 'string' }],
    [signer, FUTURE, permissions, 'filecoin-pin']
  )
  return {
    address: REGISTRY,
    topics: [TOPIC, `0x000000000000000000000000${identity.slice(2)}`],
    data,
    blockNumber: '0x10',
    transactionHash: `0x${'1'.repeat(64)}`,
    transactionIndex: '0x0',
    blockHash: `0x${'2'.repeat(64)}`,
    logIndex: '0x0',
    removed: false,
  }
}

function fakeClient(logsPerCall: Array<Record<string, unknown>[]>): {
  client: Client<Transport, Chain>
  calls: unknown[]
} {
  const calls: unknown[] = []
  let call = 0
  const client = {
    request: vi.fn(async (args: { method: string; params: unknown }) => {
      calls.push(args)
      if (args.method !== 'eth_getLogs') throw new Error(`unexpected ${args.method}`)
      const logs = logsPerCall[Math.min(call, logsPerCall.length - 1)] ?? []
      call += 1
      return logs
    }),
  } as unknown as Client<Transport, Chain>
  return { client, calls }
}

const base = {
  sessionAddress: SESSION,
  registryAddress: REGISTRY,
  permissions: [CreateDataSetPermission, AddPiecesPermission],
  pollIntervalMs: 1,
}

describe('watchAuthorization', () => {
  beforeEach(() => {
    vi.mocked(getExpirations).mockReset()
  })

  it('finds the owner from the matching event, then confirms every scope', async () => {
    const { client, calls } = fakeClient([
      [],
      [authorizationLog(OWNER, OTHER_SESSION, []), authorizationLog(OWNER, SESSION, [])],
    ])
    // First tick: no logs. Second tick: an unrelated signer, then ours.
    vi.mocked(getExpirations).mockResolvedValue({ [CreateDataSetPermission]: FUTURE, [AddPiecesPermission]: FUTURE })

    const result = await watchAuthorization({ ...base, client, fromBlock: 42n, deadlineMs: 2000 })

    expect(result.status).toBe('granted')
    expect(result.owner?.toLowerCase()).toBe(OWNER)
    expect(result.expiry).toBe(FUTURE)
    expect(result.granted).toEqual([CreateDataSetPermission, AddPiecesPermission])
    expect(result.missing).toEqual([])
    expect(calls[0]).toMatchObject({
      method: 'eth_getLogs',
      params: [{ address: REGISTRY, fromBlock: '0x2a', toBlock: 'latest', topics: [TOPIC] }],
    })
    expect(vi.mocked(getExpirations)).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ sessionKeyAddress: SESSION, contractAddress: REGISTRY })
    )
  })

  it('returns timeout, never having learned the owner, when no event arrives before the deadline', async () => {
    const { client } = fakeClient([[]])
    const ticks: number[] = []

    const result = await watchAuthorization({
      ...base,
      client,
      fromBlock: 1n,
      deadlineMs: 20,
      onTick: (ms) => ticks.push(ms),
    })

    expect(result).toEqual({ status: 'timeout', granted: [], missing: base.permissions })
    expect(ticks.length).toBeGreaterThan(0)
    expect(ticks[0]).toBeLessThanOrEqual(20)
    expect(vi.mocked(getExpirations)).not.toHaveBeenCalled()
  })

  it('reports a partial grant as soon as the event lands', async () => {
    const { client } = fakeClient([[authorizationLog(OWNER, SESSION, [])]])
    vi.mocked(getExpirations).mockResolvedValue({
      [CreateDataSetPermission]: FUTURE,
      [AddPiecesPermission]: FUTURE,
      [SchedulePieceRemovalsPermission]: 0n,
    })

    const result = await watchAuthorization({
      ...base,
      permissions: [CreateDataSetPermission, AddPiecesPermission, SchedulePieceRemovalsPermission],
      client,
      fromBlock: 1n,
      deadlineMs: 2000,
    })

    expect(result.status).toBe('partial')
    expect(result.granted).toEqual([CreateDataSetPermission, AddPiecesPermission])
    expect(result.missing).toEqual([SchedulePieceRemovalsPermission])
    expect(vi.mocked(getExpirations)).toHaveBeenCalledTimes(1)
  })

  it('with a known owner, skips the event scan and polls the expiries until granted', async () => {
    const { client, calls } = fakeClient([[]])
    vi.mocked(getExpirations)
      .mockResolvedValueOnce({ [CreateDataSetPermission]: PAST, [AddPiecesPermission]: 0n })
      .mockResolvedValueOnce({ [CreateDataSetPermission]: FUTURE, [AddPiecesPermission]: FUTURE })

    const result = await watchAuthorization({ ...base, client, owner: OWNER, deadlineMs: 2000 })

    expect(result.status).toBe('granted')
    expect(calls).toEqual([])
    expect(vi.mocked(getExpirations)).toHaveBeenCalledTimes(2)
  })

  it('with a known owner and no event, a pre-existing partial grant is reported at the deadline', async () => {
    const { client } = fakeClient([[]])
    vi.mocked(getExpirations).mockResolvedValue({ [CreateDataSetPermission]: FUTURE, [AddPiecesPermission]: 0n })

    const result = await watchAuthorization({ ...base, client, owner: OWNER, fromBlock: 1n, deadlineMs: 15 })

    expect(result.status).toBe('partial')
    expect(result.granted).toEqual([CreateDataSetPermission])
    expect(result.missing).toEqual([AddPiecesPermission])
  })

  it('rejects a call with neither owner nor fromBlock', async () => {
    const { client } = fakeClient([[]])
    await expect(watchAuthorization({ ...base, client })).rejects.toThrow(/owner or fromBlock/)
  })
})

describe('readScopeGrants', () => {
  it('treats a lapsed expiry as not granted', async () => {
    const { client } = fakeClient([[]])
    vi.mocked(getExpirations).mockResolvedValue({ [CreateDataSetPermission]: PAST, [AddPiecesPermission]: 0n })

    const grants = await readScopeGrants({ ...base, client, owner: OWNER })

    expect(grants).toEqual({ status: 'none', owner: OWNER, granted: [], missing: base.permissions })
  })
})
