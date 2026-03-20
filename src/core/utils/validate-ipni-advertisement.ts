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
 * Check if the IPNI Indexer has the provided ProviderResults for the provided ipfsRootCid.
 * This effectively verifies the entire SP<->IPNI flow, including:
 * - The SP announced the advertisement chain to the IPNI indexer(s)
 * - The IPNI indexer(s) pulled the advertisement chain from the SP
 * - The IPNI indexer(s) updated their index
 * This doesn't check individual steps, but rather the end ProviderResults reponse from the IPNI indexer.
 * If the IPNI indexer ProviderResults have the expected providers, then the steps abomove must have completed.
 * This doesn't actually do any IPFS Mainnet retrieval checks of the ipfsRootCid.
 *
 * This should not be called until you receive confirmation from the SP that the piece has been parked, i.e. `onPieceAdded` in the `synapse.storage.upload` callbacks.
 *
 * @param ipfsRootCid - The IPFS root CID to check
 * @param options - Options for the check
 * @returns True if the IPNI announce succeeded, false otherwise
 */
export async function waitForIpniProviderResults(
  ipfsRootCid: CID,
  options?: WaitForIpniProviderResultsOptions
): Promise<boolean> {
  const delayMs = options?.delayMs ?? 5000
  const maxAttempts = options?.maxAttempts ?? 20
  const ipniIndexerUrl = options?.ipniIndexerUrl ?? 'https://filecoinpin.contact'
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
      await waitForIpniProviderResultsForCid(cid, {
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
      options?.onProgress?.({ type: 'ipniProviderResults.complete', data: { result: true, retryCount } })
    } catch (error) {
      options?.logger?.warn({ error }, 'Error in consumer onProgress callback for complete event')
    }

    return true
  } catch (error) {
    try {
      options?.onProgress?.({ type: 'ipniProviderResults.failed', data: { error: error as Error } })
    } catch (callbackError) {
      options?.logger?.warn({ error: callbackError }, 'Error in consumer onProgress callback for failed event')
    }
    throw error
  }
}

async function waitForIpniProviderResultsForCid(
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
    options: WaitForIpniProviderResultsOptions | undefined
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
        } catch (parseError) {
          // Clear actual multiaddrs on parse error
          lastActualMultiaddrs = new Set()
          lastActualUris = new Set()
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
        await new Promise((resolve) => setTimeout(resolve, delayMs))
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
        const error = new Error(msg)
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
