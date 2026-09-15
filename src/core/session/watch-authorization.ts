/**
 * Wait for a session key to be authorized on-chain.
 *
 * `filecoin-pin login` prints a console link, and the wallet owner approves
 * the key in the browser. Nothing calls back to the CLI: the registry
 * contract is the shared state, so the CLI polls it.
 *
 * Two ways to detect the grant:
 *
 *  1. Owner unknown (first pairing): poll `eth_getLogs` for the registry's
 *     `AuthorizationsUpdated` events and match the `signer` field to our
 *     key. Every poll scans the same window, from the block login started
 *     at to the head it just read, so nothing has to be remembered between
 *     polls. The matching event names the owner.
 *  2. Owner known (renewal, or after the event was found): read the
 *     per-scope expiries directly. No events involved.
 *
 * Both paths end in the per-scope read, so partial grants (the owner
 * declined a scope in the console) are reported scope by scope.
 */

import { sessionKeyRegistry } from '@filoz/synapse-core/abis'
import { type Expirations, extractLoginEvent, getExpirations, type Permission } from '@filoz/synapse-core/session-key'
import {
  type Address,
  type Chain,
  type Client,
  getAbiItem,
  isAddressEqual,
  type Log,
  type Transport,
  toEventSelector,
} from 'viem'
import type { ProgressEventHandler } from '../utils/types.js'
import type { WatchAuthorizationProgressEvents } from './types.js'

/**
 * Default poll deadline. Long enough for the owner to open the link, find
 * the wallet, and approve; `login` says how to resume when it runs out.
 */
export const DEFAULT_WATCH_DEADLINE_MS = 5 * 60 * 1000
/** Default interval between registry polls. */
export const DEFAULT_WATCH_INTERVAL_MS = 5000
/**
 * Failed polls in a row before the wait gives up on the RPC endpoint. One
 * failure is a blip and must not end a wait the owner may be about to
 * finish; this many in a row means the endpoint is down, and the user
 * should hear that now rather than at the deadline. A lagging node never
 * counts (see {@link isNodeBehind}).
 */
export const MAX_CONSECUTIVE_POLL_FAILURES = 3

const AUTHORIZATIONS_UPDATED_TOPIC = toEventSelector(
  getAbiItem({ abi: sessionKeyRegistry, name: 'AuthorizationsUpdated' })
)

export interface WatchAuthorizationOptions {
  /** viem client for the target chain. */
  client: Client<Transport, Chain>
  /** Session key address waiting for approval. */
  sessionAddress: Address
  /** Session key registry contract address. */
  registryAddress: Address
  /** Scopes the user asked for; each is confirmed individually. */
  permissions: readonly Permission[]
  /** Start of the window every scan reads (the block `login` started at). Required when the owner is unknown. */
  fromBlock?: bigint
  /** Wallet owner, when already known (renewal). Skips the event scan; never replaced by one. */
  owner?: Address
  /** Give up after this long. Defaults to {@link DEFAULT_WATCH_DEADLINE_MS}. */
  deadlineMs?: number
  /** Time between polls. Defaults to {@link DEFAULT_WATCH_INTERVAL_MS}. */
  pollIntervalMs?: number
  /** Progress events: a tick before each poll, the owner once found, and per-poll RPC errors. */
  onProgress?: ProgressEventHandler<WatchAuthorizationProgressEvents>
}

/** Per-scope state read from the registry. */
export interface ScopeGrants {
  /** `granted` when every requested scope is live, `partial` when some are, `none` when none is. */
  status: 'granted' | 'partial' | 'none'
  /** Wallet owner the scopes were read for. */
  owner: Address
  /** Latest expiry (unix seconds) among the granted scopes. */
  expiry?: bigint
  /** Requested scopes that are live. */
  granted: Permission[]
  /** Requested scopes that are not live. */
  missing: Permission[]
}

export interface WatchAuthorizationResult {
  /**
   * `granted`: every requested scope is live. `partial`: some are. `none`:
   * the owner acted but none of the requested scopes is live. `timeout`:
   * the deadline passed without an authorization.
   */
  status: 'granted' | 'partial' | 'none' | 'timeout'
  /** Wallet owner that authorized the key. Absent on timeout when it was never learned. */
  owner?: Address
  /** Latest expiry (unix seconds) among the granted scopes. */
  expiry?: bigint
  /** Requested scopes that are live. */
  granted: Permission[]
  /** Requested scopes that are not live. */
  missing: Permission[]
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Split requested scopes into live and not-live using on-chain expiries. */
function classifyScopes(
  permissions: readonly Permission[],
  expirations: Expirations
): Pick<WatchAuthorizationResult, 'granted' | 'missing' | 'expiry'> {
  const now = BigInt(Math.floor(Date.now() / 1000))
  const granted: Permission[] = []
  const missing: Permission[] = []
  let expiry: bigint | undefined
  for (const permission of permissions) {
    const value = expirations[permission] ?? 0n
    if (value > now) {
      granted.push(permission)
      if (expiry === undefined || value > expiry) expiry = value
    } else {
      missing.push(permission)
    }
  }
  return expiry === undefined ? { granted, missing } : { granted, missing, expiry }
}

/**
 * Read the expiry of every requested scope for `owner` and classify them.
 * This is mechanism 2, and the confirmation step after mechanism 1.
 */
export async function readScopeGrants(
  options: Pick<WatchAuthorizationOptions, 'client' | 'sessionAddress' | 'registryAddress' | 'permissions'> & {
    owner: Address
  }
): Promise<ScopeGrants> {
  const expirations = await getExpirations(options.client, {
    address: options.owner,
    sessionKeyAddress: options.sessionAddress,
    permissions: [...options.permissions],
    contractAddress: options.registryAddress,
  })
  const scopes = classifyScopes(options.permissions, expirations)
  return { status: grantStatus(scopes), owner: options.owner, ...scopes }
}

function grantStatus(scopes: Pick<ScopeGrants, 'granted' | 'missing'>): ScopeGrants['status'] {
  if (scopes.missing.length === 0) return 'granted'
  if (scopes.granted.length === 0) return 'none'
  return 'partial'
}

/**
 * One `eth_getLogs` query for `AuthorizationsUpdated` events on the registry
 * between `fromBlock` and `toBlock`, returning the owner of the first event
 * whose signer is our session key. Mechanism 1.
 */
interface LogScan {
  owner?: Address
}

async function findOwnerInLogs(
  client: Client<Transport, Chain>,
  registryAddress: Address,
  sessionAddress: Address,
  fromBlock: bigint,
  toBlock: bigint
): Promise<LogScan> {
  const logs = (await client.request({
    method: 'eth_getLogs',
    params: [
      {
        address: registryAddress,
        fromBlock: `0x${fromBlock.toString(16)}`,
        // Never `latest`: the default Filecoin RPC answers it ~100x slower than
        // a numbered range, past viem's request timeout. See #720.
        toBlock: `0x${toBlock.toString(16)}`,
        topics: [AUTHORIZATIONS_UPDATED_TOPIC],
      },
    ],
  })) as Log[]

  for (const log of logs) {
    let event: ReturnType<typeof extractLoginEvent>
    try {
      event = extractLoginEvent([log])
    } catch {
      continue
    }
    if (isAddressEqual(event.args.signer, sessionAddress)) {
      const owner = event.args.identity
      return { owner }
    }
  }
  return {}
}

interface WatchState {
  owner: Address | undefined
  eventSeen: boolean
  last: WatchAuthorizationResult
  /** Whether any poll completed without an RPC error. */
  anySuccess: boolean
  /** Failed polls since the last successful one. */
  consecutiveFailures: number
  lastError: unknown
}

/**
 * One poll: while the owner is unknown, scan events for our signer; once
 * the owner is known (supplied or discovered) read the scope expiries. A
 * supplied owner is never replaced by an event. Returns true when the wait
 * is over.
 */
async function pollOnce(options: WatchAuthorizationOptions, state: WatchState): Promise<boolean> {
  const { client, sessionAddress, registryAddress, permissions, fromBlock } = options
  if (state.owner === undefined && fromBlock !== undefined) {
    const head = await headBlock(client)
    // A load-balanced endpoint can answer from a node that has not reached the
    // block the wait started at; [fromBlock, head] would be an inverted range,
    // which the RPC rejects. Nothing is there yet either way, so wait.
    if (head < fromBlock) return false
    // The whole window every poll, never a moving cursor: it spans one wait and
    // rereading it is cheap. A cursor would have to advance past a head some
    // node may not have, and would skip a reorg below itself.
    const scan = await findOwnerInLogs(client, registryAddress, sessionAddress, fromBlock, head)
    if (scan.owner !== undefined) {
      state.owner = scan.owner
      state.eventSeen = true
      options.onProgress?.({ type: 'watch:ownerFound', data: { owner: scan.owner } })
    }
  }
  if (state.owner === undefined) return false

  const grants = await readScopeGrants({ client, sessionAddress, registryAddress, permissions, owner: state.owner })
  // Without an event, a `none` read only means nothing has happened yet.
  state.last = grants.status === 'none' && !state.eventSeen ? { ...grants, status: 'timeout' } : grants
  // After the event, a `none` read may be a lagging RPC node: keep polling
  // and let the deadline report it.
  return grants.status === 'granted' || (state.eventSeen && grants.status !== 'none')
}

/** Current head block number. */
async function headBlock(client: Client<Transport, Chain>): Promise<bigint> {
  return BigInt((await client.request({ method: 'eth_blockNumber' })) as string)
}

/**
 * The endpoint answered from a node that has not reached the block the head
 * read just named. Lotus reports it as `tipset height in future`, seen from
 * api.node.glif.io on 2026-09-14 for a `toBlock` 100 blocks past the head.
 *
 * The head read and the scan are two calls, so a load-balanced endpoint can
 * serve the second from a node behind the first. That is one poll racing the
 * pool, not an endpoint that is down, so it must not spend a strike: three of
 * them in a row would otherwise end the wait for a grant that is on chain,
 * which is the failure this whole module exists to avoid.
 */
function isNodeBehind(error: unknown): boolean {
  return /tipset height in future/i.test(error instanceof Error ? error.message : String(error))
}

/**
 * Run one poll, tolerating RPC errors: a single failed request must not end
 * a five-minute wait after the owner already approved in the browser, and a
 * lagging node is not a failed request at all.
 */
async function pollTolerantly(options: WatchAuthorizationOptions, state: WatchState): Promise<boolean> {
  try {
    const done = await pollOnce(options, state)
    state.anySuccess = true
    state.consecutiveFailures = 0
    return done
  } catch (error) {
    state.lastError = error
    if (isNodeBehind(error)) {
      // The endpoint answered, just from a node that has not caught up. That is
      // the same situation as the `head < fromBlock` skip, which counts as a
      // completed poll, so this counts as one too: strikes clear, and a wait
      // made only of these reports the timeout that names the saved key rather
      // than throwing an RPC error at the deadline.
      state.anySuccess = true
      state.consecutiveFailures = 0
    } else {
      state.consecutiveFailures += 1
    }
    options.onProgress?.({ type: 'watch:error', data: { error } })
    return false
  }
}

/** The error `login` shows when the endpoint failed {@link MAX_CONSECUTIVE_POLL_FAILURES} polls in a row. */
function endpointDownError(lastError: unknown): Error {
  const reason = lastError instanceof Error ? lastError.message : String(lastError)
  return new Error(
    `The RPC endpoint failed ${MAX_CONSECUTIVE_POLL_FAILURES} polls in a row (${reason}). Your key is saved; rerun \`filecoin-pin login\` to resume.`,
    { cause: lastError }
  )
}

/**
 * Poll until the session key is authorized or the deadline passes.
 *
 * RPC errors on individual polls are reported through `onProgress` and the
 * wait continues. The wait throws once {@link MAX_CONSECUTIVE_POLL_FAILURES}
 * polls fail in a row, or at the deadline when no poll ever succeeded.
 * A complete grant ends the wait at once. A new `AuthorizationsUpdated`
 * event also ends it, with whatever the read shows, because the console
 * grants every approved scope in one transaction: a shortfall after the
 * event is the owner's decision, not a race. Without an event, a partial
 * read (a pre-existing grant) keeps polling until the deadline.
 */
export async function watchAuthorization(options: WatchAuthorizationOptions): Promise<WatchAuthorizationResult> {
  if (options.owner === undefined && options.fromBlock === undefined) {
    throw new Error('watchAuthorization needs either owner or fromBlock')
  }
  const deadlineMs = options.deadlineMs ?? DEFAULT_WATCH_DEADLINE_MS
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS
  const deadline = Date.now() + deadlineMs
  const state: WatchState = {
    owner: options.owner,
    eventSeen: false,
    last: { status: 'timeout', granted: [], missing: [...options.permissions] },
    anySuccess: false,
    consecutiveFailures: 0,
    lastError: undefined,
  }

  for (;;) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) break
    options.onProgress?.({ type: 'watch:tick', data: { remainingMs } })
    if (await pollTolerantly(options, state)) return state.last
    if (state.consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) throw endpointDownError(state.lastError)
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())))
  }
  // Every poll failed: the RPC endpoint, not the owner, is the problem.
  if (!state.anySuccess && state.lastError !== undefined) throw state.lastError
  return state.last
}
