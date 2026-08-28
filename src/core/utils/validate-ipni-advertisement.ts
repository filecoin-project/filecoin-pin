import type { PDPProvider, PieceCID } from '@filoz/synapse-sdk'
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

/** Response shape from Curio's `GET /pdp/piece/{pieceCid}/status`. Only `synced` is used. */
interface PdpPieceStatusResponse {
  synced?: boolean
}

export type ValidateIPNIProgressEvents =
  | ProgressEvent<
      'ipniProviderResults:retryUpdate',
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
  | ProgressEvent<'ipniProviderResults:complete', { result: true; retryCount: number }>
  | ProgressEvent<'ipniProviderResults:failed', { error: Error }>

export interface CheckIpniIndexerOptions {
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
   * IPNI indexer URL to query for provider records. Required — this function has no way
   * to know whether it's safe to poll the given indexer patiently (e.g. cid.contact
   * negative-caches misses for minutes, see content-routing-faq.md), so callers must
   * decide explicitly rather than inherit a default that may not fit their situation.
   */
  ipniIndexerUrl: string

  /**
   * Child blocks that must also be validated against expected providers.
   */
  childBlocks?: CID[] | undefined
}

/**
 * Check if the IPNI Indexer has the provided ProviderResults for the provided ipfsRootCid.
 * This effectively verifies the entire SP<->IPNI flow, including:
 * - The SP announced the advertisement chain to the IPNI indexer(s)
 * - The IPNI indexer(s) pulled the advertisement chain from the SP
 * - The IPNI indexer(s) updated their index
 * This doesn't check individual steps, but rather the end ProviderResults reponse from the IPNI indexer.
 * If the IPNI indexer ProviderResults have the expected providers, then the steps above must have completed.
 * This doesn't actually do any IPFS Mainnet retrieval checks of the ipfsRootCid.
 *
 * Generic single-indexer primitive. `waitForIndexingConfirmation` below is the default
 * post-upload check; this is exposed separately because it's also useful standalone
 * (e.g. a one-off cross-check against a second indexer).
 *
 * @param ipfsRootCid - The IPFS root CID to check
 * @param options - Options for the check
 * @returns True if the IPNI announce succeeded, false otherwise
 */
export async function checkIpniIndexer(ipfsRootCid: CID, options: CheckIpniIndexerOptions): Promise<boolean> {
  const delayMs = options?.delayMs ?? 5000
  const maxAttempts = options?.maxAttempts ?? 20
  const ipniIndexerUrl = options.ipniIndexerUrl
  const expectedProviders = options?.expectedProviders?.filter((provider) => provider != null) ?? []
  const { uriToServiceUrl, skippedProviderCount } = deriveExpectedUris(expectedProviders, options?.logger)
  const expectedUris = new Set(uriToServiceUrl.keys())
  const childBlocks = options?.childBlocks?.filter((cid) => cid != null) ?? []

  const hasProviderExpectations = expectedUris.size > 0

  // Log a warning if we expected providers but couldn't derive their URIs
  // In this case, we fall back to generic validation (just checking if there are any provider records for the CID)
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

  try {
    for (const [index, cid] of cidsToValidate.entries()) {
      await checkIpniIndexerForCid(cid, {
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
    }

    try {
      // totalChecks is incremented before each emitted retryUpdate, so last retryCount is totalChecks - 1
      const retryCount = totalChecks > 0 ? totalChecks - 1 : 0
      options?.onProgress?.({ type: 'ipniProviderResults:complete', data: { result: true, retryCount } })
    } catch (error) {
      options?.logger?.warn({ error }, 'Error in consumer onProgress callback for complete event')
    }

    return true
  } catch (error) {
    try {
      options?.onProgress?.({ type: 'ipniProviderResults:failed', data: { error: error as Error } })
    } catch (callbackError) {
      options?.logger?.warn({ error: callbackError }, 'Error in consumer onProgress callback for failed event')
    }
    throw error
  }
}

/** `queriedSuccessfully` separates a genuine not-found result from a transport/parse/HTTP failure. */
class IndexerQueryFailedError extends Error {
  readonly queriedSuccessfully: boolean
  constructor(message: string, queriedSuccessfully: boolean) {
    super(message)
    this.name = 'IndexerQueryFailedError'
    this.queriedSuccessfully = queriedSuccessfully
  }
}

async function checkIpniIndexerForCid(
  cid: CID,
  config: {
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
    options: CheckIpniIndexerOptions | undefined
  }
): Promise<boolean> {
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
  } = config
  const { onRetryUpdate } = config
  const { options } = config

  return new Promise<boolean>((resolve, reject) => {
    let retryCount = 0
    // Tracks the most recent validation failure reason for error reporting
    let lastFailureReason: string | undefined
    // True once a response was fetched and parsed cleanly, even if results didn't match
    let lastQuerySucceeded = false
    // Tracks the normalized URIs (for comparison) and raw multiaddrs (for display) from the last IPNI response
    let lastActualUris: Set<string> = new Set()
    let lastActualMultiaddrs: Set<string> = new Set()

    const check = async (): Promise<void> => {
      if (options?.signal?.aborted) {
        throw new Error('Check IPNI announce aborted', { cause: options?.signal })
      }

      options?.logger?.info(
        {
          event: 'check-ipni-announce',
          ipfsRootCid: cid.toString(),
        },
        'Checking IPNI for announcement of IPFS CID "%s"',
        cid.toString()
      )

      // Emit progress event for this attempt
      const emittedRetryMetadata = onRetryUpdate?.()
      try {
        options?.onProgress?.({
          type: 'ipniProviderResults:retryUpdate',
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

      // Fetch IPNI provider records
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
        lastActualMultiaddrs = new Set()
        lastActualUris = new Set()
        lastQuerySucceeded = false
        lastFailureReason = `Failed to query IPNI indexer: ${getErrorMessage(fetchError)}`
        options?.logger?.warn({ error: fetchError }, `${lastFailureReason}. Retrying...`)
      }

      // Parse and validate response
      if (response?.ok) {
        let providerResults: ProviderResult[] = []
        try {
          const body = (await response.json()) as IpniIndexerResponse
          // Extract provider results
          providerResults = (body.MultihashResults ?? []).flatMap((r) => r.ProviderResults ?? [])
          // Extract raw multiaddrs for display and normalized URIs for comparison.
          // URI comparison is format-agnostic: both `/dns/host/tcp/443/https`
          // and `/dns/host/https` normalize to `https://host`.
          const rawAddrs = providerResults.flatMap((pr) => pr.Provider?.Addrs ?? [])
          lastActualMultiaddrs = new Set(rawAddrs)
          lastActualUris = new Set(rawAddrs.map(multiaddrToNormalizedUri))
          lastFailureReason = undefined
          lastQuerySucceeded = true
        } catch (parseError) {
          // Clear actual multiaddrs on parse error
          lastActualMultiaddrs = new Set()
          lastActualUris = new Set()
          lastQuerySucceeded = false
          lastFailureReason = `Failed to parse IPNI response body: ${getErrorMessage(parseError)}`
          options?.logger?.warn({ error: parseError }, `${lastFailureReason}. Retrying...`)
        }

        // Check if we have provider results to validate
        if (providerResults.length > 0) {
          let isValid = false

          if (hasProviderExpectations) {
            // Find matching URIs and compute which are missing
            const matchedUris = lastActualUris.intersection(expectedUris)
            isValid = matchedUris.size === expectedUris.size

            if (!isValid) {
              // Compute only the missing serviceURLs for precise diagnostics
              const missingUris = expectedUris.difference(matchedUris)
              const missingServiceUrls = Array.from(missingUris).map((uri) => uriToServiceUrl.get(uri) ?? uri)
              lastFailureReason = `Missing expected provider(s): ${missingServiceUrls.join(', ')}`
              options?.logger?.info(
                {
                  missingServiceUrls,
                  actualMultiaddrs: Array.from(lastActualMultiaddrs),
                },
                `${lastFailureReason}. Retrying...`
              )
            }
          } else {
            // Generic validation: just need any provider with addresses
            isValid = lastActualUris.size > 0
            if (!isValid) {
              lastFailureReason = 'Expected at least one provider record'
              options?.logger?.info(`${lastFailureReason}. Retrying...`)
            }
          }

          if (isValid) {
            // Validation succeeded!
            resolve(true)
            return
          }
        } else if (lastFailureReason == null) {
          // Only set generic message if we don't already have a more specific reason (e.g., parse error)
          lastFailureReason = 'IPNI response did not include any provider results'
          // Track that we got an empty response
          lastActualMultiaddrs = new Set()
          lastActualUris = new Set()
          options?.logger?.info(
            { providerResultsCount: providerResults?.length ?? 0 },
            `${lastFailureReason}. Retrying...`
          )
        }
      } else if (response != null) {
        lastActualMultiaddrs = new Set()
        lastActualUris = new Set()
        // A 404 is how this API reports "no results for this CID" — a genuine query, not a failure.
        lastQuerySucceeded = response.status === 404
        lastFailureReason = `IPNI indexer request failed with status ${response.status}`
        options?.logger?.info(
          { status: response.status, statusText: response.statusText },
          `${lastFailureReason}. Retrying...`
        )
      }

      // Retry or fail
      if (++retryCount < maxAttempts) {
        options?.logger?.info(
          { retryCount, maxAttempts },
          'IPFS CID "%s" not announced to IPNI yet (%d/%d). Retrying in %dms...',
          cid.toString(),
          retryCount,
          maxAttempts,
          delayMs
        )
        await abortableDelay(delayMs, options?.signal, 'Check IPNI announce aborted')
        await check()
      } else {
        // Max attempts reached - validation failed
        const msgBase = `IPFS CID "${cid.toString()}" does not have expected IPNI ProviderResults after ${maxAttempts} attempt${maxAttempts === 1 ? '' : 's'}`
        let msg = msgBase
        if (lastFailureReason != null) {
          msg = `${msgBase}. Last observation: ${lastFailureReason}`
        }
        if (hasProviderExpectations) {
          msg = `${msg}. Expected serviceURLs: [${Array.from(uriToServiceUrl.values()).join(', ')}]. Actual multiaddrs in response: [${Array.from(lastActualMultiaddrs).join(', ')}]`
        }
        const error = new IndexerQueryFailedError(msg, lastQuerySucceeded)
        options?.logger?.warn({ error }, msg)
        throw error
      }
    }

    check().catch(reject)
  })
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
/**
 * Delay that rejects as soon as `signal` aborts, so an abort mid-wait does not
 * ride out the remaining `ms`. Rejects with `abortMessage` so each retry loop
 * reports the abort the same way whether it lands mid-wait or mid-attempt.
 *
 * Node's `timers/promises` is not an option here: this module ships in the
 * browser bundle.
 */
function abortableDelay(ms: number, signal: AbortSignal | undefined, abortMessage: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error(abortMessage, { cause: signal }))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error(abortMessage, { cause: signal }))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

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
      // Normalize the service URL to match multiaddrToUri output format.
      // multiaddrToUri never produces trailing slashes, so we strip them
      // from the URL to ensure consistent comparison.
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

/** Thrown when Curio confirms a piece as synced but the final cid.contact cross-check still doesn't show it. */
export class IndexerMismatchError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'IndexerMismatchError'
  }
}

export type IndexingConfirmationProgressEvents =
  | ValidateIPNIProgressEvents
  | ProgressEvent<
      'pieceSyncStatus:retryUpdate',
      {
        serviceURL: string
        providerIndex: number
        providerCount: number
        providerAttempt: number
        providerMaxAttempts: number
      }
    >
  | ProgressEvent<
      'pieceSyncStatus:providerSynced',
      { serviceURL: string; providerIndex: number; providerCount: number }
    >
  | ProgressEvent<'pieceSyncStatus:complete', { providerCount: number }>
  | ProgressEvent<'pieceSyncStatus:failed', { error: Error; providerCount: number }>
  | ProgressEvent<'indexingConfirmation:mismatch', { error: IndexerMismatchError }>

export interface WaitForIndexingConfirmationOptions {
  /**
   * Maximum poll attempts per provider against Curio's piece-status endpoint.
   *
   * @default: 20
   */
  maxAttempts?: number | undefined

  /**
   * Delay between poll attempts in milliseconds.
   *
   * @default: 5000
   */
  delayMs?: number | undefined

  /**
   * Maximum attempts for the final confirming indexer query. Defaults to 1: a miss gets
   * negative-cached for minutes, so retrying within that window can't succeed anyway.
   *
   * @default: 1
   */
  indexerMaxAttempts?: number | undefined

  /**
   * Delay between final confirming indexer query attempts in milliseconds.
   *
   * @default: 5000
   */
  indexerDelayMs?: number | undefined

  /** @default: undefined */
  signal?: AbortSignal | undefined

  /** @default: undefined */
  logger?: Logger | undefined

  /**
   * Providers the piece was stored with. Their `pdp.serviceURL` is polled for
   * piece-status, and they're the expected provider set for the indexer cross-check.
   *
   * @default: []
   */
  expectedProviders?: PDPProvider[] | undefined

  /** @default: undefined */
  onProgress?: ProgressEventHandler<IndexingConfirmationProgressEvents>

  /**
   * Indexer used for the final confirming cross-check.
   *
   * @default 'https://cid.contact'
   */
  ipniIndexerUrl?: string | undefined

  /** Child blocks that must also be present in the final confirming indexer cross-check. */
  childBlocks?: CID[] | undefined
}

/**
 * Confirm a piece is indexed and retrievable via standard IPFS/IPNI tooling.
 *
 * Two steps:
 * 1. Poll each expected provider's `GET {serviceURL}/pdp/piece/{pieceCid}/status` until
 *    it reports `synced: true`. Curio checks the indexer's own sync-status endpoint on
 *    the caller's behalf here (curio#1450), so this is safe to poll patiently — Curio's
 *    proxying doesn't have the negative-caching problem a direct CID lookup would.
 * 2. Once every provider reports synced, run a short bounded confirming check against
 *    `ipniIndexerUrl` (default cid.contact) via {@link checkIpniIndexer} — `synced` only
 *    confirms the indexer processed *an* advertisement, not that a CID lookup returns the
 *    expected provider/multiaddr, so this end-to-end check still has value.
 *
 * If step 2 still doesn't find the expected providers, this throws
 * {@link IndexerMismatchError} and emits `indexingConfirmation:mismatch` — distinct from
 * a step 1 timeout, since it signals Curio and the indexer disagree rather than "not
 * indexed yet".
 *
 * This should not be called until you receive confirmation from the SP that the
 * piece has been parked, i.e. `onPieceAdded` in the `synapse.storage.upload` callbacks.
 *
 * @param ipfsRootCid - The IPFS root CID to confirm
 * @param pieceCid - The piece CID to poll piece-status for
 * @param options - Options for the check
 * @returns True if indexing was confirmed
 */
export async function waitForIndexingConfirmation(
  ipfsRootCid: CID,
  pieceCid: PieceCID | CID,
  options?: WaitForIndexingConfirmationOptions
): Promise<boolean> {
  const delayMs = options?.delayMs ?? 5000
  const maxAttempts = options?.maxAttempts ?? 20
  const expectedProviders = options?.expectedProviders?.filter((provider) => provider != null) ?? []
  const serviceUrls = deriveServiceUrls(expectedProviders)

  if (serviceUrls.length === 0) {
    // No provider to establish a synced signal from — refuse rather than guess.
    throw new Error(
      'waitForIndexingConfirmation requires expectedProviders to poll piece-status for. ' +
        'Without a provider to confirm sync with Curio first, querying the indexer directly ' +
        'risks negative-cache poisoning. Pass expectedProviders, or use checkIpniIndexer directly.'
    )
  }

  const providerCount = serviceUrls.length
  // Aborts sibling polls once one fails, instead of leaving them running in the background.
  const pieceSyncController = new AbortController()
  const pieceSyncSignal = options?.signal
    ? AbortSignal.any([options.signal, pieceSyncController.signal])
    : pieceSyncController.signal

  try {
    await Promise.all(
      serviceUrls.map((serviceURL, index) =>
        waitForPieceSynced(serviceURL, pieceCid, {
          delayMs,
          maxAttempts,
          providerIndex: index + 1,
          providerCount,
          signal: pieceSyncSignal,
          options,
        })
      )
    )

    try {
      options?.onProgress?.({ type: 'pieceSyncStatus:complete', data: { providerCount } })
    } catch (callbackError) {
      options?.logger?.warn(
        { error: callbackError },
        'Error in consumer onProgress callback for pieceSyncStatus complete event'
      )
    }
  } catch (error) {
    options?.signal?.throwIfAborted()

    try {
      options?.onProgress?.({ type: 'pieceSyncStatus:failed', data: { error: error as Error, providerCount } })
    } catch (callbackError) {
      options?.logger?.warn(
        { error: callbackError },
        'Error in consumer onProgress callback for pieceSyncStatus failed event'
      )
    }
    // No fallback: step 1 already patiently polled the indexer via Curio (ground truth).
    throw error
  } finally {
    pieceSyncController.abort()
  }

  let interceptedFailedEvent: Extract<ValidateIPNIProgressEvents, { type: 'ipniProviderResults:failed' }> | undefined
  const indexerOptions = buildIndexerOptions(
    options,
    expectedProviders,
    options?.indexerMaxAttempts ?? 1,
    options?.indexerDelayMs ?? 5000,
    (event) => {
      interceptedFailedEvent = event
    }
  )

  try {
    return await checkIpniIndexer(ipfsRootCid, indexerOptions)
  } catch (error) {
    options?.signal?.throwIfAborted()

    // A transport/parse/HTTP failure isn't a real disagreement — forward the failure
    // event we held back (nothing else will report it), then propagate as-is.
    if (!(error instanceof IndexerQueryFailedError) || !error.queriedSuccessfully) {
      if (interceptedFailedEvent != null) {
        try {
          options?.onProgress?.(interceptedFailedEvent)
        } catch (callbackError) {
          options?.logger?.warn(
            { error: callbackError },
            'Error in consumer onProgress callback for ipniProviderResults failed event'
          )
        }
      }
      throw error
    }

    const mismatch = new IndexerMismatchError(
      `Curio reported piece "${pieceCid.toString()}" as synced, but the confirming ${indexerOptions.ipniIndexerUrl} check still failed: ${getErrorMessage(error)}`,
      { cause: error }
    )
    options?.logger?.error({ error: mismatch }, mismatch.message)
    try {
      options?.onProgress?.({ type: 'indexingConfirmation:mismatch', data: { error: mismatch } })
    } catch (callbackError) {
      options?.logger?.warn({ error: callbackError }, 'Error in consumer onProgress callback for mismatch event')
    }
    throw mismatch
  }
}

function buildIndexerOptions(
  options: WaitForIndexingConfirmationOptions | undefined,
  expectedProviders: PDPProvider[],
  maxAttempts: number,
  delayMs: number,
  // Intercepts ipniProviderResults:failed instead of forwarding it — the caller decides
  // whether to replace it with a mismatch event or forward it as-is.
  onFailedEvent: (event: Extract<ValidateIPNIProgressEvents, { type: 'ipniProviderResults:failed' }>) => void
): CheckIpniIndexerOptions {
  const indexerOptions: CheckIpniIndexerOptions = {
    maxAttempts,
    delayMs,
    // Safe to default here: by the time this is called, either every provider already
    // confirmed synced, or there's nothing else safer to fall back to.
    ipniIndexerUrl: options?.ipniIndexerUrl ?? 'https://cid.contact',
    expectedProviders,
    childBlocks: options?.childBlocks,
    signal: options?.signal,
    logger: options?.logger,
  }
  const onProgress = options?.onProgress
  if (onProgress != null) {
    indexerOptions.onProgress = (event) => {
      if (event.type === 'ipniProviderResults:failed') {
        onFailedEvent(event)
        return
      }
      onProgress(event)
    }
  }
  return indexerOptions
}

function deriveServiceUrls(providers: PDPProvider[]): string[] {
  const urls = new Set<string>()
  for (const provider of providers) {
    const serviceURL = provider.pdp?.serviceURL
    if (!serviceURL) {
      throw new Error(`Expected provider ${provider.id} is missing a PDP serviceURL; cannot poll piece-status for it`)
    }
    urls.add(serviceURL)
  }
  return Array.from(urls)
}

/** Provider is on a Curio that predates the `synced` field; retrying cannot help. */
class PieceStatusUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PieceStatusUnsupportedError'
  }
}

async function fetchJson<T>(url: string, signal: AbortSignal | undefined, requestLabel: string): Promise<T> {
  const fetchOptions: RequestInit = { headers: { Accept: 'application/json' } }
  if (signal) {
    fetchOptions.signal = signal
  }
  const response = await fetch(url, fetchOptions)
  if (!response.ok) {
    throw new Error(`${requestLabel} to "${url}" failed with status ${response.status}`)
  }
  return (await response.json()) as T
}

/**
 * Read `synced` from a provider's piece status.
 *
 * Returns `undefined` when the field is absent, which means the provider is on a
 * Curio older than v1.28.6: that release replaced `retrieved` with `synced`, and
 * serialises `synced` on every response. Polling such a provider can never
 * succeed, so the caller stops rather than waiting out its attempts.
 */
async function fetchPieceSynced(
  serviceURL: string,
  pieceCid: PieceCID | CID,
  signal: AbortSignal | undefined
): Promise<boolean | undefined> {
  const url = `${serviceURL.replace(/\/+$/, '')}/pdp/piece/${encodeURIComponent(pieceCid.toString())}/status`
  const body = await fetchJson<PdpPieceStatusResponse>(url, signal, 'Piece status request')
  return typeof body.synced === 'boolean' ? body.synced : undefined
}

async function waitForPieceSynced(
  serviceURL: string,
  pieceCid: PieceCID | CID,
  config: {
    delayMs: number
    maxAttempts: number
    providerIndex: number
    providerCount: number
    signal: AbortSignal
    options: WaitForIndexingConfirmationOptions | undefined
  }
): Promise<void> {
  const { delayMs, maxAttempts, providerIndex, providerCount, signal, options } = config
  let retryCount = 0
  let lastFailureReason: string | undefined

  while (true) {
    if (signal.aborted) {
      throw new Error('Check piece sync status aborted', { cause: signal })
    }

    try {
      options?.onProgress?.({
        type: 'pieceSyncStatus:retryUpdate',
        data: {
          serviceURL,
          providerIndex,
          providerCount,
          providerAttempt: retryCount + 1,
          providerMaxAttempts: maxAttempts,
        },
      })
    } catch (error) {
      options?.logger?.warn({ error }, 'Error in consumer onProgress callback for pieceSyncStatus retryUpdate event')
    }

    try {
      const synced = await fetchPieceSynced(serviceURL, pieceCid, signal)
      if (synced === undefined) {
        throw new PieceStatusUnsupportedError(
          `Piece status on "${serviceURL}" has no \`synced\` field; provider needs Curio v1.28.6 or newer`
        )
      }
      if (synced) {
        try {
          options?.onProgress?.({
            type: 'pieceSyncStatus:providerSynced',
            data: { serviceURL, providerIndex, providerCount },
          })
        } catch (error) {
          options?.logger?.warn(
            { error },
            'Error in consumer onProgress callback for pieceSyncStatus providerSynced event'
          )
        }
        return
      }
      lastFailureReason = 'Piece not yet synced'
    } catch (error) {
      if (signal.aborted || error instanceof PieceStatusUnsupportedError) {
        throw error
      }
      lastFailureReason = getErrorMessage(error)
      options?.logger?.warn({ error, serviceURL }, `${lastFailureReason}. Retrying...`)
    }

    if (++retryCount >= maxAttempts) {
      throw new Error(
        `Piece "${pieceCid.toString()}" not synced on "${serviceURL}" after ${maxAttempts} attempt${maxAttempts === 1 ? '' : 's'}. Last observation: ${lastFailureReason}`
      )
    }
    await abortableDelay(delayMs, signal, 'Check piece sync status aborted')
  }
}
