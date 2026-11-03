/**
 * Read an encrypted upload's header labels back from the upload itself, for share links.
 *
 * ## What is read, and why it must be verified
 *
 * The labels (`foc/own`, `foc/ks`, `foc/salt`, and `foc/scope` when present) sit in the FEE
 * header at the very start of `encrypted.fee`, the UnixFS file the Encrypted root CID names.
 * The sharer derives the key it shares from its own group key and the salt it reads here.
 *
 * So the bytes must be checked against the root CID. A plain byte-range read of the file from a
 * gateway (`Range: bytes=0-4095`) is NOT safe: a dishonest gateway could return the header of
 * another upload in the same group key, and the sharer would mint a link that opens *that*
 * upload's key, which its CID (public on chain) then lets anyone fetch. Instead this reads raw
 * blocks over the trustless gateway API (`/ipfs/<cid>?format=raw`), hashes each against its CID,
 * and walks from the root to the first leaf, which holds the header.
 *
 * ## Cost
 *
 * The root block (a few hundred bytes), any intermediate node on the way down (large files), and
 * the first leaf: at most the UnixFS chunk size, 1 MiB today, however large the upload. A provider
 * that serves IPIP-402 byte-range CARs (`?format=car&dag-scope=entity&entity-bytes=0:4095`) could
 * cut that to a few KB and stay verified; not relied on here, since support varies.
 */

import type { PieceMetadata } from '@filoz/keysmith'
import * as dagPb from '@ipld/dag-pb'
import * as fee from 'filecoin-encryption-envelope'
import { UnixFS } from 'ipfs-unixfs'
import { CID } from 'multiformats/cid'
import { assertHash, MAX_BLOCK_BYTES, RESPONSE_TIMEOUT_MS } from './ipfs-car-fetch.js'
import { CAR_CONTENT_TYPE, DAG_PB_CODEC, RAW_CODEC } from './unixfs-car-layout.js'

/** A UnixFS file is at most a few levels deep; this bounds a hostile one. */
const MAX_DEPTH = 8

/** The upload's header could not be read from any provider. The message is safe to print. */
export class EnvelopeLabelsError extends Error {
  override name = 'EnvelopeLabelsError'
}

/**
 * The content at the CID was verified, but is not an upload made with `add --encrypt`. Every
 * honest provider serves the same blocks, so no other provider is tried.
 */
export class NotEncryptedUploadError extends EnvelopeLabelsError {
  override name = 'NotEncryptedUploadError'
}

/** A folder, a file with no FEE header, or not UnixFS at all. */
function plainContent(root: CID): NotEncryptedUploadError {
  return new NotEncryptedUploadError(
    `${root} is plain content, not an upload made with \`add --encrypt\`: anyone can open it by its CID, so it doesn't need a Share link`
  )
}

/** An envelope, but not one `add --encrypt` wrote. */
function foreignEnvelope(root: CID): NotEncryptedUploadError {
  return new NotEncryptedUploadError(
    `${root} is encrypted, but not by \`add --encrypt\`, so a Share link cannot open it`
  )
}

/** Fetch one raw block from `provider` and check it against `cid`. */
async function fetchBlock(provider: string, cid: CID, fetchImpl: typeof fetch): Promise<Uint8Array> {
  const response = await fetchImpl(`${provider}/ipfs/${cid.toString()}?format=raw`, {
    headers: { Accept: 'application/vnd.ipld.raw' },
    signal: AbortSignal.timeout(RESPONSE_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length > MAX_BLOCK_BYTES) throw new Error('block too large')
  await assertHash(cid, bytes)
  return bytes
}

/**
 * The first bytes of the UnixFS file at `root`: the first leaf, reached through first links.
 * Every block on the way is verified against the CID that names it.
 */
async function firstLeaf(provider: string, root: CID, fetchImpl: typeof fetch): Promise<Uint8Array> {
  let cid = root
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const bytes = await fetchBlock(provider, cid, fetchImpl)
    if (cid.code === RAW_CODEC) return bytes
    if (cid.code !== DAG_PB_CODEC) throw plainContent(root)
    const node = dagPb.decode(bytes)
    const unixfs = node.Data == null ? undefined : UnixFS.unmarshal(node.Data)
    if (unixfs == null || (unixfs.type !== 'file' && unixfs.type !== 'raw')) throw plainContent(root)
    // A small file keeps its bytes in the node itself.
    if (unixfs.data != null && unixfs.data.length > 0) return unixfs.data
    const first = node.Links[0]
    if (first == null) throw plainContent(root)
    // dag-pb's multiformats is a different major than ours; cross by bytes.
    cid = CID.decode(first.Hash.bytes)
  }
  throw plainContent(root)
}

/** Parse the FEE header at the start of `bytes`, returning its Keysmith labels. */
async function headerLabels(bytes: Uint8Array, root: CID): Promise<PieceMetadata> {
  let labels: Record<string, unknown> | undefined
  let contentType: string | number | undefined
  // FEE parses the header, then asks for the key: stop there, before any ciphertext is touched.
  const stop = new Error('header read')
  await new Blob([new Uint8Array(bytes)])
    .stream()
    .pipeThrough(
      fee.decrypt((info) => {
        labels = info.appMetadata
        contentType = info.contentType
        throw stop
      })
    )
    .pipeTo(new WritableStream())
    .catch(() => undefined)
  if (labels == null) throw plainContent(root)
  if (contentType !== CAR_CONTENT_TYPE) throw foreignEnvelope(root)
  if (
    labels['foc/v'] !== 1 ||
    typeof labels['foc/own'] !== 'string' ||
    typeof labels['foc/ks'] !== 'string' ||
    typeof labels['foc/salt'] !== 'string'
  ) {
    throw foreignEnvelope(root)
  }
  return labels as unknown as PieceMetadata
}

/**
 * The header labels of the upload at `root`, read from the first of `providers` that serves its
 * blocks intact. Providers are tried in order; a block that fails its hash moves on to the next.
 *
 * @throws NotEncryptedUploadError when the verified content is not an `add --encrypt` upload.
 * @throws EnvelopeLabelsError when no provider serves a verified header.
 */
export async function readEnvelopeLabels(
  root: CID,
  providers: string[],
  fetchImpl: typeof fetch = fetch
): Promise<PieceMetadata> {
  const failures: string[] = []
  for (const provider of providers) {
    try {
      return await headerLabels(await firstLeaf(provider, root, fetchImpl), root)
    } catch (error) {
      // A verified answer: the next provider would serve the same blocks.
      if (error instanceof NotEncryptedUploadError) throw error
      failures.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new EnvelopeLabelsError(
    providers.length === 0
      ? `No provider found for ${root}`
      : `Could not read the header of ${root} from any provider (${failures.join('; ')})`
  )
}
