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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WatchAuthorizationProgressEvents } from '../../core/session/types.js'
import { readScopeGrants, watchAuthorization } from '../../core/session/watch-authorization.js'

// Keep the real event decoder and permission constants; only the multicall read is faked.
vi.mock('@filoz/synapse-core/session-key', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@filoz/synapse-core/session-key')>()
  return { ...actual, getExpirations: vi.fn() }
})

const OWNER: Address = '0x00000000000000000000000000000000000000aa'
const OTHER_OWNER: Address = '0x00000000000000000000000000000000000000ab'
const SESSION: Address = '0x00000000000000000000000000000000000000bb'
const OTHER_SESSION: Address = '0x00000000000000000000000000000000000000cc'
const REGISTRY: Address = '0x00000000000000000000000000000000000000dd'
const FUTURE = BigInt(Math.floor(Date.now() / 1000) + 86400)
const LATER = FUTURE + 3600n
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

/** One eth_getLogs answer: the logs to return, or the error to throw. */
type LogsAnswer = Record<string, unknown>[] | Error

interface RpcCall {
  method: string
  params?: unknown
}

/**
 * A client whose eth_getLogs answers follow `schedule` call by call; the last
 * entry repeats once the schedule runs out. eth_blockNumber answers `head`.
 */
function fakeClient(
  schedule: LogsAnswer[],
  options: { head?: string } = {}
): {
  client: Client<Transport, Chain>
  calls: RpcCall[]
} {
  const { head = '0x64' } = options
  const calls: RpcCall[] = []
  let call = 0
  const client = {
    request: vi.fn(async (args: RpcCall) => {
      calls.push(args)
      if (args.method === 'eth_blockNumber') return head
      if (args.method !== 'eth_getLogs') throw new Error(`unexpected ${args.method}`)
      const answer = schedule[Math.min(call, schedule.length - 1)] ?? []
      call += 1
      if (answer instanceof Error) throw answer
      return answer
    }),
  } as unknown as Client<Transport, Chain>
  return { client, calls }
}

/** The fromBlock of every eth_getLogs call, in order. */
function scanStarts(calls: RpcCall[]): string[] {
  return calls
    .filter((c): c is { method: string; params: [{ fromBlock: string }] } => c.method === 'eth_getLogs')
    .map((c) => c.params[0].fromBlock)
}

/** Collect the data of every progress event of one type. */
function progressOf<T extends WatchAuthorizationProgressEvents['type']>(type: T) {
  const data: Extract<WatchAuthorizationProgressEvents, { type: T }>['data'][] = []
  const onProgress = (event: WatchAuthorizationProgressEvents) => {
    if (event.type === type) data.push(event.data as (typeof data)[number])
  }
  return { data, onProgress }
}

const base = {
  sessionAddress: SESSION,
  registryAddress: REGISTRY,
  permissions: [CreateDataSetPermission, AddPiecesPermission],
  pollIntervalMs: 1,
}

/** Run the watcher under fake timers, draining every scheduled poll and the deadline. */
async function watch(options: Parameters<typeof watchAuthorization>[0]) {
  const pending = watchAuthorization(options)
  // A rejection that lands while timers drain must not surface as unhandled.
  pending.catch(() => undefined)
  await vi.runAllTimersAsync()
  return pending
}

describe('watchAuthorization', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(getExpirations).mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('finds the owner from the matching event, then confirms every scope', async () => {
    // First tick: no logs. Second tick: another owner's key, then ours.
    const { client, calls } = fakeClient([
      [],
      [authorizationLog(OTHER_OWNER, OTHER_SESSION, []), authorizationLog(OWNER, SESSION, [])],
    ])
    const owners = progressOf('watch:ownerFound')
    vi.mocked(getExpirations).mockResolvedValue({ [CreateDataSetPermission]: FUTURE, [AddPiecesPermission]: LATER })

    const result = await watch({ ...base, client, fromBlock: 42n, deadlineMs: 2000, onProgress: owners.onProgress })

    expect(result.status).toBe('granted')
    expect(result.owner?.toLowerCase()).toBe(OWNER)
    expect(result.expiry).toBe(LATER)
    expect(result.granted).toEqual([CreateDataSetPermission, AddPiecesPermission])
    expect(result.missing).toEqual([])
    expect(owners.data.map((d) => d.owner.toLowerCase())).toEqual([OWNER])
    expect(calls[0]).toMatchObject({
      method: 'eth_getLogs',
      params: [{ address: REGISTRY, fromBlock: '0x2a', toBlock: 'latest', topics: [TOPIC] }],
    })
    expect(vi.mocked(getExpirations)).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ sessionKeyAddress: SESSION, contractAddress: REGISTRY })
    )
  })

  it('moves the scan forward to the last block each answer covered', async () => {
    const unrelated = { ...authorizationLog(OWNER, OTHER_SESSION, []), blockNumber: '0x64' }
    const { client, calls } = fakeClient(
      [[unrelated], [], [{ ...authorizationLog(OWNER, SESSION, []), blockNumber: '0x70' }]],
      { head: '0x66' }
    )
    vi.mocked(getExpirations).mockResolvedValue({ [CreateDataSetPermission]: FUTURE, [AddPiecesPermission]: FUTURE })

    const result = await watch({ ...base, client, fromBlock: 42n, deadlineMs: 2000 })

    expect(result.status).toBe('granted')
    // Starts at 42; after a page ending at block 0x64 it resumes there; an empty page moves it to the head (0x66).
    expect(scanStarts(calls)).toEqual(['0x2a', '0x64', '0x66'])
  })

  it('never moves the scan backwards when the head is behind the last block seen', async () => {
    const ahead = { ...authorizationLog(OWNER, OTHER_SESSION, []), blockNumber: '0x70' }
    const { client, calls } = fakeClient([[ahead], [], [authorizationLog(OWNER, SESSION, [])]], { head: '0x64' })
    vi.mocked(getExpirations).mockResolvedValue({ [CreateDataSetPermission]: FUTURE, [AddPiecesPermission]: FUTURE })

    const result = await watch({ ...base, client, fromBlock: 42n, deadlineMs: 2000 })

    expect(result.status).toBe('granted')
    // The empty page reads a head (0x64) below the last block seen (0x70); the scan stays at 0x70.
    expect(scanStarts(calls)).toEqual(['0x2a', '0x70', '0x70'])
  })

  it('skips a log it cannot decode and still finds the matching one behind it', async () => {
    const garbage = { ...authorizationLog(OWNER, SESSION, []), data: '0xdeadbeef' }
    const { client } = fakeClient([[garbage, authorizationLog(OWNER, SESSION, [])]])
    const errors = progressOf('watch:error')
    vi.mocked(getExpirations).mockResolvedValue({ [CreateDataSetPermission]: FUTURE, [AddPiecesPermission]: FUTURE })

    const result = await watch({ ...base, client, fromBlock: 1n, deadlineMs: 2000, onProgress: errors.onProgress })

    expect(result.status).toBe('granted')
    expect(result.owner?.toLowerCase()).toBe(OWNER)
    expect(errors.data).toEqual([])
  })

  it('returns timeout, never having learned the owner, when no event arrives before the deadline', async () => {
    const { client } = fakeClient([[]])
    const ticks = progressOf('watch:tick')

    const result = await watch({ ...base, client, fromBlock: 1n, deadlineMs: 20, onProgress: ticks.onProgress })

    expect(result).toEqual({ status: 'timeout', granted: [], missing: base.permissions })
    expect(ticks.data.length).toBeGreaterThan(0)
    expect(ticks.data[0]?.remainingMs).toBe(20)
    expect(vi.mocked(getExpirations)).not.toHaveBeenCalled()
  })

  it('reports a partial grant as soon as the event lands', async () => {
    const { client } = fakeClient([[authorizationLog(OWNER, SESSION, [])]])
    vi.mocked(getExpirations).mockResolvedValue({
      [CreateDataSetPermission]: FUTURE,
      [AddPiecesPermission]: FUTURE,
      [SchedulePieceRemovalsPermission]: 0n,
    })

    const result = await watch({
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

  it('with a known owner, never scans logs and polls the expiries until granted', async () => {
    const { client, calls } = fakeClient([[authorizationLog(OTHER_SESSION, SESSION, [])]])
    vi.mocked(getExpirations)
      .mockResolvedValueOnce({ [CreateDataSetPermission]: PAST, [AddPiecesPermission]: 0n })
      .mockResolvedValueOnce({ [CreateDataSetPermission]: FUTURE, [AddPiecesPermission]: FUTURE })

    const result = await watch({ ...base, client, owner: OWNER, fromBlock: 1n, deadlineMs: 2000 })

    expect(result.status).toBe('granted')
    expect(result.owner).toBe(OWNER)
    expect(calls).toEqual([])
    expect(vi.mocked(getExpirations)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(getExpirations)).toHaveBeenCalledWith(client, expect.objectContaining({ address: OWNER }))
  })

  it('reports none at the deadline, not timeout, when the owner acted but granted no requested scope', async () => {
    const { client } = fakeClient([[authorizationLog(OWNER, SESSION, [])]])
    vi.mocked(getExpirations).mockResolvedValue({ [CreateDataSetPermission]: 0n, [AddPiecesPermission]: 0n })

    const result = await watch({ ...base, client, fromBlock: 1n, deadlineMs: 30 })

    expect(result.status).toBe('none')
    expect(result.owner?.toLowerCase()).toBe(OWNER)
    expect(result.missing).toEqual(base.permissions)
    // Kept polling after the event rather than stopping on the first empty read.
    expect(vi.mocked(getExpirations).mock.calls.length).toBeGreaterThan(1)
  })

  it('with a known owner and no event, reports timeout with the owner when no requested scope is live', async () => {
    const { client } = fakeClient([[]])
    vi.mocked(getExpirations).mockResolvedValue({ [CreateDataSetPermission]: 0n, [AddPiecesPermission]: 0n })

    const result = await watch({ ...base, client, owner: OWNER, fromBlock: 1n, deadlineMs: 15 })

    expect(result).toEqual({ status: 'timeout', owner: OWNER, granted: [], missing: base.permissions })
  })

  it('keeps polling through a transient RPC error and reports it as progress', async () => {
    const { client } = fakeClient([new Error('429 rate limited'), [authorizationLog(OWNER, SESSION, [])]])
    const errors = progressOf('watch:error')
    vi.mocked(getExpirations).mockResolvedValue({ [CreateDataSetPermission]: FUTURE, [AddPiecesPermission]: FUTURE })

    const result = await watch({ ...base, client, fromBlock: 1n, deadlineMs: 2000, onProgress: errors.onProgress })

    expect(result.status).toBe('granted')
    expect(errors.data).toHaveLength(1)
  })

  it('gives up after three failed polls in a row, well before the deadline', async () => {
    const { client, calls } = fakeClient([new Error('502 bad gateway')])

    await expect(watch({ ...base, client, fromBlock: 1n, deadlineMs: 2000 })).rejects.toThrow(
      'failed 3 polls in a row (502 bad gateway)'
    )
    expect(scanStarts(calls)).toHaveLength(3)
  })

  it('throws the RPC error at the deadline when every poll failed but fewer than three ran', async () => {
    const { client, calls } = fakeClient([new Error('502 bad gateway')])

    await expect(watch({ ...base, client, fromBlock: 1n, deadlineMs: 2, pollIntervalMs: 5 })).rejects.toThrow(
      '502 bad gateway'
    )
    expect(scanStarts(calls)).toHaveLength(1)
  })

  it('a successful poll between failures resets the count, so scattered failures never give up', async () => {
    // fail, fail, ok (no event), fail, fail, event: four failures, never three in a row.
    const { client } = fakeClient([
      new Error('503'),
      new Error('503'),
      [],
      new Error('503'),
      new Error('503'),
      [authorizationLog(OWNER, SESSION, [])],
    ])
    const errors = progressOf('watch:error')
    vi.mocked(getExpirations).mockResolvedValue({ [CreateDataSetPermission]: FUTURE, [AddPiecesPermission]: FUTURE })

    const result = await watch({ ...base, client, fromBlock: 1n, deadlineMs: 2000, onProgress: errors.onProgress })

    expect(result.status).toBe('granted')
    expect(errors.data).toHaveLength(4)
  })

  it('moves the scan to the head block when an answer is empty, instead of re-reading from the start', async () => {
    const { client, calls } = fakeClient([[], [authorizationLog(OWNER, SESSION, [])]], { head: '0x5a' })
    vi.mocked(getExpirations).mockResolvedValue({ [CreateDataSetPermission]: FUTURE, [AddPiecesPermission]: FUTURE })

    await watch({ ...base, client, fromBlock: 42n, deadlineMs: 2000 })

    // First scan from login's block (0x2a); the empty answer moves the next one to the head (0x5a).
    expect(scanStarts(calls)).toEqual(['0x2a', '0x5a'])
  })

  it('with a known owner and no event, a pre-existing partial grant is reported at the deadline', async () => {
    const { client } = fakeClient([[]])
    vi.mocked(getExpirations).mockResolvedValue({ [CreateDataSetPermission]: FUTURE, [AddPiecesPermission]: 0n })

    const result = await watch({ ...base, client, owner: OWNER, fromBlock: 1n, deadlineMs: 15 })

    expect(result.status).toBe('partial')
    expect(result.granted).toEqual([CreateDataSetPermission])
    expect(result.missing).toEqual([AddPiecesPermission])
    // Kept polling to the deadline rather than stopping on the first partial read.
    expect(vi.mocked(getExpirations).mock.calls.length).toBeGreaterThan(1)
  })

  it('rejects a call with neither owner nor fromBlock', async () => {
    const { client } = fakeClient([[]])
    await expect(watch({ ...base, client })).rejects.toThrow(/owner or fromBlock/)
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
