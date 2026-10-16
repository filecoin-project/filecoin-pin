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

const TIMEOUT_NAMES = new Set(['AbortError', 'TimeoutError'])
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
])

/**
 * Timeout vs network, by walking the error's `cause` chain: node:fetch wraps
 * transport errors in a TypeError whose `cause` carries the net/dns/undici
 * code, and an aborted signal is a DOMException named AbortError. Anything
 * unrecognized is a network failure.
 */
export function categoryForFetchError(err: unknown): FailureCategory {
  const seen = new Set<unknown>()
  for (let cur = err; cur != null && !seen.has(cur); cur = (cur as { cause?: unknown }).cause) {
    seen.add(cur)
    const { name, code } = cur as { name?: string; code?: string }
    if ((name != null && TIMEOUT_NAMES.has(name)) || (code != null && TIMEOUT_CODES.has(code))) {
      return 'source_gateway_timeout'
    }
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
