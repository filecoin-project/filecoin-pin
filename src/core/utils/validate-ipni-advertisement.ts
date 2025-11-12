import type { ProviderInfo } from '@filoz/synapse-sdk'
import type { CID } from 'multiformats/cid'
import type { Logger } from 'pino'
import type { ProgressEvent, ProgressEventHandler } from './types.js'

/**
 * Response structure from the filecoinpin.contact IPNI indexer.
 *
 * The Indexer returns provider records corresponding with each SP that advertised
 * a given CID to the IPNI indexer. 
 * Each provider includes their peer ID and multiaddrs.
 */
interface FilecoinPinContactResponse {
  MultihashResults?: Array<{
    Multihash?: string
    ProviderResults?: ProviderResult[]
  }>
}

/**
 * A single provider's advertisement from IPNI.
 *
 * Contains the provider's libp2p peer ID and an array of multiaddrs where
 * the content can be retrieved. These multiaddrs typically include the
 * provider's PDP service endpoint (e.g., /dns/provider.example.com/tcp/443/https).
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
  | ProgressEvent<'ipniAdvertisement.retryUpdate', { retryCount: number }>
  | ProgressEvent<'ipniAdvertisement.complete', { result: true; retryCount: number }>
  | ProgressEvent<'ipniAdvertisement.failed', { error: Error }>

export interface ValidateIPNIAdvertisementOptions {
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
   * Providers that are expected to appear in the IPNI advertisement. All
   * providers supplied here must be present in the response for the validation
   * to succeed. When omitted or empty, the validation succeeds once the IPNI
   * response includes any provider entry that advertises at least one address
   * for the root CID (no retrieval attempt is made here).
   *
   * @default: []
   */
  expectedProviders?: ProviderInfo[] | undefined

  /**
   * Additional provider multiaddrs that must be present in the IPNI
   * advertisement. These are merged with the derived multiaddrs from
   * {@link expectedProviders}.
   *
   * @default: undefined
   */
  expectedProviderMultiaddrs?: string[] | undefined

  /**
   * Callback for progress updates
   *
   * @default: undefined
   */
  onProgress?: ProgressEventHandler<ValidateIPNIProgressEvents>
}

/**
 * Check if the SP has announced the IPFS root CID to IPNI.
 *
 * This should not be called until you receive confirmation from the SP that the piece has been parked, i.e. `onPieceAdded` in the `synapse.storage.upload` callbacks.
 *
 * @param ipfsRootCid - The IPFS root CID to check
 * @param options - Options for the check
 * @returns True if the IPNI announce succeeded, false otherwise
 */
export async function validateIPNIAdvertisement(
  ipfsRootCid: CID,
  options?: ValidateIPNIAdvertisementOptions
): Promise<boolean> {
  const delayMs = options?.delayMs ?? 5000
  const maxAttempts = options?.maxAttempts ?? 20
  const expectedProviders = options?.expectedProviders?.filter((provider) => provider != null) ?? []
  const { expectedMultiaddrs, skippedProviderCount } = deriveExpectedMultiaddrs(
    expectedProviders,
    options?.expectedProviderMultiaddrs,
    options?.logger
  )
  const expectedMultiaddrsSet = new Set(expectedMultiaddrs)

  const hasProviderExpectations = expectedMultiaddrs.length > 0

  // Log a warning if we expected providers but couldn't derive their multiaddrs
  // In this case, we fall back to generic validation (just checking if any provider advertises)
  if (!hasProviderExpectations && expectedProviders.length > 0 && skippedProviderCount > 0) {
    options?.logger?.info(
      { skippedProviderExpectationCount: skippedProviderCount, expectedProviders: expectedProviders.length },
      'No provider multiaddrs derived from expected providers; falling back to generic IPNI validation'
    )
  }

  return new Promise<boolean>((resolve, reject) => {
    let retryCount = 0
    // Tracks the most recent validation failure reason for error reporting
    let lastFailureReason: string | undefined

    const check = async (): Promise<void> => {
      if (options?.signal?.aborted) {
        throw new Error('Check IPNI announce aborted', { cause: options?.signal })
      }

      options?.logger?.info(
        {
          event: 'check-ipni-announce',
          ipfsRootCid: ipfsRootCid.toString(),
        },
        'Checking IPNI for announcement of IPFS Root CID "%s"',
        ipfsRootCid.toString()
      )

      // Emit progress event for this attempt
      try {
        options?.onProgress?.({ type: 'ipniAdvertisement.retryUpdate', data: { retryCount } })
      } catch (error) {
        options?.logger?.warn({ error }, 'Error in consumer onProgress callback for retryUpdate event')
      }

      // Fetch IPNI advertisement
      const fetchOptions: RequestInit = {
        headers: { Accept: 'application/json' },
      }
      if (options?.signal) {
        fetchOptions.signal = options?.signal
      }

      const response = await fetch(`https://filecoinpin.contact/cid/${ipfsRootCid}`, fetchOptions)

      // Parse and validate response
      if (response.ok) {
        let providerResults: ProviderResult[] | undefined
        try {
          const body = (await response.json()) as FilecoinPinContactResponse
          providerResults = extractProviderResults(body)
        } catch (parseError) {
          lastFailureReason = 'Failed to parse IPNI response body'
          options?.logger?.warn({ error: parseError }, `${lastFailureReason}. Retrying...`)
        }

        // Check if we have provider results to validate
        if (providerResults != null && providerResults.length > 0) {
          // Perform appropriate validation based on whether we have expectations
          const hasGenericProvider = hasAnyProviderWithAddresses(providerResults)
          const matchedMultiaddrs = hasProviderExpectations
            ? findMatchingMultiaddrs(providerResults, expectedMultiaddrsSet)
            : new Set<string>()

          const isValid = isValidationSuccessful(
            hasGenericProvider,
            matchedMultiaddrs,
            expectedMultiaddrsSet,
            hasProviderExpectations
          )

          if (isValid) {
            // Validation succeeded!
            try {
              options?.onProgress?.({ type: 'ipniAdvertisement.complete', data: { result: true, retryCount } })
            } catch (error) {
              options?.logger?.warn({ error }, 'Error in consumer onProgress callback for complete event')
            }
            resolve(true)
            return
          }

          // Validation not yet successful - log why and retry
          lastFailureReason = formatAndLogValidationGap(
            matchedMultiaddrs,
            expectedMultiaddrs,
            hasProviderExpectations,
            expectedProviders.length,
            options?.logger
          )
        } else {
          lastFailureReason = 'IPNI response did not include any provider results'
          options?.logger?.info(
            { providerResultsCount: providerResults?.length ?? 0 },
            `${lastFailureReason}. Retrying...`
          )
        }
      }

      // Retry or fail
      if (++retryCount < maxAttempts) {
        options?.logger?.info(
          { retryCount, maxAttempts },
          'IPFS Root CID "%s" not announced to IPNI yet (%d/%d). Retrying in %dms...',
          ipfsRootCid.toString(),
          retryCount,
          maxAttempts,
          delayMs
        )
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        await check()
      } else {
        // Max attempts reached - validation failed
        const msgBase = `IPFS root CID "${ipfsRootCid.toString()}" not announced to IPNI after ${maxAttempts} attempt${maxAttempts === 1 ? '' : 's'}`
        const msg = lastFailureReason != null ? `${msgBase}. Last observation: ${lastFailureReason}` : msgBase
        const error = new Error(msg)
        options?.logger?.warn({ error }, msg)
        throw error
      }
    }

    check().catch((error) => {
      try {
        options?.onProgress?.({ type: 'ipniAdvertisement.failed', data: { error } })
      } catch (callbackError) {
        options?.logger?.warn({ error: callbackError }, 'Error in consumer onProgress callback for failed event')
      }
      reject(error)
    })
  })
}

/**
 * Convert a PDP service URL to an IPNI multiaddr format.
 *
 * Storage providers expose their PDP (Piece Data Provider) service via HTTP/HTTPS
 * endpoints (e.g., "https://provider.example.com:8443"). When they advertise content
 * to IPNI, they include multiaddrs in libp2p format (e.g., "/dns/provider.example.com/tcp/8443/https").
 *
 * This function converts between these representations to enable validation that a
 * provider's IPNI advertisement matches their registered service endpoint.
 *
 * @param serviceURL - HTTP/HTTPS URL of the provider's PDP service
 * @param logger - Optional logger for warnings
 * @returns Multiaddr string in libp2p format, or undefined if conversion fails
 *
 * @example
 * serviceURLToMultiaddr('https://provider.example.com')
 * // Returns: '/dns/provider.example.com/tcp/443/https'
 *
 * @example
 * serviceURLToMultiaddr('http://provider.example.com:8080')
 * // Returns: '/dns/provider.example.com/tcp/8080/http'
 */
export function serviceURLToMultiaddr(serviceURL: string, logger?: Logger): string | undefined {
  try {
    const url = new URL(serviceURL)
    const port =
      url.port !== ''
        ? Number.parseInt(url.port, 10)
        : url.protocol === 'https:'
          ? 443
          : url.protocol === 'http:'
            ? 80
            : undefined

    if (Number.isNaN(port) || port == null) {
      return undefined
    }

    const protocolComponent =
      url.protocol === 'https:' ? 'https' : url.protocol === 'http:' ? 'http' : url.protocol.replace(':', '')

    return `/dns/${url.hostname}/tcp/${port}/${protocolComponent}`
  } catch (error) {
    logger?.warn({ serviceURL, error }, 'Unable to derive IPNI multiaddr from serviceURL')
    return undefined
  }
}

/**
 * Extract all provider results from the IPNI gateway response.
 *
 * The response can contain multiple multihash results, each with multiple provider
 * results. This flattens them into a single array for easier processing.
 *
 * @param response - Raw response from filecoinpin.contact
 * @returns Flat array of all provider results, or empty array if none found
 */
function extractProviderResults(response: FilecoinPinContactResponse): ProviderResult[] {
  const results = response.MultihashResults
  if (!Array.isArray(results)) {
    return []
  }

  return results.flatMap(({ ProviderResults }) => {
    if (!Array.isArray(ProviderResults)) {
      return []
    }
    return ProviderResults
  })
}

/**
 * Derive expected IPNI multiaddrs from provider information.
 *
 * For each provider, attempts to extract their PDP serviceURL and convert it to
 * the multiaddr format used in IPNI advertisements. This allows validation that
 * specific providers have advertised the content.
 *
 * Note: ProviderInfo should contain the serviceURL at `products.PDP.data.serviceURL`.
 * In some SDK versions, it may be at the top level. This function checks both locations
 * to maintain compatibility.
 *
 * @param providers - Array of provider info objects from synapse SDK
 * @param extraMultiaddrs - Additional multiaddrs to include in expectations
 * @param logger - Optional logger for diagnostics
 * @returns Expected multiaddrs and count of providers that couldn't be processed
 */
function deriveExpectedMultiaddrs(
  providers: ProviderInfo[],
  extraMultiaddrs: string[] | undefined,
  logger: Logger | undefined
): {
  expectedMultiaddrs: string[]
  skippedProviderCount: number
} {
  const derivedMultiaddrs: string[] = []
  let skippedProviderCount = 0

  for (const provider of providers) {
    // Primary path: products.PDP.data.serviceURL (current SDK structure)
    // Fallback path: top-level serviceURL (for compatibility with older SDK versions)
    const serviceURL =
      provider.products?.PDP?.data?.serviceURL ??
      (provider as unknown as { serviceURL?: string }).serviceURL ??
      undefined

    if (!serviceURL) {
      skippedProviderCount++
      logger?.warn({ provider }, 'Expected provider is missing a PDP serviceURL; skipping IPNI multiaddr expectation')
      continue
    }

    const derivedMultiaddr = serviceURLToMultiaddr(serviceURL, logger)
    if (!derivedMultiaddr) {
      skippedProviderCount++
      logger?.warn({ provider, serviceURL }, 'Unable to derive IPNI multiaddr from serviceURL; skipping expectation')
      continue
    }

    derivedMultiaddrs.push(derivedMultiaddr)
  }

  const additionalMultiaddrs = extraMultiaddrs?.filter((addr) => addr != null && addr !== '') ?? []
  const expectedMultiaddrs = Array.from(new Set<string>([...additionalMultiaddrs, ...derivedMultiaddrs]))

  return {
    expectedMultiaddrs,
    skippedProviderCount,
  }
}

/**
 * Check if any provider in the IPNI response has at least one address.
 *
 * This is used for generic IPNI validation when no specific provider is expected.
 * Passes if IPNI shows ANY provider advertising the content with addresses.
 *
 * @param providerResults - Provider results from IPNI response
 * @returns True if at least one provider has non-empty addresses
 */
function hasAnyProviderWithAddresses(providerResults: ProviderResult[]): boolean {
  for (const providerResult of providerResults) {
    const provider = providerResult.Provider
    if (!provider) continue

    const providerAddrs = provider.Addrs ?? []
    if (providerAddrs.length > 0) {
      return true
    }
  }

  return false
}

/**
 * Find which expected multiaddrs are present in the IPNI response.
 *
 * This is used for specific provider validation. Returns the set of expected
 * multiaddrs that were found, allowing the caller to check if ALL expected
 * providers are advertising.
 *
 * @param providerResults - Provider results from IPNI response
 * @param expectedMultiaddrs - Set of multiaddrs we expect to find
 * @returns Set of expected multiaddrs that were found in the response
 */
function findMatchingMultiaddrs(providerResults: ProviderResult[], expectedMultiaddrs: Set<string>): Set<string> {
  const matched = new Set<string>()

  for (const providerResult of providerResults) {
    const provider = providerResult.Provider
    if (!provider) continue

    const providerAddrs = provider.Addrs ?? []
    for (const addr of providerAddrs) {
      if (expectedMultiaddrs.has(addr)) {
        matched.add(addr)
      }
    }
  }

  return matched
}

/**
 * Check if the IPNI response satisfies the validation requirements.
 *
 * For generic validation (no expected providers): Passes if any provider has addresses.
 * For specific validation (with expected providers): Passes only if ALL expected
 * multiaddrs are present in the response.
 *
 * @param hasGenericProvider - True if any provider advertises with addresses
 * @param matchedMultiaddrs - Set of expected multiaddrs found in response
 * @param expectedMultiaddrs - Set of all expected multiaddrs
 * @param hasProviderExpectations - Whether we're doing specific provider validation
 * @returns True if validation requirements are satisfied
 */
function isValidationSuccessful(
  hasGenericProvider: boolean,
  matchedMultiaddrs: Set<string>,
  expectedMultiaddrs: Set<string>,
  hasProviderExpectations: boolean
): boolean {
  if (!hasProviderExpectations) {
    // Generic validation: just need any provider with addresses
    return hasGenericProvider
  }

  // Specific validation: need ALL expected multiaddrs to be present
  return matchedMultiaddrs.size === expectedMultiaddrs.size
}

/**
 * Format and log diagnostics about why validation hasn't passed yet.
 *
 * This provides actionable feedback about what's missing from the IPNI response,
 * helping users understand what the validation is waiting for.
 *
 * @param matchedMultiaddrs - Multiaddrs from expected set that were found
 * @param expectedMultiaddrs - All expected multiaddrs (as array for iteration)
 * @param hasProviderExpectations - Whether we're doing specific provider validation
 * @param expectedProvidersCount - Number of providers we're expecting
 * @param logger - Optional logger for output
 * @returns Human-readable message describing what's missing
 */
function formatAndLogValidationGap(
  matchedMultiaddrs: Set<string>,
  expectedMultiaddrs: string[],
  hasProviderExpectations: boolean,
  expectedProvidersCount: number,
  logger: Logger | undefined
): string {
  let message: string

  if (hasProviderExpectations) {
    const missing = expectedMultiaddrs.filter((addr) => !matchedMultiaddrs.has(addr))

    if (missing.length === 0) {
      // All multiaddrs are present, but maybe not all with addresses yet
      message = 'Expected providers not yet advertising reachable addresses'
    } else {
      message = `Missing advertisement for expected multiaddr(s): ${missing.join(', ')}`
    }

    logger?.info(
      {
        expectation: `multiaddr(s): ${expectedMultiaddrs.join(', ')}`,
        providerCount: expectedProvidersCount,
        matchedMultiaddrs: Array.from(matchedMultiaddrs),
      },
      `${message}. Retrying...`
    )
  } else {
    message = 'Expected provider advertisement to include at least one reachable address'
    logger?.info(`${message}. Retrying...`)
  }

  return message
}
