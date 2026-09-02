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
 *     `AuthorizationsUpdated` events from the block login started at, and
 *     match the `signer` field to our key. One small, bounded query per
 *     tick. The matching event names the owner.
 *  2. Owner known (renewal, or after the event was found): read the
 *     per-scope expiries directly. No events involved.
 *
 * Both paths end in the per-scope read, so partial grants (the owner
 * declined a scope in the console) are reported scope by scope.
 */

import { type Expirations, extractLoginEvent, getExpirations, type Permission } from '@filoz/synapse-core/session-key'
import { type Address, type Chain, type Client, isAddressEqual, type Log, type Transport, toEventSelector } from 'viem'

/** Default poll deadline: about five minutes (PRD decision #11). */
export const DEFAULT_WATCH_DEADLINE_MS = 5 * 60 * 1000
/** Default interval between registry polls. */
export const DEFAULT_WATCH_INTERVAL_MS = 5000

const AUTHORIZATIONS_UPDATED_TOPIC = toEventSelector(
  'AuthorizationsUpdated(address indexed identity,address signer,uint256 expiry,bytes32[] permissions,string origin)'
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
  /** Block to scan events from (the block `login` started at). Required when the owner is unknown. */
  fromBlock?: bigint
  /** Wallet owner, when already known (renewal). Skips the event scan; never replaced by one. */
  owner?: Address
  /** Give up after this long. Defaults to {@link DEFAULT_WATCH_DEADLINE_MS}. */
  deadlineMs?: number
  /** Time between polls. Defaults to {@link DEFAULT_WATCH_INTERVAL_MS}. */
  pollIntervalMs?: number
  /** Called before each poll with the time left, for a countdown. */
  onTick?: (remainingMs: number) => void
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
  /** `granted` when every requested scope is live, `partial` when some are, `timeout` when none arrived in time. */
  status: 'granted' | 'partial' | 'timeout'
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
  const status = scopes.missing.length === 0 ? 'granted' : scopes.granted.length === 0 ? 'none' : 'partial'
  return { status, owner: options.owner, ...scopes }
}

/**
 * One `eth_getLogs` query for `AuthorizationsUpdated` events on the registry
 * since `fromBlock`, returning the owner of the first event whose signer is
 * our session key. Mechanism 1.
 */
async function findOwnerInLogs(
  client: Client<Transport, Chain>,
  registryAddress: Address,
  sessionAddress: Address,
  fromBlock: bigint
): Promise<Address | undefined> {
  const logs = (await client.request({
    method: 'eth_getLogs',
    params: [
      {
        address: registryAddress,
        fromBlock: `0x${fromBlock.toString(16)}`,
        toBlock: 'latest',
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
      return event.args.identity
    }
  }
  return undefined
}

interface WatchState {
  owner: Address | undefined
  eventSeen: boolean
  last: WatchAuthorizationResult
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
    const found = await findOwnerInLogs(client, registryAddress, sessionAddress, fromBlock)
    if (found !== undefined) {
      state.owner = found
      state.eventSeen = true
    }
  }
  if (state.owner === undefined) return false

  const grants = await readScopeGrants({ client, sessionAddress, registryAddress, permissions, owner: state.owner })
  state.last = { ...grants, status: grants.status === 'none' ? 'timeout' : grants.status }
  return grants.status === 'granted' || state.eventSeen
}

/**
 * Poll until the session key is authorized or the deadline passes.
 *
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
  }

  for (;;) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) return state.last
    options.onTick?.(remainingMs)
    if (await pollOnce(options, state)) return state.last
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())))
  }
}
