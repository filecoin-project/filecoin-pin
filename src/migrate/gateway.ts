/**
 * Trustless gateway access.
 *
 * Each CID is fetched as a CAR via the IPFS Trustless Gateway spec
 * (`?format=car&dag-scope=all`). The response is untrusted: `verify-car.ts`
 * hash-checks every block and walks the DAG for completeness before the
 * bytes count as migrated.
 */

import { buildCarUrl, CAR_ACCEPT } from './car-url.js'
import type { FailureCategory } from './db.js'

/**
 * Error subclass thrown by `fetchCar` so callers can categorize failures by
 * kind instead of pattern-matching the error message.
 */
export class GatewayError extends Error {
  status?: number
  category: FailureCategory
  constructor(message: string, opts: { status?: number | undefined; category: FailureCategory }) {
    super(message)
    this.name = 'GatewayError'
    if (opts.status != null) {
      this.status = opts.status
    }
    this.category = opts.category
  }
}

function categoryForStatus(status: number): FailureCategory {
  if (status === 429) return 'source_gateway_429'
  if (status >= 500 && status < 600) return 'source_gateway_5xx'
  return 'other'
}

function categoryForFetchError(err: unknown): FailureCategory {
  // node:fetch wraps transport errors in a TypeError whose `cause` carries the
  // node:net / dns / undici code. The signal-aborted case surfaces as a
  // DOMException with name='AbortError'. Walk the chain rather than grep the
  // message string.
  const seen = new Set<unknown>()
  let cur: unknown = err
  while (cur != null && !seen.has(cur)) {
    seen.add(cur)
    const name = (cur as { name?: string }).name
    if (name === 'AbortError' || name === 'TimeoutError') return 'source_gateway_timeout'
    const code = (cur as { code?: string }).code
    if (
      code === 'ETIMEDOUT' ||
      code === 'UND_ERR_CONNECT_TIMEOUT' ||
      code === 'UND_ERR_HEADERS_TIMEOUT' ||
      code === 'UND_ERR_BODY_TIMEOUT'
    )
      return 'source_gateway_timeout'
    if (
      code === 'ECONNREFUSED' ||
      code === 'ECONNRESET' ||
      code === 'EHOSTUNREACH' ||
      code === 'ENETUNREACH' ||
      code === 'ENOTFOUND' ||
      code === 'EAI_AGAIN' ||
      code === 'UND_ERR_SOCKET'
    )
      return 'source_gateway_network'
    cur = (cur as { cause?: unknown }).cause
  }
  return 'source_gateway_network'
}

/** Fetch a CID as a CAR stream. Throws on non-2xx or a non-CAR content-type. */
export async function fetchCar(
  gateway: string,
  cid: string,
  signal?: AbortSignal
): Promise<{ url: string; body: ReadableStream<Uint8Array> }> {
  const url = buildCarUrl(gateway, cid)
  let res: Response
  try {
    res = await fetch(url, { headers: { accept: CAR_ACCEPT }, signal: signal ?? null })
  } catch (err) {
    throw new GatewayError(
      `gateway ${gateway} fetch failed for ${cid}: ${err instanceof Error ? err.message : String(err)}`,
      { category: categoryForFetchError(err) }
    )
  }
  if (!res.ok) {
    res.body?.cancel().catch(() => {
      // the stream may already be closed; either way it is released
    })
    throw new GatewayError(`gateway ${gateway} returned HTTP ${res.status} for ${cid}`, {
      status: res.status,
      category: categoryForStatus(res.status),
    })
  }
  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('application/vnd.ipld.car')) {
    // A file-mode gateway ignores ?format=car and returns the reassembled
    // file. That is unusable for CID preservation, so reject it loudly.
    res.body?.cancel().catch(() => {
      // release the unusable body
    })
    throw new GatewayError(
      `gateway ${gateway} is not trustless: got content-type "${contentType}" instead of a CAR for ${cid}`,
      { status: res.status, category: 'other' }
    )
  }
  if (res.body == null) {
    throw new GatewayError(`gateway ${gateway} returned an empty body for ${cid}`, {
      status: res.status,
      category: 'other',
    })
  }
  return { url, body: res.body }
}
