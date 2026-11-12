/**
 * Google Cloud Storage source: list a bucket over the JSON API and import
 * each object as a single UnixFS file (same profile as `add`), staged as a
 * member CAR for the packing pipeline. Read-only access is enough.
 */

import { createReadStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { basename } from 'node:path'
import { Readable } from 'node:stream'
import type { WriteTarget } from '@filoz/keysmith'
import * as fee from 'filecoin-encryption-envelope'
import { ENCRYPTED_FILE_NAME } from '../common/encryption.js'
import { newPieceKey, type PieceKey } from '../common/group-key.js'
import { CAR_CONTENT_TYPE } from '../common/unixfs-car-layout.js'
import { emitStreamPayload, planStreamPayload } from '../common/unixfs-car-payload.js'
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

/** The object's bytes, with fetch failures categorized like gateway ones. */
async function readObject(url: string, fetchFn: GcsFetch): Promise<ReadableStream<Uint8Array>> {
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
  return res.body
}

/**
 * The envelope `add --encrypt` makes of a file, built from two reads of the object
 * (plan, then emit) so no plaintext touches disk.
 */
async function encryptedObject(url: string, fetchFn: GcsFetch, key: PieceKey): Promise<ReadableStream<Uint8Array>> {
  const plan = await planStreamPayload(basename(parseGcsUrl(url)?.prefix ?? ''), await readObject(url, fetchFn))
  const payload = Readable.toWeb(Readable.from(emitStreamPayload(plan, await readObject(url, fetchFn))))
  return (payload as ReadableStream<Uint8Array>).pipeThrough(
    fee.encrypt({
      cek: key.cek,
      contentLength: plan.contentLength,
      contentType: CAR_CONTENT_TYPE,
      appMetadata: key.appMetadata,
    })
  )
}

/**
 * Download one object and import it into a member CAR under `memberDir`; with
 * `encryptTarget`, the object's `add --encrypt` envelope instead.
 * Bytes count against the staging budget as they stream in; the CAR is then
 * hashed (piece commitment, sha256) in a second local pass.
 */
export async function stageGcsObject(
  url: string,
  memberDir: string,
  opts: VerifyCarOptions,
  fetchFn: GcsFetch,
  encryptTarget?: WriteTarget
): Promise<StagedMember> {
  const key = encryptTarget == null ? undefined : newPieceKey(encryptTarget)
  let counted = 0
  const count = (delta: number): void => {
    counted += delta
    opts.onBytes?.(delta)
  }
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      count(chunk.length)
      controller.enqueue(chunk)
    },
  })
  let carPath: string | undefined
  try {
    const input = key == null ? await readObject(url, fetchFn) : await encryptedObject(url, fetchFn, key)
    const name = key == null ? (parseGcsUrl(url)?.prefix ?? '') : ENCRYPTED_FILE_NAME
    const car = await createCarFromStream(input.pipeThrough(counter), name, { tempDir: memberDir })
    carPath = car.carPath
    const verified = await verifyCarStream(
      Readable.toWeb(createReadStream(carPath)) as ReadableStream<Uint8Array>,
      car.rootCid,
      noopSink
    )
    count(verified.rawSize - counted)
    return {
      cid: car.rootCid.toString(),
      pieceCid: verified.pieceCid,
      rawSize: verified.rawSize,
      gateway: 'gcs',
      url,
      memberCarPath: carPath,
      memberSha256: verified.sha256,
    }
  } catch (err) {
    if (carPath != null) await unlink(carPath).catch(() => undefined)
    if (counted !== 0) opts.onBytes?.(-counted)
    throw err
  } finally {
    key?.cek.fill(0)
  }
}

/** Member source over objects registered with `db.addSources`. */
export function gcsSource(db: MigrationDB, fetchFn: GcsFetch, encryptTarget?: WriteTarget): MemberSource {
  return {
    pending: () => db.pendingSources(),
    stage: (url, memberDir, opts) => stageGcsObject(url, memberDir, opts, fetchFn, encryptTarget),
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
