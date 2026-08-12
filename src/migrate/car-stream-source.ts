/**
 * One streaming CAR request per root, indexed and served block-by-block.
 *
 * The canonical exporter (`car-export.ts`) asks its `BlockSource` for one
 * block at a time, in depth-first pre-order. This source issues a single
 * `?format=car&dag-scope=all` request for the root and serves every
 * subsequent `get` from the streamed CAR. A trustless gateway emits that CAR
 * in the same depth-first, first-occurrence order the exporter walks, so
 * blocks arrive just before they are asked for and the reorder buffer stays
 * near-empty. The CAR is untrusted: every block is hash-verified against its
 * CID before it is served, so a truncated or corrupt stream can never reach
 * the piece hasher: a block the stream never delivers (or delivers wrong)
 * falls through to a single-block `?format=raw` fetch, and if that also fails
 * or mismatches the `get` rejects loudly.
 *
 * Gap-fill is a recovery, not a free pass: a block recovered by gap-fill
 * means the gateway's CAR was incomplete for this root, so a later re-fetch
 * of the CAR URL may not reproduce the locally computed commitment. The
 * source counts gap-fills (`gapFillCount`) so the caller can warn the
 * operator; a transient transport blip recovers and matches on retry, but a
 * deterministically broken CAR will fail on re-fetch.
 *
 * The reorder buffer is a HARD cap (`maxBufferedBlocks`): a non-waited block
 * past the cap is dropped, not retained, so a reordered or gap-laden stream
 * that keeps a waiter outstanding cannot grow the buffer to the whole DAG tail.
 */

import { CarBlockIterator } from '@ipld/car'
import * as dagCbor from '@ipld/dag-cbor'
import * as dagPb from '@ipld/dag-pb'
import { base64 } from 'multiformats/bases/base64'
import type { CID } from 'multiformats/cid'
import * as json from 'multiformats/codecs/json'
import * as raw from 'multiformats/codecs/raw'
import { sha256, sha512 } from 'multiformats/hashes/sha2'
import { BLOCK_RETRY_DELAYS_MS, isTransientBlockError } from './block-source.js'
import { buildCarUrl, buildRawBlockUrl, CAR_ACCEPT, RAW_ACCEPT } from './car-url.js'

/** The reading surface `car-export.ts` consumes. */
export interface BlockSource {
  get(cid: CID, options?: { signal?: AbortSignal }): Promise<Uint8Array>
}

const IDENTITY_MULTIHASH_CODE = 0x0
const SHA2_256_CODE = 0x12
const SHA2_512_CODE = 0x13

const HASHERS: Record<number, { digest(b: Uint8Array): { digest: Uint8Array } | Promise<{ digest: Uint8Array }> }> = {
  [SHA2_256_CODE]: sha256,
  [SHA2_512_CODE]: sha512,
}

const CODECS: Record<number, { code: number; decode(bytes: Uint8Array): unknown }> = {
  [dagPb.code]: dagPb,
  [dagCbor.code]: dagCbor,
  [raw.code]: raw,
  [json.code]: json,
}

/**
 * Resolve a codec for the exporter's link walk. Covers the codecs a trustless
 * UnixFS/IPLD CAR carries (dag-pb, dag-cbor, raw, json); an unknown codec
 * throws rather than silently dropping a block's links. Pass a custom resolver
 * to `exportCanonicalCar` when a DAG uses something exotic.
 */
export function defaultGetCodec(code: number): { code: number; decode(bytes: Uint8Array): unknown } {
  const codec = CODECS[code]
  if (codec == null) {
    throw new Error(`no codec for 0x${code.toString(16)}; pass a custom getCodec to decode this DAG`)
  }
  return codec
}

/** Exact dedup/index key: the multihash bytes, so CIDv0/v1 forms of a block collapse. */
function blockKey(cid: CID): string {
  return base64.encode(cid.multihash.bytes)
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** True iff `bytes` hash to `cid`'s multihash. Throws for a hash function we cannot verify. */
async function digestMatches(cid: CID, bytes: Uint8Array): Promise<boolean> {
  const code = cid.multihash.code
  // Identity blocks carry their bytes in the digest; the exporter handles them
  // inline and never asks the source for one, but verify defensively.
  if (code === IDENTITY_MULTIHASH_CODE) return bytesEqual(bytes, cid.multihash.digest)
  const hasher = HASHERS[code]
  if (hasher == null) {
    throw new Error(`no hasher for multihash code 0x${code.toString(16)}; cannot verify block ${cid}`)
  }
  const { digest } = await hasher.digest(bytes)
  return bytesEqual(digest, cid.multihash.digest)
}

/** Resolve after `ms`, rejecting immediately when `signal` aborts first. */
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError(signal))
      return
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(abortError(signal as AbortSignal))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

/** The abort reason, or a standard AbortError when none was given. */
function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

/**
 * Fetch `url`, retrying transient gateway failures (cold-backend 5xx/429,
 * dropped connection) with the shared backoff schedule. A non-OK status
 * becomes an error whose message carries the status code, so
 * `categorizeBlockError` can classify it.
 */
async function fetchOk(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, init)
      if (!res.ok) {
        // Release the error body's stream now. An abandoned body holds its
        // HTTP/2 stream (and connection window credit) until the runtime
        // collects it, which at commP-pass concurrency starves every other
        // request on the same connection.
        res.body?.cancel().catch(() => {
          // the stream may already be closed; either way it is released
        })
        throw new Error(`gateway request for ${url} received ${res.status} ${res.statusText}`)
      }
      return res
    } catch (err) {
      const delay = BLOCK_RETRY_DELAYS_MS[attempt]
      if (delay == null || init.signal?.aborted === true || !isTransientBlockError(err)) {
        throw err
      }
      // Abortable: a cancelled piece must not park its slot in a backoff.
      await sleep(delay, init.signal ?? undefined)
    }
  }
}

/**
 * The spec CAR request and parse behind the default `openCarStream`.
 * Exported so a caller composing its own opener reuses the exact request the
 * defaults make instead of re-templating it.
 */
export async function* openGatewayCarStream(
  gateway: string,
  root: CID,
  signal?: AbortSignal
): AsyncIterable<{ cid: CID; bytes: Uint8Array }> {
  const res = await fetchOk(buildCarUrl(gateway, root.toString()), {
    headers: { accept: CAR_ACCEPT },
    signal: signal ?? null,
  })
  if (res.body == null) throw new Error(`gateway ${gateway} returned no body for ${root}`)
  // Hold the body's reader here rather than handing the stream itself to the
  // CAR parser: once the parser locks the stream, `body.cancel()` rejects and
  // the HTTP stream would stay open. Cancelling through the reader works at
  // any point.
  const bodyReader = res.body.getReader()
  const bodyChunks = async function* (): AsyncGenerator<Uint8Array> {
    while (true) {
      const { done, value } = await bodyReader.read()
      if (done) return
      yield value
    }
  }
  try {
    const reader = await CarBlockIterator.fromIterable(bodyChunks())
    for await (const block of reader) {
      yield { cid: block.cid, bytes: block.bytes }
    }
  } finally {
    // Runs on normal completion, error, AND `iter.return()`: a race loser
    // whose generator is dropped mid-stream releases its HTTP/2 stream here
    // instead of waiting on the runtime to notice the abort. Cancelling a
    // fully-consumed body is a no-op.
    await bodyReader.cancel().catch(() => {
      // already closed or errored; the stream is released either way
    })
  }
}

/**
 * The single-block `?format=raw` request behind the default `fetchRawBlock`.
 * Exported for callers layering their own recovery after the gateway raw
 * fetch; the source hash-verifies whatever comes back.
 */
export async function fetchGatewayRawBlock(gateway: string, cid: CID, signal?: AbortSignal): Promise<Uint8Array> {
  const res = await fetchOk(buildRawBlockUrl(gateway, cid.toString()), {
    headers: { accept: RAW_ACCEPT },
    signal: signal ?? null,
  })
  return new Uint8Array(await res.arrayBuffer())
}

export interface CarStreamSourceOptions {
  /**
   * Open the CAR block stream for a root. Default: fetch
   * `?format=car&dag-scope=all…` and parse it with `@ipld/car`. Injectable so
   * the index/serve logic is testable without a network.
   */
  openCarStream?: (root: CID, signal?: AbortSignal) => AsyncIterable<{ cid: CID; bytes: Uint8Array }>
  /**
   * Fetch a single block the CAR stream did not cover. Default: a `?format=raw`
   * gateway request. The result is hash-verified before it is served.
   */
  fetchRawBlock?: (cid: CID, signal?: AbortSignal) => Promise<Uint8Array>
  /**
   * Soft cap on blocks parsed-but-not-yet-requested. The pump pauses at this
   * size only while no `get` is waiting, so a requested-but-not-yet-arrived
   * block always keeps the stream advancing (no reorder deadlock); the cap is
   * only ever exceeded transiently if the gateway's order skews from the
   * exporter's, which for a spec CAR it does not.
   */
  maxBufferedBlocks?: number
  /** Lifecycle signal: aborting it tears down the CAR fetch and rejects pending gets. */
  signal?: AbortSignal | undefined
}

export const DEFAULT_MAX_BUFFERED_BLOCKS = 128

/**
 * A `BlockSource` that fronts one streaming CAR request per root. Construct one
 * per export (it is scoped to the first CID it is asked for, treated as the
 * CAR root) and `close()` it when the export ends.
 */
export class CarStreamSource implements BlockSource {
  readonly #gateway: string
  readonly #maxBuffered: number
  readonly #openStream: (root: CID, signal?: AbortSignal) => AsyncIterable<{ cid: CID; bytes: Uint8Array }>
  readonly #fetchRaw: (cid: CID, signal?: AbortSignal) => Promise<Uint8Array>
  readonly #controller = new AbortController()

  #root: CID | null = null
  /** Parsed but not-yet-requested blocks, keyed by multihash. Bounded by `#maxBuffered`. */
  readonly #arrived = new Map<string, Uint8Array>()
  /** One-shot waiters per awaited key; resolved with bytes on arrival, null on stream end, rejected on abort. */
  readonly #waiters = new Map<
    string,
    Array<{ resolve: (b: Uint8Array | null) => void; reject: (e: unknown) => void }>
  >()
  #streamEnded = false
  #streamError: unknown = null
  /** Set while the pump is paused on a full buffer; called to resume it. */
  #wakePump: (() => void) | null = null
  #gapFillCount = 0
  #peakBuffered = 0

  /**
   * Blocks served by the single-block `?format=raw` fallback rather than the
   * CAR stream. A non-zero count means the gateway's CAR was incomplete or
   * corrupt for this root: the locally computed commitment may not match a
   * later re-fetch of the same URL, so the caller should re-verify the
   * gateway.
   */
  get gapFillCount(): number {
    return this.#gapFillCount
  }

  /** High-water mark of the reorder buffer, for tests asserting the hard cap. */
  get peakBuffered(): number {
    return this.#peakBuffered
  }

  constructor(gateway: string, opts: CarStreamSourceOptions = {}) {
    this.#gateway = gateway
    this.#maxBuffered = opts.maxBufferedBlocks ?? DEFAULT_MAX_BUFFERED_BLOCKS
    this.#openStream = opts.openCarStream ?? ((root, signal) => openGatewayCarStream(gateway, root, signal))
    this.#fetchRaw = opts.fetchRawBlock ?? ((cid, signal) => fetchGatewayRawBlock(gateway, cid, signal))
    if (opts.signal != null) {
      // Forward the reason: the caller's abort error (a stall watchdog, a user
      // cancel) must surface from rejected gets, not a bare "signal is aborted
      // without reason".
      const ext = opts.signal
      if (ext.aborted) this.#controller.abort(ext.reason)
      else ext.addEventListener('abort', () => this.#controller.abort(ext.reason), { once: true })
    }
    // Aborting tears down the CAR fetch (via #controller) and, crucially,
    // rejects any parked get right away: a parked waiter must not depend on a
    // possibly-hung stream noticing the abort first.
    this.#controller.signal.addEventListener(
      'abort',
      () => {
        this.#rejectAllWaiters(abortError(this.#controller.signal))
        this.#resumePump()
      },
      { once: true }
    )
  }

  async get(cid: CID, options?: { signal?: AbortSignal }): Promise<Uint8Array> {
    options?.signal?.throwIfAborted()
    const key = blockKey(cid)
    if (this.#root == null) {
      this.#root = cid
      void this.#pump(cid)
    }
    const buffered = this.#arrived.get(key)
    if (buffered != null) {
      this.#arrived.delete(key)
      this.#resumePump()
      return buffered
    }
    if (this.#streamEnded || this.#streamError != null) {
      return this.#gapFill(cid, options?.signal)
    }
    const delivered = await this.#awaitBlock(key, options?.signal)
    if (delivered != null) return delivered
    return this.#gapFill(cid, options?.signal)
  }

  /** Abort the CAR fetch and release any pending gets. Idempotent. */
  close(): void {
    this.#controller.abort()
    this.#resumePump()
  }

  #awaitBlock(key: string, signal?: AbortSignal): Promise<Uint8Array | null> {
    return new Promise((resolve, reject) => {
      if (this.#controller.signal.aborted) {
        reject(abortError(this.#controller.signal))
        return
      }
      if (signal?.aborted === true) {
        reject(abortError(signal))
        return
      }
      // The per-call signal (distinct from the source lifecycle) must also
      // release this specific parked get: without this a shared source would
      // hang one walk's get until the whole source closes.
      const waiter = { resolve, reject }
      if (signal != null) {
        const onAbort = (): void => {
          const list = this.#waiters.get(key)
          const i = list?.indexOf(waiter) ?? -1
          if (list != null && i !== -1) {
            list.splice(i, 1)
            if (list.length === 0) this.#waiters.delete(key)
          }
          reject(abortError(signal))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        waiter.resolve = (b) => {
          signal.removeEventListener('abort', onAbort)
          resolve(b)
        }
        waiter.reject = (e) => {
          signal.removeEventListener('abort', onAbort)
          reject(e)
        }
      }
      const arr = this.#waiters.get(key)
      if (arr == null) this.#waiters.set(key, [waiter])
      else arr.push(waiter)
      // A new waiter may need a block past a full buffer: keep the pump moving.
      this.#resumePump()
    })
  }

  #rejectAllWaiters(err: unknown): void {
    for (const [, arr] of this.#waiters) {
      for (const { reject } of arr) reject(err)
    }
    this.#waiters.clear()
  }

  #resumePump(): void {
    if (this.#wakePump != null) {
      const wake = this.#wakePump
      this.#wakePump = null
      wake()
    }
  }

  async #pump(root: CID): Promise<void> {
    try {
      for await (const { cid, bytes } of this.#openStream(root, this.#controller.signal)) {
        // A block whose bytes do not hash to its CID (or whose hash function
        // we cannot verify) is dropped, not indexed: whoever actually needs it
        // falls through to the verified gap-fill (which re-throws loudly for an
        // unknown hash). This localizes one bad or exotic frame instead of
        // tearing down the whole stream, and never poisons the index.
        let valid = false
        try {
          valid = await digestMatches(cid, bytes)
        } catch {
          valid = false
        }
        if (!valid) continue
        const key = blockKey(cid)
        const arr = this.#waiters.get(key)
        if (arr != null && arr.length > 0) {
          this.#waiters.delete(key)
          for (const { resolve } of arr) resolve(bytes)
        } else if (!this.#arrived.has(key) && this.#arrived.size < this.#maxBuffered) {
          this.#arrived.set(key, bytes)
          if (this.#arrived.size > this.#peakBuffered) this.#peakBuffered = this.#arrived.size
        }
        // else: a non-waited block past the buffer cap is dropped, not retained.
        // The exporter recovers it via verified gap-fill if it asks later. This
        // makes the cap a HARD bound: a reordered or gap-laden stream that keeps
        // a waiter outstanding can never balloon the buffer to the whole tail.
        //
        // Pause only while the buffer is full AND nothing is waiting; an
        // outstanding waiter means the exporter needs a block still ahead in
        // the stream, so keep reading (dropping overflow) to reach it.
        while (
          this.#arrived.size >= this.#maxBuffered &&
          this.#waiters.size === 0 &&
          !this.#controller.signal.aborted
        ) {
          await new Promise<void>((resolve) => {
            this.#wakePump = resolve
          })
        }
      }
      this.#streamEnded = true
    } catch (err) {
      this.#streamError = err
    } finally {
      // Release everyone still waiting; each falls through to gap-fill (which
      // surfaces the stream error or recovers the block over a fresh request).
      for (const [, arr] of this.#waiters) {
        for (const { resolve } of arr) resolve(null)
      }
      this.#waiters.clear()
    }
  }

  async #gapFill(cid: CID, signal?: AbortSignal): Promise<Uint8Array> {
    this.#gapFillCount++
    // Combine the per-call signal with the source lifecycle so `close()` always
    // tears down an in-flight raw fetch, even one started under a caller signal.
    const combined = signal == null ? this.#controller.signal : AbortSignal.any([this.#controller.signal, signal])
    const bytes = await this.#fetchRaw(cid, combined)
    if (!(await digestMatches(cid, bytes))) {
      throw new Error(`block ${cid} from gateway ${this.#gateway} did not match multihash from CID`)
    }
    return bytes
  }
}
