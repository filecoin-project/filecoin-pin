/**
 * Google Cloud Storage source: list a bucket over the JSON API and import
 * each object as a single UnixFS file (same profile as `add`), staged as a
 * member CAR for the packing pipeline. Read-only access is enough.
 */

import { createReadStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { createCarFromStream } from '../core/unixfs/car-builder.js'
import type { MigrationDB } from './db.js'
import { categoryForFetchError, categoryForStatus, rootCause, StagingError } from './gateway.js'
import type { MemberSource } from './run-migrate.js'
import { type StagedMember, type VerifyCarOptions, verifyCarStream } from './verify-car.js'

const API = 'https://storage.googleapis.com/storage/v1'

/** Authenticated GET against the JSON API; injectable for network-free tests. */
export type GcsFetch = (url: string) => Promise<Response>

export interface GcsObject {
  /** `gs://bucket/name` */
  url: string
  size: number
  crc32c: string
}

/** `gs://bucket[/prefix]`, or null when the argument is not a gs:// URL. */
export function parseGcsUrl(source: string): { bucket: string; prefix: string } | null {
  const match = source.match(/^gs:\/\/([^/]+)\/?(.*)$/)
  if (match == null) return null
  return { bucket: match[1] ?? '', prefix: match[2] ?? '' }
}

/** Every object under the prefix, following page tokens. */
export async function listGcsObjects(
  source: { bucket: string; prefix: string },
  fetchFn: GcsFetch
): Promise<GcsObject[]> {
  const objects: GcsObject[] = []
  let pageToken: string | undefined
  do {
    const params = new URLSearchParams({ prefix: source.prefix, fields: 'items(name,size,crc32c),nextPageToken' })
    if (pageToken != null) params.set('pageToken', pageToken)
    const res = await fetchFn(`${API}/b/${encodeURIComponent(source.bucket)}/o?${params}`)
    if (!res.ok) {
      throw new Error(`listing gs://${source.bucket}/${source.prefix} failed: HTTP ${res.status} ${await res.text()}`)
    }
    const page = (await res.json()) as {
      items?: Array<{ name: string; size: string; crc32c: string }>
      nextPageToken?: string
    }
    for (const item of page.items ?? []) {
      objects.push({ url: `gs://${source.bucket}/${item.name}`, size: Number(item.size), crc32c: item.crc32c })
    }
    pageToken = page.nextPageToken
  } while (pageToken != null)
  return objects
}

const noopSink = { write: async () => undefined, end: async () => undefined }

/**
 * Download one object and import it into a member CAR under `memberDir`.
 * The CAR is hashed (piece commitment, sha256) in a second local pass, which
 * is also where its bytes are counted against the staging budget.
 */
export async function stageGcsObject(
  url: string,
  memberDir: string,
  opts: VerifyCarOptions,
  fetchFn: GcsFetch
): Promise<StagedMember> {
  const { bucket, prefix: name } = parseGcsUrl(url) ?? { bucket: '', prefix: '' }
  const mediaUrl = `${API}/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(name)}?alt=media`
  let res: Response
  try {
    res = await fetchFn(mediaUrl)
  } catch (err) {
    throw new StagingError(`${url}: ${rootCause(err)}`, categoryForFetchError(err), { cause: err })
  }
  if (!res.ok || res.body == null) {
    void res.body?.cancel().catch(() => undefined)
    throw new StagingError(`${url}: HTTP ${res.status}`, categoryForStatus(res.status))
  }

  const { carPath, rootCid } = await createCarFromStream(res.body, name, { tempDir: memberDir })
  let counted = 0
  try {
    // ponytail: bytes count after the import wrote them, so the budget can overshoot by one object per worker.
    const verified = await verifyCarStream(
      Readable.toWeb(createReadStream(carPath)) as ReadableStream<Uint8Array>,
      rootCid,
      noopSink,
      {
        onBytes: (delta) => {
          counted += delta
          opts.onBytes?.(delta)
        },
      }
    )
    return {
      cid: rootCid.toString(),
      pieceCid: verified.pieceCid,
      rawSize: verified.rawSize,
      gateway: 'gcs',
      url,
      memberCarPath: carPath,
      memberSha256: verified.sha256,
    }
  } catch (err) {
    await unlink(carPath).catch(() => undefined)
    if (counted > 0) opts.onBytes?.(-counted)
    throw err
  }
}

/** Member source over objects registered with `db.addSources`. */
export function gcsSource(db: MigrationDB, fetchFn: GcsFetch): MemberSource {
  return {
    pending: () => db.pendingSources(),
    stage: (url, memberDir, opts) => stageGcsObject(url, memberDir, opts, fetchFn),
    recordSuccess: (url, member) => db.recordSourceSuccess(url, member),
    recordFailure: (url, error, category) => db.recordSourceFailure(url, error, category),
  }
}

/** A `GcsFetch` authenticated with Application Default Credentials, read-only scope. */
export async function adcFetch(): Promise<GcsFetch> {
  const { GoogleAuth } = await import('google-auth-library')
  const auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/devstorage.read_only' })
  return async (url) => fetch(url, { headers: { authorization: `Bearer ${await auth.getAccessToken()}` } })
}
