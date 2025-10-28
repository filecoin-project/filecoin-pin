import type { CID } from 'multiformats/cid'
import type { Logger } from 'pino'

export interface CheckIPNIAnnouncementOptions {
  /**
   * maximum number of attempts
   *
   * @default: 10
   */
  maxAttempts?: number

  /**
   * delay between attempts in milliseconds
   *
   * @default: 5000
   */
  delayMs?: number

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
  logger?: Logger

  /**
   * Callback for progress updates
   *
   * @default: undefined
   */
  onProgress?: (event: { type: 'onRetryUpdate'; data: { retryCount: number } }) => void
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
export async function checkIPNIAnnouncement(
  ipfsRootCid: CID,
  options?: CheckIPNIAnnouncementOptions
): Promise<boolean> {
  const delayMs = options?.delayMs ?? 5000
  const maxAttempts = options?.maxAttempts ?? 10

  return new Promise<boolean>((resolve, reject) => {
    let retryCount = 0
    const check = async (): Promise<void> => {
      try {
        if (options?.signal?.aborted) {
          reject(new Error('Check IPNI announce aborted'))
          return
        }
        options?.logger?.info(
          {
            event: 'check-ipni-announce',
            ipfsRootCid: ipfsRootCid.toString(),
          },
          'Checking IPNI for announcement of IPFS Root CID "%s"',
          ipfsRootCid.toString()
        )
        const fetchOptions: RequestInit = {}
        if (options?.signal) {
          fetchOptions.signal = options?.signal
        }
        options?.onProgress?.({ type: 'onRetryUpdate', data: { retryCount } })

        const response = await fetch(`https://filecoinpin.contact/cid/${ipfsRootCid}`, fetchOptions)
        if (response.ok) {
          resolve(true)
          return
        }
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
          const msg = `IPFS root CID "${ipfsRootCid.toString()}" not announced to IPNI after ${maxAttempts} attempts`
          const error = new Error(msg)
          options?.logger?.error({ error }, msg)
          reject(error)
        }
      } catch (error) {
        reject(error)
      }
    }

    check().catch(reject)
  })
}
