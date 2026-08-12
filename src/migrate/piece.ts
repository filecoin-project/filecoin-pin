/**
 * Compute a Filecoin piece commitment (PieceCID v2, FRC-0069) over a CAR
 * stream, while verifying the CAR is rooted at the expected CID.
 *
 * The CAR bytes come from the block-verified canonical path
 * (`gateway-blocks.ts`): the DAG is pulled over one streaming CAR request,
 * every block hash-checked, and the canonical CAR serialized locally: never a
 * raw gateway response, which can end early at a block boundary and still
 * parse cleanly.
 *
 * The hash is computed in a single streaming pass: the CAR bytes are never
 * fully buffered, so this scales to large pieces with bounded memory. The
 * hasher is `@filoz/synapse-core/piece`'s, the same implementation the SDK
 * uses, so the local commitment and the SDK's agree by construction.
 */

import { createHash } from 'node:crypto'
import { hasher } from '@filoz/synapse-core/piece'
import { CarBlockIterator } from '@ipld/car'
import { CID } from 'multiformats/cid'
import type { FailureCategory, MigrationDB } from './db.js'
import { GatewayError } from './gateway.js'
import { fetchCanonicalCar } from './gateway-blocks.js'
import { log } from './util.js'

/**
 * Error subclass used internally by piece-compute callers to surface a failure
 * category alongside the message, mirroring `GatewayError` for CAR-level
 * failures (root mismatch, etc.).
 */
export class PieceComputeError extends Error {
  category: FailureCategory
  constructor(message: string, category: FailureCategory) {
    super(message)
    this.name = 'PieceComputeError'
    this.category = category
  }
}

/** Read a category off a thrown error, falling back to `other`. */
export function categoryOf(err: unknown): FailureCategory {
  if (err instanceof GatewayError) return err.category
  if (err instanceof PieceComputeError) return err.category
  return 'other'
}

export interface PieceResult {
  /** The original IPFS CID (the CAR root). Preserved end-to-end. */
  cid: string
  /** PieceCID v2: the value uploaded and committed on chain. */
  pieceCid: string
  /** CAR byte length (the piece payload size). */
  rawSize: number
  /** Gateway that served the winning fetch. */
  gateway: string
  /** URL the piece commitment was computed from. */
  url: string
  /**
   * sha256 of the exact CAR bytes that produced this PieceCID. Captured at
   * first successful fetch and treated as the canonical bytes signature for
   * the CID. CAR bytes can drift between sources (block order, dup handling)
   * and PieceCID was computed against the original; mismatch means re-commP.
   */
  memberSha256: string
}

/**
 * Stream a CAR through the piece hasher, a sha256 tap, and the CAR parser at
 * once. Returns the PieceCID v2, the raw CAR byte length, the sha256 of those
 * same bytes, and the CAR's declared roots.
 */
async function computePiece(
  body: ReadableStream<Uint8Array>
): Promise<{ pieceCid: string; rawSize: number; sha256: string; roots: CID[] }> {
  const pieceHasher = hasher()
  const sha = createHash('sha256')
  let rawSize = 0

  // Tap every chunk on the way to the CAR parser: feed the piece hasher, the
  // sha256 digest, and the byte counter. Draining the block iterator pulls the
  // whole stream through.
  async function* tap(): AsyncIterable<Uint8Array> {
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      pieceHasher.write(chunk)
      sha.update(chunk)
      rawSize += chunk.length
      yield chunk
    }
  }

  const reader = await CarBlockIterator.fromIterable(tap())
  // Consume all blocks so the entire CAR flows through the hasher. Block data is
  // not retained; only its passage matters for the commitment.
  for await (const _block of reader) {
    // drain
  }
  const roots = await reader.getRoots()

  const pieceCid = pieceHasher.finalize().toString()
  return { pieceCid, rawSize, sha256: sha.digest('hex'), roots }
}

/**
 * The CAR-fetching surface `fetchAndComputePiece` depends on, injected so the
 * gateway-fallthrough and root-mismatch control flow can be tested with
 * in-memory CAR streams (no network). Production uses the real canonical
 * gateway fetcher.
 */
export interface PieceFetchDeps {
  fetchCar: typeof fetchCanonicalCar
}

const defaultPieceFetchDeps: PieceFetchDeps = { fetchCar: fetchCanonicalCar }

/**
 * Retrieve a CID's DAG block-by-block from the first working gateway (each
 * block hash-verified), compute its PieceCID v2 over the locally serialized
 * canonical CAR, and verify the root matches the requested CID. Tries
 * gateways in order; the first whose walk completes wins.
 */
export async function fetchAndComputePiece(
  cid: string,
  gateways: string[],
  deps: PieceFetchDeps = defaultPieceFetchDeps
): Promise<PieceResult> {
  const expected = CID.parse(cid)
  const errors: string[] = []
  const categories: FailureCategory[] = []

  for (const gateway of gateways) {
    try {
      const { url, body } = await deps.fetchCar(gateway, cid)
      const { pieceCid, rawSize, sha256, roots } = await computePiece(body)

      const rootMatch = roots.some((r) => r.equals(expected) || r.toString() === cid)
      if (!rootMatch) {
        throw new PieceComputeError(
          `CAR root mismatch: expected ${cid}, CAR declares [${roots.map((r) => r.toString()).join(', ')}]`,
          'car_root_mismatch'
        )
      }

      log(`  ok ${cid} gateway=${gateway} sha256=${sha256.slice(0, 16)}…`)
      return { cid, pieceCid, rawSize, gateway, url, memberSha256: sha256 }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push(`${gateway}: ${message}`)
      categories.push(categoryOf(err))
      log(`  ! ${cid} via ${gateway} failed: ${message}`)
    }
  }

  // Pick the most-specific category seen across gateways: if categories
  // diverge, prefer any non-`other` over `other`.
  const aggregated = categories.find((c) => c !== 'other') ?? 'other'
  throw new PieceComputeError(`all gateways failed for ${cid}\n    ${errors.join('\n    ')}`, aggregated)
}

/** Record a computed piece as done. Single chokepoint for the commP pass. */
export function recordPieceOutcome(db: MigrationDB, cid: string, piece: PieceResult): void {
  db.recordPieceSuccess(cid, piece.pieceCid, piece.rawSize, piece.gateway, piece.url, piece.memberSha256)
}
