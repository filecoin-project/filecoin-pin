import type { PDPProvider } from '@filoz/synapse-sdk'
import { multiaddr } from '@multiformats/multiaddr'
import { multiaddrToUri } from '@multiformats/multiaddr-to-uri'
import type { CID } from 'multiformats/cid'
import type { Logger } from 'pino'
import { getErrorMessage } from './errors.js'
import type { ProgressEvent, ProgressEventHandler } from './types.js'

/**
 * Response structure from an IPNI indexer.
 *
 * The indexer returns provider records corresponding with each SP that advertised
 * a given CID to IPNI.
 * Each provider includes their peer ID and multiaddrs.
 */
interface IpniIndexerResponse {
  MultihashResults?: Array<{
    Multihash?: string
    ProviderResults?: ProviderResult[]
  }>
}

/**
 * A single provider's provider record from IPNI.
 *
 * Contains the provider's libp2p peer ID and an array of multiaddrs where
 * the content can be retrieved. These multiaddrs typically include the
 * provider's PDP service endpoint (e.g., /dns/provider.example.com/tcp/443/https).
 *
 * Note: this format matches what IPNI indexers return (see https://cid.contact/cid/bafybeigvgzoolc3drupxhlevdp2ugqcrbcsqfmcek2zxiw5wctk3xjpjwy for an example)
 */
interface ProviderResult {
  Provider?: {
    /** Libp2p peer ID of the storage provider */
    ID?: string
    /** Multiaddrs where this provider can serve the content */
    Addrs?: string[]
  }
}

/**
 * Per-CID failure classification produced by {@link waitForIpniProviderResults}.
 *
 * The `type` discriminator tells consumers what happened on the *last* attempt
 * for a given CID. Earlier intermediate failures (e.g. transient fetch errors)
 * may have been retried away and are not reported here.
 */
export type IpniFailureReason =
  | { type: 'timeout'; attempts: number; lastObservation?: string }
  | {
      type: 'missingProviders'
      attempts: number
      missingServiceUrls: string[]
      actualMultiaddrs: string[]
    }
  | { type: 'fetch'; attempts: number; message: string }
  | { type: 'parse'; attempts: number; message: string }
  | { type: 'http'; attempts: number; status: number; statusText?: string }
  | { type: 'aborted'; attempts: number }
  | { type: 'notAttempted' }

export interface IpniVerifiedEntry {
  cid: CID
  attempts: number
}

export interface IpniFailedEntry {
  cid: CID
  reason: IpniFailureReason
}

/**
 * Per-CID outcome of an IPNI validation walk.
 *
 * `success === true` iff every CID checked produced a `verified` entry.
 * Walk stops at the first per-CID failure; CIDs after that point appear in
 * `failed` with reason `{ type: 'notAttempted' }`.
 */
export interface IpniValidationOutcome {
  success: boolean
  ipniIndexerUrl: string
  verified: IpniVerifiedEntry[]
  failed: IpniFailedEntry[]
}

export type ValidateIPNIProgressEvents =
  | ProgressEvent<
      'ipniProviderResults.retryUpdate',
      {
        retryCount: number
        attempt: number
        totalAttempts: number
        cid: CID
        cidIndex: number
        cidCount: number
        cidAttempt: number
        cidMaxAttempts: number
      }
    >
  | ProgressEvent<'ipniProviderResults.outcome', { outcome: IpniValidationOutcome }>
  | ProgressEvent<'ipniProviderResults.complete', { result: true; retryCount: number }>
  | ProgressEvent<'ipniProviderResults.failed', { error: Error }>

export interface WaitForIpniProviderResultsOptions {
  /**
   * maximum number of attempts
   *
   * @default: 20
   */
  maxAttempts?: number | undefined

  /**
   * delay between attempts in milliseconds
   *
   * @default: 5000
   */
  delayMs?: number | undefined

  /**
   * Abort signal
   *
   * @default: undefined
   */
  signal?: AbortSignal | undefined

  /**
   * Logger instance
   *
   * @default: undefined
   */
  logger?: Logger | undefined

  /**
   * Providers that are expected to appear in the IPNI provider results. All
   * providers supplied here must be present in the response for the validation
   * to succeed. When omitted or empty, the validation when the IPNI
   * response is non-empty.
   *
   * @default: []
   */
  expectedProviders?: PDPProvider[] | undefined

  /**
   * Callback for progress updates
   *
   * @default: undefined
   */
  onProgress?: ProgressEventHandler<ValidateIPNIProgressEvents>

  /**
   * IPNI indexer URL to query for provider records to confirm that advertisements were processed.
   *
   * @default 'https://filecoinpin.contact'
   */
  ipniIndexerUrl?: string | undefined

  /**
   * Child blocks that must also be validated against expected providers.
   */
  childBlocks?: CID[] | undefined
}

/**
 * Check if the IPNI Indexer has the expected ProviderResults for the provided CIDs.
 *
 * Verifies the entire SP<->IPNI flow end-to-end:
 * - SPs announced the advertisement chain to the IPNI indexer
 * - The IPNI indexer pulled and indexed the chain
 *
 * Walks `[ipfsRootCid, ...childBlocks]` in order. Stops at the first CID that
 * fails to verify within `maxAttempts`. Throws `Error(msg, { cause: outcome })`
 * on any failure; the `cause` is an {@link IpniValidationOutcome} with per-CID
 * `verified` and `failed` lists. CIDs not yet walked at failure time appear in
 * `failed` with `reason.type === 'notAttempted'`.
 *
 * Should not be called until you receive confirmation from the SP that the
 * piece has been parked (e.g. `onPieceAdded` in `synapse.storage.upload`).
 *
 * @returns `true` when every CID verified.
 * @throws Error with `cause: IpniValidationOutcome` on any failure.
 */
export async function waitForIpniProviderResults(
  ipfsRootCid: CID,
  options?: WaitForIpniProviderResultsOptions
): Promise<boolean> {
  const outcome = await waitForIpniProviderResultsDetailed(ipfsRootCid, options)

  try {
    options?.onProgress?.({ type: 'ipniProviderResults.outcome', data: { outcome } })
  } catch (error) {
    options?.logger?.warn({ error }, 'Error in consumer onProgress callback for outcome event')
  }

  if (outcome.success) {
    try {
      // Legacy retryCount semantics: number of retryUpdate emissions across all CIDs minus 1.
      const totalAttempts = outcome.verified.reduce((sum, v) => sum + v.attempts, 0)
      const retryCount = totalAttempts > 0 ? totalAttempts - 1 : 0
      options?.onProgress?.({ type: 'ipniProviderResults.complete', data: { result: true, retryCount } })
    } catch (error) {
      options?.logger?.warn({ error }, 'Error in consumer onProgress callback for complete event')
    }
    return true
  }

  const error = buildOutcomeError(outcome, options)
  try {
    options?.onProgress?.({ type: 'ipniProviderResults.failed', data: { error } })
  } catch (callbackError) {
    options?.logger?.warn({ error: callbackError }, 'Error in consumer onProgress callback for failed event')
  }
  throw error
}

/**
 * Detailed variant: never throws on per-CID failures, always returns an
 * {@link IpniValidationOutcome} with full per-CID verified/failed lists.
 *
 * Use this when you need diagnostic visibility into which specific CIDs
 * verified vs. timed out vs. were aborted mid-walk. The boolean-returning
 * {@link waitForIpniProviderResults} is a thin wrapper around this function.
 */
export async function waitForIpniProviderResultsDetailed(
  ipfsRootCid: CID,
  options?: WaitForIpniProviderResultsOptions
): Promise<IpniValidationOutcome> {
  const delayMs = options?.delayMs ?? 5000
  const maxAttempts = options?.maxAttempts ?? 20
  const ipniIndexerUrl = options?.ipniIndexerUrl ?? 'https://filecoinpin.contact'
  const expectedProviders = options?.expectedProviders?.filter((provider) => provider != null) ?? []
  const { uriToServiceUrl, skippedProviderCount } = deriveExpectedUris(expectedProviders, options?.logger)
  const expectedUris = new Set(uriToServiceUrl.keys())
  const childBlocks = options?.childBlocks?.filter((cid) => cid != null) ?? []

  const hasProviderExpectations = expectedUris.size > 0

  if (!hasProviderExpectations && expectedProviders.length > 0 && skippedProviderCount > 0) {
    options?.logger?.info(
      { skippedProviderExpectationCount: skippedProviderCount, expectedProviders: expectedProviders.length },
      'No provider URIs derived from expected providers; falling back to generic IPNI validation'
    )
  }

  const cidsToValidate: CID[] = []
  const seenCidStrings = new Set<string>()
  for (const cid of [ipfsRootCid, ...childBlocks]) {
    const cidString = cid.toString()
    if (!seenCidStrings.has(cidString)) {
      cidsToValidate.push(cid)
      seenCidStrings.add(cidString)
    }
  }

  const totalAttempts = cidsToValidate.length * maxAttempts
  let totalChecks = 0

  const verified: IpniVerifiedEntry[] = []
  const failed: IpniFailedEntry[] = []

  for (const [index, cid] of cidsToValidate.entries()) {
    const result = await validateOneCid(cid, {
      delayMs,
      maxAttempts,
      ipniIndexerUrl,
      expectedUris,
      uriToServiceUrl,
      hasProviderExpectations,
      cidIndex: index + 1,
      cidCount: cidsToValidate.length,
      totalAttempts,
      onRetryUpdate: () => {
        totalChecks++
        return { retryCount: totalChecks - 1, attempt: totalChecks }
      },
      options,
    })

    if (result.verified) {
      verified.push({ cid, attempts: result.attempts })
      continue
    }

    failed.push({ cid, reason: result.reason })
    // Stop walking. Mark remaining CIDs as not attempted.
    for (let i = index + 1; i < cidsToValidate.length; i++) {
      const skipped = cidsToValidate[i]
      if (skipped != null) {
        failed.push({ cid: skipped, reason: { type: 'notAttempted' } })
      }
    }
    break
  }

  return {
    success: failed.length === 0,
    ipniIndexerUrl,
    verified,
    failed,
  }
}

type CidValidationResult =
  | { verified: true; attempts: number }
  | { verified: false; reason: IpniFailureReason; attempts: number }

interface ValidateOneCidConfig {
  delayMs: number
  maxAttempts: number
  ipniIndexerUrl: string
  expectedUris: Set<string>
  uriToServiceUrl: Map<string, string>
  hasProviderExpectations: boolean
  cidIndex: number
  cidCount: number
  totalAttempts: number
  onRetryUpdate: (() => { retryCount: number; attempt: number }) | undefined
  options: WaitForIpniProviderResultsOptions | undefined
}

async function validateOneCid(cid: CID, config: ValidateOneCidConfig): Promise<CidValidationResult> {
  const {
    delayMs,
    maxAttempts,
    ipniIndexerUrl,
    expectedUris,
    uriToServiceUrl,
    hasProviderExpectations,
    cidIndex,
    cidCount,
    totalAttempts,
    onRetryUpdate,
    options,
  } = config

  let retryCount = 0
  let lastReason: IpniFailureReason | null = null
  let lastActualMultiaddrs: Set<string> = new Set()
  let lastActualUris: Set<string> = new Set()

  while (true) {
    if (options?.signal?.aborted) {
      return { verified: false, reason: { type: 'aborted', attempts: retryCount }, attempts: retryCount }
    }

    options?.logger?.info(
      { event: 'check-ipni-announce', ipfsRootCid: cid.toString() },
      'Checking IPNI for announcement of IPFS CID "%s"',
      cid.toString()
    )

    const emittedRetryMetadata = onRetryUpdate?.()
    try {
      options?.onProgress?.({
        type: 'ipniProviderResults.retryUpdate',
        data: {
          retryCount: emittedRetryMetadata?.retryCount ?? retryCount,
          attempt: emittedRetryMetadata?.attempt ?? retryCount + 1,
          totalAttempts,
          cid,
          cidIndex,
          cidCount,
          cidAttempt: retryCount + 1,
          cidMaxAttempts: maxAttempts,
        },
      })
    } catch (error) {
      options?.logger?.warn({ error }, 'Error in consumer onProgress callback for retryUpdate event')
    }

    const fetchOptions: RequestInit = {
      headers: { Accept: 'application/json' },
    }
    if (options?.signal) {
      fetchOptions.signal = options?.signal
    }

    let response: Response | undefined
    try {
      response = await fetch(`${ipniIndexerUrl}/cid/${cid}`, fetchOptions)
    } catch (fetchError) {
      if (options?.signal?.aborted) {
        return { verified: false, reason: { type: 'aborted', attempts: retryCount + 1 }, attempts: retryCount + 1 }
      }
      lastActualMultiaddrs = new Set()
      lastActualUris = new Set()
      const message = getErrorMessage(fetchError)
      lastReason = { type: 'fetch', attempts: retryCount + 1, message }
      options?.logger?.warn({ error: fetchError }, `Failed to query IPNI indexer: ${message}. Retrying...`)
    }

    if (response?.ok) {
      let providerResults: ProviderResult[] = []
      try {
        const body = (await response.json()) as IpniIndexerResponse
        providerResults = (body.MultihashResults ?? []).flatMap((r) => r.ProviderResults ?? [])
        const rawAddrs = providerResults.flatMap((pr) => pr.Provider?.Addrs ?? [])
        lastActualMultiaddrs = new Set(rawAddrs)
        lastActualUris = new Set(rawAddrs.map(multiaddrToNormalizedUri))
        lastReason = null
      } catch (parseError) {
        lastActualMultiaddrs = new Set()
        lastActualUris = new Set()
        const message = getErrorMessage(parseError)
        lastReason = { type: 'parse', attempts: retryCount + 1, message }
        options?.logger?.warn({ error: parseError }, `Failed to parse IPNI response body: ${message}. Retrying...`)
      }

      if (providerResults.length > 0 && lastReason == null) {
        let isValid = false

        if (hasProviderExpectations) {
          const matchedUris = lastActualUris.intersection(expectedUris)
          isValid = matchedUris.size === expectedUris.size

          if (!isValid) {
            const missingUris = expectedUris.difference(matchedUris)
            const missingServiceUrls = Array.from(missingUris).map((uri) => uriToServiceUrl.get(uri) ?? uri)
            lastReason = {
              type: 'missingProviders',
              attempts: retryCount + 1,
              missingServiceUrls,
              actualMultiaddrs: Array.from(lastActualMultiaddrs),
            }
            options?.logger?.info(
              { missingServiceUrls, actualMultiaddrs: Array.from(lastActualMultiaddrs) },
              `Missing expected provider(s): ${missingServiceUrls.join(', ')}. Retrying...`
            )
          }
        } else {
          isValid = lastActualUris.size > 0
          if (!isValid) {
            lastReason = {
              type: 'missingProviders',
              attempts: retryCount + 1,
              missingServiceUrls: [],
              actualMultiaddrs: [],
            }
            options?.logger?.info('Expected at least one provider record. Retrying...')
          }
        }

        if (isValid) {
          return { verified: true, attempts: retryCount + 1 }
        }
      } else if (lastReason == null) {
        lastReason = {
          type: 'missingProviders',
          attempts: retryCount + 1,
          missingServiceUrls: hasProviderExpectations ? Array.from(uriToServiceUrl.values()) : [],
          actualMultiaddrs: [],
        }
        lastActualMultiaddrs = new Set()
        lastActualUris = new Set()
        options?.logger?.info(
          { providerResultsCount: providerResults?.length ?? 0 },
          'IPNI response did not include any provider results. Retrying...'
        )
      }
    } else if (response != null) {
      lastActualMultiaddrs = new Set()
      lastActualUris = new Set()
      lastReason = {
        type: 'http',
        attempts: retryCount + 1,
        status: response.status,
        statusText: response.statusText,
      }
      options?.logger?.info(
        { status: response.status, statusText: response.statusText },
        `IPNI indexer request failed with status ${response.status}. Retrying...`
      )
    }

    if (++retryCount < maxAttempts) {
      options?.logger?.info(
        { retryCount, maxAttempts },
        'IPFS CID "%s" not announced to IPNI yet (%d/%d). Retrying in %dms...',
        cid.toString(),
        retryCount,
        maxAttempts,
        delayMs
      )
      try {
        await abortableDelay(delayMs, options?.signal)
      } catch {
        return { verified: false, reason: { type: 'aborted', attempts: retryCount }, attempts: retryCount }
      }
      continue
    }

    const finalReason: IpniFailureReason = lastReason ?? {
      type: 'timeout',
      attempts: retryCount,
    }
    return { verified: false, reason: finalReason, attempts: retryCount }
  }
}

/**
 * Promise-based delay that rejects when `signal` aborts mid-sleep.
 *
 * Replaces `setTimeout` + `await` so an outer `AbortSignal.timeout(...)` does
 * not have to wait for the next fetch boundary to take effect.
 */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      if (signal != null) {
        signal.removeEventListener('abort', onAbort)
      }
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    if (signal != null) {
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/**
 * Build the legacy single-Error message + attach the structured outcome as
 * `cause` so consumers that want per-CID detail can read `error.cause`.
 *
 * Message format is preserved verbatim from prior versions for callers that
 * pattern-match on it (e.g. tests).
 */
function buildOutcomeError(
  outcome: IpniValidationOutcome,
  options: WaitForIpniProviderResultsOptions | undefined
): Error {
  const firstFailure = outcome.failed.find((f) => f.reason.type !== 'notAttempted') ?? outcome.failed[0]

  if (firstFailure == null) {
    const error = new Error('IPNI validation failed', { cause: outcome })
    return error
  }

  if (firstFailure.reason.type === 'aborted') {
    const error = new Error('Check IPNI announce aborted', {
      cause: { signal: options?.signal, outcome },
    })
    return error
  }

  const expectedProviders = options?.expectedProviders?.filter((p) => p != null) ?? []
  const { uriToServiceUrl } = deriveExpectedUris(expectedProviders, undefined)
  const hasProviderExpectations = uriToServiceUrl.size > 0
  const maxAttempts = options?.maxAttempts ?? 20

  const cid = firstFailure.cid
  const reason = firstFailure.reason
  const attempts = 'attempts' in reason ? reason.attempts : maxAttempts

  const msgBase = `IPFS CID "${cid.toString()}" does not have expected IPNI ProviderResults after ${attempts} attempt${attempts === 1 ? '' : 's'}`
  let msg = msgBase
  const lastObservation = formatLastObservation(reason)
  if (lastObservation != null) {
    msg = `${msgBase}. Last observation: ${lastObservation}`
  }
  if (hasProviderExpectations) {
    const actualMultiaddrs = reason.type === 'missingProviders' ? reason.actualMultiaddrs : []
    msg = `${msg}. Expected serviceURLs: [${Array.from(uriToServiceUrl.values()).join(', ')}]. Actual multiaddrs in response: [${actualMultiaddrs.join(', ')}]`
  }

  const error = new Error(msg, { cause: outcome })
  options?.logger?.warn({ error }, msg)
  return error
}

function formatLastObservation(reason: IpniFailureReason): string | undefined {
  switch (reason.type) {
    case 'missingProviders':
      if (reason.missingServiceUrls.length > 0) {
        return `Missing expected provider(s): ${reason.missingServiceUrls.join(', ')}`
      }
      return 'IPNI response did not include any provider results'
    case 'fetch':
      return `Failed to query IPNI indexer: ${reason.message}`
    case 'parse':
      return `Failed to parse IPNI response body: ${reason.message}`
    case 'http':
      return `IPNI indexer request failed with status ${reason.status}`
    case 'timeout':
      return reason.lastObservation
    case 'aborted':
    case 'notAttempted':
      return undefined
  }
}

/**
 * Convert a multiaddr string to a normalized URI for comparison.
 *
 * Different multiaddr representations of the same endpoint (e.g.
 * `/dns/host/tcp/443/https` and `/dns/host/https`) produce the same URI
 * (`https://host`), making comparison format-agnostic.
 *
 * Uses `@multiformats/multiaddr` + `@multiformats/multiaddr-to-uri` to parse
 * and convert. Paths (via `http-path`) are preserved.
 *
 * @param addr - A multiaddr string from an IPNI provider record
 * @returns The URI form, or the original string if conversion fails
 */
function multiaddrToNormalizedUri(addr: string): string {
  try {
    return multiaddrToUri(multiaddr(addr))
  } catch {
    return addr
  }
}

/**
 * Derive expected URIs from provider information for IPNI validation.
 *
 * For each provider, extracts their PDP serviceURL and normalizes it for
 * comparison against URIs derived from IPNI multiaddrs. This enables
 * format-agnostic matching regardless of multiaddr representation.
 *
 * @param providers - Array of provider info objects from synapse SDK
 * @param logger - Optional logger for diagnostics
 * @returns Map from normalized URI to original serviceURL, and count of providers that couldn't be processed
 */
function deriveExpectedUris(
  providers: PDPProvider[],
  logger: Logger | undefined
): {
  uriToServiceUrl: Map<string, string>
  skippedProviderCount: number
} {
  const uriToServiceUrl = new Map<string, string>()
  let skippedProviderCount = 0

  for (const provider of providers) {
    const serviceURL = provider.pdp?.serviceURL

    if (!serviceURL) {
      skippedProviderCount++
      logger?.warn({ provider }, 'Expected provider is missing a PDP serviceURL; skipping IPNI expectation')
      continue
    }

    try {
      const url = new URL(serviceURL)
      const normalized = url.href.replace(/\/+$/, '')
      uriToServiceUrl.set(normalized, serviceURL)
    } catch (error) {
      skippedProviderCount++
      const reason = getErrorMessage(error)
      logger?.warn({ provider, serviceURL, error }, `Unable to parse serviceURL: ${reason}; skipping IPNI expectation`)
    }
  }

  return {
    uriToServiceUrl,
    skippedProviderCount,
  }
}
