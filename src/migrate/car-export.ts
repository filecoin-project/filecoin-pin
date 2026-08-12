/**
 * Canonical CAR export over a block source with bounded-lookahead prefetch.
 *
 * Produces the trustless-gateway CAR framing. CARv1, single root, DFS
 * pre-order, first-occurrence dedup (`dups=n`), as a stream, while fetching
 * blocks ahead of the walk so retrieval latency overlaps instead of
 * serializing. The output is byte-identical to
 * `?format=car&dag-scope=all&car-version=1&car-order=dfs&car-dups=n` for the
 * same DAG: blocks are content-addressed, so only the serializer determines
 * the bytes, and this serializer mirrors the configuration validated against
 * the live gateway (`piece-cid-byte-identity` regression test).
 *
 * Memory bound: `lookahead` in-flight blocks plus the dedup set (multihash
 * bytes only, ~40 B per unique block). No full-DAG buffering: emitted
 * blocks are released to the consumer immediately.
 *
 * Emitted chunks may alias the block bytes the traversal still needs (the
 * CAR writer can yield a block's own `Uint8Array`): consumers must not
 * mutate a chunk or transfer its underlying buffer to another thread: copy
 * first. Detaching a chunk's buffer empties the not-yet-decoded block, and an
 * empty dag-pb decodes to zero links, ending the walk at that block.
 */

import { CarWriter } from '@ipld/car'
import { base64 } from 'multiformats/bases/base64'
import { createUnsafe } from 'multiformats/block'
import type { BlockView } from 'multiformats/block/interface'
import type { CID } from 'multiformats/cid'

/**
 * The reading surface the export needs. `get` may resolve to the block bytes
 * directly or to an (async) iterable of chunks.
 */
export interface BlockSource {
  get(
    cid: CID,
    options?: { signal?: AbortSignal | undefined }
  ):
    | Uint8Array
    | Promise<Uint8Array>
    | AsyncIterable<Uint8Array>
    | Iterable<Uint8Array>
    | Promise<AsyncIterable<Uint8Array>>
    | Promise<Iterable<Uint8Array>>
}

/** Normalize a `BlockSource.get` result to a single byte array. */
async function toBytes(result: ReturnType<BlockSource['get']>): Promise<Uint8Array> {
  const resolved = await result
  if (resolved instanceof Uint8Array) return resolved
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of resolved) {
    chunks.push(chunk)
    total += chunk.length
  }
  if (chunks.length === 1 && chunks[0] != null) return chunks[0]
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/**
 * Resolves a codec implementation from a CID codec code. May return the codec
 * synchronously or as a promise.
 */
export type GetCodec = (
  code: number
) =>
  | Promise<{ code: number; decode(bytes: Uint8Array): unknown }>
  | { code: number; decode(bytes: Uint8Array): unknown }

export interface ExportCanonicalCarOptions {
  /**
   * Maximum block fetches in flight ahead of the walk. Sized for many-small-
   * block DAGs (sharded directories): 32 × a typical 256 KiB UnixFS chunk is
   * ~8 MiB of lookahead.
   */
  lookahead?: number
  signal?: AbortSignal | undefined
}

export const DEFAULT_LOOKAHEAD = 32

const IDENTITY_MULTIHASH_CODE = 0x0

/** Exact dedup key: the multihash bytes, so CIDv0/v1 forms of a block collapse. */
function blockKey(cid: CID): string {
  return base64.encode(cid.multihash.bytes)
}

/**
 * Walk the DAG depth-first from `root` and emit CARv1 bytes in canonical
 * trustless-gateway framing. Blocks are fetched through `blocks.get` with up
 * to `lookahead` requests in flight ahead of the walk.
 */
export async function* exportCanonicalCar(
  blocks: BlockSource,
  getCodec: GetCodec,
  root: CID,
  opts: ExportCanonicalCarOptions = {}
): AsyncGenerator<Uint8Array, void, undefined> {
  const lookahead = opts.lookahead ?? DEFAULT_LOOKAHEAD
  // The walk always runs under a signal this generator owns: a consumer that
  // stops consuming (break, return(), throw upstream) would otherwise leave
  // the traversal running its prefetches (or parked forever on a
  // `writer.put` nobody will drain) with no way to reach it. The caller's
  // signal, when given, joins the same controller.
  const internal = new AbortController()
  const signal = internal.signal
  if (opts.signal != null) {
    if (opts.signal.aborted) internal.abort(opts.signal.reason)
    else opts.signal.addEventListener('abort', () => internal.abort(opts.signal?.reason), { once: true, signal })
  }
  const { writer, out } = CarWriter.create([root])

  const traversal = (async () => {
    try {
      await traverse(blocks, getCodec, root, writer, lookahead, signal)
    } finally {
      // With the consumer gone nothing drains the writer, so on the abort
      // path `close()` can never finish: leave it to settle on its own (it
      // holds only memory) instead of parking the teardown behind it.
      const closing = writer.close()
      if (signal.aborted) {
        void closing.catch(() => {
          // nothing is waiting on the writer anymore
        })
      } else {
        await closing
      }
    }
  })()
  // Surface the traversal error after the writer closes (below); without this
  // handler an early consumer break would leave the rejection unobserved.
  let traversalError: unknown
  traversal.catch((err) => {
    traversalError = err
  })

  try {
    for await (const chunk of out) {
      yield chunk
      if (traversalError != null) break
    }
    await traversal
  } finally {
    // Runs on normal completion (abort is then a no-op) and on every early
    // exit: stop the walk, then wait for it to settle so no fetch or parked
    // `writer.put` outlives the export.
    internal.abort(new Error('export consumer stopped'))
    await traversal.catch(() => {
      // the abort itself is the expected settlement here
    })
  }
}

/** `exportCanonicalCar` as a `ReadableStream`, for callers typed to fetch bodies. */
export function exportCanonicalCarStream(
  blocks: BlockSource,
  getCodec: GetCodec,
  root: CID,
  opts: ExportCanonicalCarOptions = {}
): ReadableStream<Uint8Array> {
  // ReadableStream.from ships in Node ≥20.6 but the bundled DOM lib types do
  // not declare it yet.
  const from = (ReadableStream as unknown as { from(it: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> }).from
  return from(exportCanonicalCar(blocks, getCodec, root, opts))
}

/**
 * Await `put`, but let an abort win: the promise itself is left to settle (or
 * not: a writer nobody drains holds only memory) with its rejection observed.
 */
function raceAbortPut(put: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal == null) return put
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      void put.catch(() => {
        // orphaned on abort; nothing consumes the writer anymore
      })
      reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'))
      return
    }
    const onAbort = () => {
      void put.catch(() => {
        // orphaned on abort; nothing consumes the writer anymore
      })
      reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    put.then(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      (err) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      }
    )
  })
}

async function traverse(
  blocks: BlockSource,
  getCodec: GetCodec,
  root: CID,
  writer: Pick<CarWriter, 'put'>,
  lookahead: number,
  signal?: AbortSignal
): Promise<void> {
  /** Multihashes already emitted (or queued for skip): exact `dups=n`. */
  const seen = new Set<string>()
  /** DFS stack; top of stack is the next block in canonical order. */
  const stack: CID[] = [root]
  /** Prefetched block bodies, keyed like `seen`. Bounded by `lookahead`. */
  const inflight = new Map<string, Promise<Uint8Array>>()

  function pump(): void {
    let pending = 0
    for (let i = stack.length - 1; i >= 0 && pending < lookahead; i--) {
      const cid = stack[i]
      if (cid == null) continue
      const key = blockKey(cid)
      if (seen.has(key)) continue
      if (cid.multihash.code === IDENTITY_MULTIHASH_CODE) continue
      pending++
      if (!inflight.has(key)) {
        const p = toBytes(blocks.get(cid, { signal }))
        // A prefetched fetch that fails before the walk reaches it must not
        // crash the process as an unhandled rejection; the walk re-awaits the
        // stored promise and surfaces the same error in order.
        p.catch(() => {
          // handled when the walk awaits the stored promise
        })
        inflight.set(key, p)
      }
    }
  }

  while (stack.length > 0) {
    signal?.throwIfAborted()
    pump()

    const cid = stack.pop()
    if (cid == null) break
    const key = blockKey(cid)
    if (seen.has(key)) continue
    seen.add(key)

    let bytes: Uint8Array
    if (cid.multihash.code === IDENTITY_MULTIHASH_CODE) {
      // Identity blocks carry their bytes in the multihash digest and are not
      // written to the CAR, but their links are still traversed.
      bytes = cid.multihash.digest
    } else {
      bytes = await (inflight.get(key) ?? toBytes(blocks.get(cid, { signal })))
      inflight.delete(key)
      // The put itself must lose to an abort: a consumer that stopped
      // draining the writer parks this promise forever, and the walk has to
      // be able to leave it behind.
      await raceAbortPut(writer.put({ cid, bytes }), signal)
    }

    const codec = await getCodec(cid.code)
    const block = createUnsafe({ cid, bytes, codec }) as BlockView
    // Push child links in reverse so the first link is popped first (DFS
    // pre-order, matching the gateway's car-order=dfs).
    const links: CID[] = []
    for (const [, linked] of block.links()) {
      links.push(linked as CID)
    }
    for (let i = links.length - 1; i >= 0; i--) {
      const link = links[i]
      if (link != null && !seen.has(blockKey(link))) stack.push(link)
    }
  }
}
