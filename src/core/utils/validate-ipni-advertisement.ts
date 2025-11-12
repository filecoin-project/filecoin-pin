import type { ProviderInfo } from '@filoz/synapse-sdk'
import type { CID } from 'multiformats/cid'
import type { Logger } from 'pino'
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

  /**
   * IPNI indexer URL to query for content advertisements.
   *
   * @default 'https://filecoinpin.contact'
   */
  ipniIndexerUrl?: string | undefined
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
  const ipniIndexerUrl = options?.ipniIndexerUrl ?? 'https://filecoinpin.contact'
  const expectedProviders = options?.expectedProviders?.filter((provider) => provider != null) ?? []
  const { expectedMultiaddrs, skippedProviderCount } = deriveExpectedMultiaddrs(
    expectedProviders,
    options?.expectedProviderMultiaddrs,
    options?.logger
  )
  const expectedMultiaddrsSet = new Set(expectedMultiaddrs)

  const hasProviderExpectations = expectedMultiaddrs.length > 0

  // Log a warning if we expected providers but couldn't derive their multiaddrs
  // In this case, we fall back to generic validation (just checking if there are any provider records for the CID)
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
    // Tracks the actual multiaddrs found in the last IPNI response for error reporting
    let lastActualMultiaddrs: string[] = []

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

      const response = await fetch(`${ipniIndexerUrl}/cid/${ipfsRootCid}`, fetchOptions)

      // Parse and validate response
      if (response.ok) {
        let providerResults: ProviderResult[] = []
        try {
          const body = (await response.json()) as IpniIndexerResponse
          // Extract provider results
          providerResults = (body.MultihashResults ?? []).flatMap((r) => r.ProviderResults ?? [])
        } catch (parseError) {
          lastFailureReason = 'Failed to parse IPNI response body'
          options?.logger?.warn({ error: parseError }, `${lastFailureReason}. Retrying...`)
        }

        // Check if we have provider results to validate
        if (providerResults.length > 0) {
          // Extract all multiaddrs from provider results
          lastActualMultiaddrs = providerResults.flatMap((pr) => pr.Provider?.Addrs ?? [])

          let isValid = false

          if (hasProviderExpectations) {
            // Find matching multiaddrs - inline filter + Set
            const matchedMultiaddrs = new Set(lastActualMultiaddrs.filter((addr) => expectedMultiaddrsSet.has(addr)))
            isValid = matchedMultiaddrs.size === expectedMultiaddrs.length

            if (!isValid) {
              // Log validation gap
              const missing = expectedMultiaddrs.filter((addr) => !matchedMultiaddrs.has(addr))
              lastFailureReason = `Missing advertisement for expected multiaddr(s): ${missing.join(', ')}`
              options?.logger?.info(
                {
                  expectation: `multiaddr(s): ${expectedMultiaddrs.join(', ')}`,
                  providerCount: expectedProviders.length,
                  matchedMultiaddrs: Array.from(matchedMultiaddrs),
                },
                `${lastFailureReason}. Retrying...`
              )
            }
          } else {
            // Generic validation: just need any provider with addresses
            isValid = lastActualMultiaddrs.length > 0
            if (!isValid) {
              lastFailureReason = 'Expected provider advertisement to include at least one reachable address'
              options?.logger?.info(`${lastFailureReason}. Retrying...`)
            }
          }

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
        } else if (lastFailureReason == null) {
          // Only set generic message if we don't already have a more specific reason (e.g., parse error)
          lastFailureReason = 'IPNI response did not include any provider results'
          // Track that we got an empty response
          lastActualMultiaddrs = []
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
        let msg = msgBase
        if (lastFailureReason != null) {
          msg = `${msgBase}. Last observation: ${lastFailureReason}`
        }
        // Include expected and actual multiaddrs for debugging
        if (hasProviderExpectations) {
          msg = `${msg}. Expected multiaddrs: [${expectedMultiaddrs.join(', ')}]. Actual multiaddrs in response: [${lastActualMultiaddrs.join(', ')}]`
        }
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
 * Storage providers expose their PDP (Proof of Data Possession) service via HTTP/HTTPS
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
    const port = url.port || (url.protocol === 'https:' ? '443' : '80')
    const protocolComponent = url.protocol.replace(':', '')

    return `/dns/${url.hostname}/tcp/${port}/${protocolComponent}`
  } catch (error) {
    logger?.warn({ serviceURL, error }, 'Unable to derive IPNI multiaddr from serviceURL')
    return undefined
  }
}

/**
 * Derive expected IPNI multiaddrs from provider information.
 *
 * For each provider, attempts to extract their PDP serviceURL and convert it to
 * the multiaddr format used in IPNI advertisements. This allows validation that
 * specific providers have advertised the content.
 *
 * Note: ProviderInfo should contain the serviceURL at `products.PDP.data.serviceURL`.
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
    const serviceURL = provider.products?.PDP?.data?.serviceURL

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
