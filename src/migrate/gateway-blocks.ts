/**
 * Block-verified gateway retrieval for the migrate commP pass.
 *
 * `gateway.ts` fetches a CID's CAR as one HTTP response, and a response that
 * ends early at a block boundary parses cleanly: observed live when a
 * gateway served 257 KiB of a 5 MB DAG with a valid root and clean framing,
 * yielding a commitment over incomplete bytes. This module retrieves the DAG
 * one block at a time (each block hash-verified against its CID) and
 * serializes the canonical CAR locally (`car-export.ts`), so an unavailable
 * or truncated block fails the walk loudly and the bytes hashed are
 * byte-identical to what a spec-compliant gateway serves at the recorded URL.
 *
 * The block source is a single streaming `?format=car` request per root
 * (`car-stream-source.ts`): the gateway emits the DAG in the same depth-first
 * order the exporter walks, so retrieval latency is paid once for the stream
 * instead of once per block. A block the stream never delivers falls through
 * to a single `?format=raw` fetch; if that also fails the walk rejects. No
 * persistent node is held: each call owns its CAR stream and tears it down
 * when the export ends.
 */

import { CID } from 'multiformats/cid'
import { messagesOf } from './block-source.js'
import { exportCanonicalCar } from './car-export.js'
import { CarStreamSource, defaultGetCodec } from './car-stream-source.js'
import { buildCarUrl } from './car-url.js'
import type { FailureCategory } from './db.js'
import { GatewayError } from './gateway.js'
import { log } from './util.js'

/**
 * Map a stream/block failure onto the gateway failure categories that drive
 * retry and reporting. The source folds HTTP status into the error message
 * ("… received 504 Gateway Timeout"), so the status is recovered from the
 * message chain. A hash mismatch maps to `car_root_mismatch`: bad bytes from
 * this gateway, the same remediation as a wrong root.
 */
export function categorizeBlockError(err: unknown): FailureCategory {
  const msgs = messagesOf(err)
  const statusMatch = msgs.map((m) => /received (\d{3}) /.exec(m)).find((m) => m != null)
  const status = statusMatch?.[1] == null ? null : Number(statusMatch[1])
  if (status === 429) return 'source_gateway_429'
  if (status != null && status >= 500 && status < 600) return 'source_gateway_5xx'
  if (msgs.some((m) => /aborted/i.test(m))) return 'source_gateway_timeout'
  if (msgs.some((m) => /fetch failed|Failed to fetch/i.test(m))) return 'source_gateway_network'
  if (msgs.some((m) => /did not match multihash/.test(m))) return 'car_root_mismatch'
  return 'other'
}

/**
 * Retrieve a CID's DAG from one gateway via a single streaming CAR request and
 * emit the canonical CAR stream. Shape-compatible with `gateway.ts` `fetchCar`:
 * the recorded `url` is the gateway CAR URL, and `body` carries the
 * byte-identical canonical serialization. Failures, at start or mid-stream,
 * surface as `GatewayError` with a mapped category.
 */
export async function fetchCanonicalCar(
  gateway: string,
  cid: string,
  signal?: AbortSignal
): Promise<{ url: string; body: ReadableStream<Uint8Array> }> {
  const url = buildCarUrl(gateway, cid)
  const root = CID.parse(cid)
  const source = new CarStreamSource(gateway, { signal })

  async function* translated(): AsyncIterable<Uint8Array> {
    try {
      yield* exportCanonicalCar(source, defaultGetCodec, root, { signal })
      // The commitment is computed from the CAR stream a spec gateway serves
      // at the recorded URL. Any block recovered by the per-block fallback
      // means that CAR was incomplete or corrupt: a later re-fetch of the
      // same URL may not reproduce these bytes. Surface it so the operator
      // re-verifies the gateway.
      if (source.gapFillCount > 0) {
        log(
          `! gateway ${gateway} served an incomplete CAR for ${cid}: ${source.gapFillCount} block(s) ` +
            `recovered per-block. Re-verify this gateway: a re-fetch of the CAR URL may not reproduce these bytes.`
        )
      }
    } catch (err) {
      if (err instanceof GatewayError) throw err
      const message = err instanceof Error ? err.message : String(err)
      throw new GatewayError(`gateway ${gateway} block walk failed for ${cid}: ${message}`, {
        category: categorizeBlockError(err),
      })
    } finally {
      source.close()
    }
  }

  const from = (ReadableStream as unknown as { from(it: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> }).from
  return { url, body: from(translated()) }
}
