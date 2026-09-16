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

/**
 * Build a raw eth_getLogs entry for AuthorizationsUpdated(identity indexed, signer, expiry, permissions, origin).
 * Block 0x50 sits inside the window every test scans; a real node cannot answer
 * a bounded query with a log outside it.
 */
function authorizationLog(identity: Address, signer: Address, permissions: Hex[]): Record<string, unknown> {
  const data = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes32[]' }, { type: 'string' }],
    [signer, FUTURE, permissions, 'filecoin-pin']
  )
  return {
    address: REGISTRY,
    topics: [TOPIC, `0x000000000000000000000000${identity.slice(2)}`],
    data,
    blockNumber: '0x50',
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
 * entry repeats once the schedule runs out. eth_blockNumber answers `head`, or
 * walks `heads` call by call when the chain needs to advance under the watcher.
 */
function fakeClient(
  schedule: LogsAnswer[],
  options: { head?: string; heads?: string[] } = {}
): {
  client: Client<Transport, Chain>
  calls: RpcCall[]
} {
  const { head = '0x64', heads } = options
  const calls: RpcCall[] = []
  let call = 0
  let headCall = 0
  const client = {
    request: vi.fn(async (args: RpcCall) => {
      calls.push(args)
      if (args.method === 'eth_blockNumber') {
        if (heads === undefined) return head
        const next = heads[Math.min(headCall, heads.length - 1)]
        headCall += 1
        return next
      }
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
  it('scans the whole window from the block the wait started at, every poll', async () => {
    const { client, calls } = fakeClient([[], [], [authorizationLog(OWNER, SESSION, [])]], { head: '0x64' })
    vi.mocked(getExpirations).mockResolvedValue({ [CreateDataSetPermission]: FUTURE, [AddPiecesPermission]: FUTURE })

    const result = await watch({ ...base, client, fromBlock: 42n, deadlineMs: 2000 })

    expect(result.status).toBe('granted')
    // No cursor: a moving one would have to advance past a head some node may
    // not have, and the window is one wait long, so re-reading it is cheap.
    expect(scanStarts(calls)).toEqual(['0x2a', '0x2a', '0x2a'])
  })

  it('follows the chain forward, reading the head again on every poll', async () => {
    const { client, calls } = fakeClient([[], [], [authorizationLog(OWNER, SESSION, [])]], {
      heads: ['0x50', '0x60', '0x70'],
    })
    vi.mocked(getExpirations).mockResolvedValue({ [CreateDataSetPermission]: FUTURE, [AddPiecesPermission]: FUTURE })

    const result = await watch({ ...base, client, fromBlock: 42n, deadlineMs: 2000 })

    expect(result.status).toBe('granted')
    // A head read once and reused would pin every scan to the first answer.
    const scanEnds = calls
      .filter((c): c is { method: string; params: [{ toBlock: string }] } => c.method === 'eth_getLogs')
      .map((c) => c.params[0].toBlock)
    expect(scanEnds).toEqual(['0x50', '0x60', '0x70'])
  })

  it('asks for no logs while the endpoint reports a head below the block the wait started at', async () => {
    // [0x2a, 0x10] is inverted, and the RPC rejects it outright.
    const { client, calls } = fakeClient([[]], { head: '0x10' })

    const result = await watch({ ...base, client, fromBlock: 42n, deadlineMs: 20 })

    expect(result.status).toBe('timeout')
    expect(calls.filter((c) => c.method === 'eth_getLogs')).toEqual([])
  })

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
    // The scan names the head it read, never `latest`: the default Filecoin RPC
    // answers a numbered range in milliseconds and `latest` in tens of seconds.
    expect(calls.filter((c) => c.method === 'eth_getLogs')[0]).toMatchObject({
      method: 'eth_getLogs',
      params: [{ address: REGISTRY, fromBlock: '0x2a', toBlock: '0x64', topics: [TOPIC] }],
    })
    expect(vi.mocked(getExpirations)).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ sessionKeyAddress: SESSION, contractAddress: REGISTRY })
    )
  })

  it('never asks for `latest`, on any poll', async () => {
    const { client, calls } = fakeClient([[], [], []], { head: '0x64' })
    await watch({ ...base, client, fromBlock: 42n, deadlineMs: 20 })

    const scans = calls.filter(
      (c): c is { method: string; params: [{ toBlock: string }] } => c.method === 'eth_getLogs'
    )
    expect(scans.length).toBeGreaterThan(1)
    // Deduped, so the expected value is the head the fake reports, not a
    // reflection of whatever the scans happened to ask for.
    expect([...new Set(scans.map((c) => c.params[0].toBlock))]).toEqual(['0x64'])
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

  it('keeps polling past three lagging-node answers, which are a race, not an outage', async () => {
    // The exact text api.node.glif.io returns for a toBlock past the answering node.
    const behind = new Error('RPC Request failed.\n\nDetails: tipset height in future')
    const { client, calls } = fakeClient([behind, behind, behind, behind, [authorizationLog(OWNER, SESSION, [])]])
    vi.mocked(getExpirations).mockResolvedValue({ [CreateDataSetPermission]: FUTURE, [AddPiecesPermission]: FUTURE })

    const result = await watch({ ...base, client, fromBlock: 42n, deadlineMs: 2000 })

    expect(result.status).toBe('granted')
    expect(scanStarts(calls).length).toBeGreaterThan(3)
  })

  it('reports the timeout, not the RPC error, when every poll found a lagging node', async () => {
    const behind = new Error('RPC Request failed.\n\nDetails: tipset height in future')
    const { client } = fakeClient([behind])

    const result = await watch({ ...base, client, fromBlock: 42n, deadlineMs: 20 })

    // Throwing here would lose the line that says the key is saved.
    expect(result.status).toBe('timeout')
  })

  it('a lagging node clears the strikes two real failures put on the board', async () => {
    const behind = new Error('RPC Request failed.\n\nDetails: tipset height in future')
    const down = new Error('502 bad gateway')
    const { client } = fakeClient([down, down, behind, down, [authorizationLog(OWNER, SESSION, [])]])
    vi.mocked(getExpirations).mockResolvedValue({ [CreateDataSetPermission]: FUTURE, [AddPiecesPermission]: FUTURE })

    const result = await watch({ ...base, client, fromBlock: 42n, deadlineMs: 2000 })

    // Without the reset, failure three would end the wait before the grant.
    expect(result.status).toBe('granted')
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
