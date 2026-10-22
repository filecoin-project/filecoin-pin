/**
 * Trustless gateway access.
 *
 * Each CID is fetched as a CAR via the IPFS Trustless Gateway spec
 * (`?format=car&dag-scope=all`). The response is untrusted: `verify-car.ts`
 * hash-checks every block and walks the DAG for completeness before the
 * bytes count as migrated.
 *
 * No deadline is set here: undici's header and body timeouts (300 s each)
 * bound a stalled gateway and surface as `source_gateway_timeout`.
 */

import { buildCarUrl, CAR_ACCEPT } from './car-url.js'
import type { FailureCategory } from './db.js'

/** A staging failure (fetch or verify) carrying the resume store's category. */
export class StagingError extends Error {
  readonly category: FailureCategory
  constructor(message: string, category: FailureCategory, options?: ErrorOptions) {
    super(message, options)
    this.name = 'StagingError'
    this.category = category
  }
}

/** The category to record for a thrown error; anything not ours is `other`. */
export function failureCategoryOf(err: unknown): FailureCategory {
  return err instanceof StagingError ? err.category : 'other'
}

function categoryForStatus(status: number): FailureCategory {
  if (status === 429) return 'source_gateway_429'
  if (status === 404 || status === 410) return 'source_not_found'
  if (status >= 500 && status < 600) return 'source_gateway_5xx'
  return 'other'
}

// AbortError is a cancel, not a timeout; only AbortSignal.timeout yields TimeoutError.
const TIMEOUT_NAMES = new Set(['TimeoutError'])
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
])

type Causal = { name?: string; code?: string; message?: string; cause?: unknown }

/** The error and its `cause` chain, outermost first; stops on a cycle. */
function* causes(err: unknown): Generator<Causal> {
  const seen = new Set<unknown>()
  for (let cur = err; cur != null && !seen.has(cur); cur = (cur as Causal).cause) {
    seen.add(cur)
    yield cur as Causal
  }
}

/**
 * Timeout vs network: node's fetch wraps transport errors in a TypeError whose
 * `cause` carries the net/dns/undici code. Anything unrecognized is a network
 * failure.
 */
export function categoryForFetchError(err: unknown): FailureCategory {
  for (const { name, code } of causes(err)) {
    if ((name != null && TIMEOUT_NAMES.has(name)) || (code != null && TIMEOUT_CODES.has(code))) {
      return 'source_gateway_timeout'
    }
  }
  return 'source_gateway_network'
}

/** The innermost cause's code or message: the outer error usually says only "fetch failed". */
export function rootCause(err: unknown): string {
  let last: unknown = err
  for (const cur of causes(err)) last = cur
  if (typeof last !== 'object' || last == null) return String(last)
  const { code, message } = last as Causal
  return code ?? message ?? String(last)
}

function discardBody(res: Response): void {
  void res.body?.cancel().catch(() => undefined)
}

/** Fetch a CID as a CAR stream. Throws on non-2xx or a non-CAR content-type. */
export async function fetchCar(
  gateway: string,
  cid: string
): Promise<{ url: string; body: ReadableStream<Uint8Array> }> {
  const url = buildCarUrl(gateway, cid)
  let res: Response
  try {
    res = await fetch(url, { headers: { accept: CAR_ACCEPT } })
  } catch (err) {
    throw new StagingError(
      `gateway ${gateway} fetch failed for ${cid}: ${rootCause(err)}`,
      categoryForFetchError(err),
      {
        cause: err,
      }
    )
  }
  if (!res.ok) {
    discardBody(res)
    throw new StagingError(`gateway ${gateway} returned HTTP ${res.status} for ${cid}`, categoryForStatus(res.status))
  }
  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes(CAR_ACCEPT)) {
    // A file-mode gateway ignores ?format=car and returns the reassembled
    // file. That is unusable for CID preservation, so reject it loudly.
    discardBody(res)
    throw new StagingError(
      `gateway ${gateway} is not trustless: got content-type "${contentType}" instead of a CAR for ${cid}`,
      'other'
    )
  }
  if (res.body == null) {
    throw new StagingError(`gateway ${gateway} returned an empty body for ${cid}`, 'other')
  }
  return { url, body: res.body }
}
