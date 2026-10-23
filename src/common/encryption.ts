/**
 * Envelope packing for `add --encrypt` and `decrypt`.
 *
 * The input (a file or a directory) is packed as a metadata-first UnixFS CAR under an
 * anonymous wrapping directory (see `unixfs-car-layout.ts`) and that CAR is wrapped in a
 * Filecoin Encryption Envelope (FEE, draft FRC filecoin-project/FIPs#1294). The key and
 * the envelope's authenticated `appMetadata` come from Keysmith (see `group-key.ts`): the
 * labels name the owner, the group key and the piece salt, which is all a reader needs to
 * derive the key again from the owner wallet. The public `content_type` is
 * `application/vnd.ipld.car`.
 *
 * Nothing about the plaintext (names, sizes, the root CID) is in the public header.
 */

import { createReadStream, createWriteStream, rmdirSync, rmSync } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { CarIndexedReader } from '@ipld/car'
import * as dagPb from '@ipld/dag-pb'
import * as fee from 'filecoin-encryption-envelope'
import { UnixFS } from 'ipfs-unixfs'
import { CID } from 'multiformats/cid'
import { isCar } from '../core/car/index.js'
import { NoFreeNameError } from './claim-output.js'
import { NotOwnerError, type PieceKey } from './group-key.js'
import { CAR_CONTENT_TYPE, DAG_PB_CODEC, RAW_CODEC } from './unixfs-car-layout.js'
import {
  type CarPayloadPlan,
  EncryptInputError,
  emitCarPayload,
  errorCode,
  planCarPayload,
  type WalkOptions,
} from './unixfs-car-payload.js'
import { type UnpackResult, unpackCar } from './unixfs-car-unpack.js'

/** Basename of the envelope that gets packed, so the original filename never reaches piece metadata. */
export const ENCRYPTED_FILE_NAME = 'encrypted.fee'

export interface EncryptResult {
  plan: CarPayloadPlan
}

/**
 * Pack `inputPath` (file or directory) as a CAR and stream it through FEE chunked
 * encryption into `outputPath` under `key`. No plaintext is written to disk.
 *
 * Every error is an {@link EncryptInputError} or a bare `Encryption failed: <code>`, so
 * no plaintext path or name reaches the caller's output or logs. `maxBytes` rejects an
 * input that cannot fit one upload before it is hashed.
 */
export async function encryptPath(
  inputPath: string,
  outputPath: string,
  key: PieceKey,
  walkOptions: WalkOptions = {},
  maxBytes?: number
): Promise<EncryptResult> {
  try {
    const plan = await planCarPayload(inputPath, walkOptions, maxBytes)
    await (Readable.toWeb(Readable.from(emitCarPayload(plan))) as ReadableStream<Uint8Array>)
      .pipeThrough(
        fee.encrypt({
          cek: key.cek,
          contentLength: plan.contentLength,
          contentType: CAR_CONTENT_TYPE,
          appMetadata: key.appMetadata,
        })
      )
      .pipeTo(Writable.toWeb(createWriteStream(outputPath, { mode: 0o600 })))
    return { plan }
  } catch (error) {
    throw error instanceof EncryptInputError ? error : new Error(`Encryption failed: ${errorCode(error)}`)
  }
}

const NOT_OURS = 'This file was not encrypted by `filecoin-pin add --encrypt`'
const TRUNCATED = 'The file is incomplete (the download was probably interrupted); fetch it again'
const MALFORMED =
  'The decrypted upload is malformed or unsafe to unpack (for example an entry name that escapes the output directory)'

/** A decrypt failure whose message names nothing from inside the envelope. */
class DecryptError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DecryptError'
  }
}

/**
 * The envelope bytes of a downloaded upload. A gateway's `/ipfs/<cid>?format=car` hands out the
 * outer CAR (a UnixFS file holding the envelope); a bare envelope is accepted as well.
 */
async function openEnvelope(
  inputPath: string
): Promise<{ stream: ReadableStream<Uint8Array>; close: () => Promise<void> }> {
  const sniff = createReadStream(inputPath)
  let car: boolean
  try {
    car = await isCar(sniff)
  } finally {
    sniff.destroy()
  }
  if (!car) {
    const stream = Readable.toWeb(createReadStream(inputPath)) as ReadableStream<Uint8Array>
    return { stream, close: () => Promise.resolve() }
  }
  // Indexing reads every block, so a partial download fails here with a parser error.
  const reader = await CarIndexedReader.fromFile(inputPath).catch((error) => {
    throw new DecryptError(TRUNCATED, { cause: error })
  })
  const [root] = await reader.getRoots()
  if (root == null) {
    await reader.close()
    throw new DecryptError(NOT_OURS)
  }
  return {
    stream: Readable.toWeb(Readable.from(unixfsFileBytes(reader, root))) as ReadableStream<Uint8Array>,
    close: () => reader.close(),
  }
}

/**
 * The bytes of the UnixFS file at `cid`, one leaf per pull. Reading leaves on demand keeps
 * memory at a block or two however large the file is; a reader that runs ahead of the
 * decryptor would queue the whole ciphertext.
 */
export async function* unixfsFileBytes(
  blocks: { get(cid: CID): Promise<{ bytes: Uint8Array } | undefined> },
  cid: CID
): AsyncGenerator<Uint8Array> {
  // The index is built from block lengths, so a cut block only fails when its bytes are read.
  const block = await blocks.get(cid).catch((error) => {
    throw new DecryptError(TRUNCATED, { cause: error })
  })
  if (block == null) {
    // A gateway CAR carries every block of the file, so a missing one means it was cut short.
    throw new DecryptError(TRUNCATED)
  }
  if (cid.code === RAW_CODEC) {
    yield block.bytes
    return
  }
  if (cid.code !== DAG_PB_CODEC) {
    throw new DecryptError(NOT_OURS)
  }
  let node: dagPb.PBNode
  let unixfs: UnixFS | undefined
  try {
    node = dagPb.decode(block.bytes)
    unixfs = node.Data == null ? undefined : UnixFS.unmarshal(node.Data)
  } catch (error) {
    throw new DecryptError(NOT_OURS, { cause: error })
  }
  if (unixfs == null || (unixfs.type !== 'file' && unixfs.type !== 'raw')) {
    throw new DecryptError(NOT_OURS)
  }
  if (unixfs.data != null && unixfs.data.length > 0) {
    yield unixfs.data
  }
  for (const link of node.Links) {
    // dag-pb's multiformats is a different major than the reader's; cross by bytes.
    yield* unixfsFileBytes(blocks, CID.decode(link.Hash.bytes))
  }
}

const exists = (path: string): Promise<Awaited<ReturnType<typeof stat>> | undefined> =>
  stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })

/**
 * Check both paths before anything is created or armed: the input must be a file, and the
 * output must be a directory (any contents) or absent with an existing parent. Returns
 * whether the output exists.
 */
export async function checkDecryptPaths(inputPath: string, outDir: string): Promise<{ outExists: boolean }> {
  const input = await exists(inputPath)
  if (input == null) {
    throw new Error(`Input file not found: ${inputPath}`)
  }
  if (input.isDirectory()) {
    throw new Error(`Input path is a directory: ${inputPath}`)
  }
  const out = await exists(outDir)
  if (out == null) {
    if ((await exists(dirname(outDir))) == null) {
      throw new Error(`Parent directory not found: ${dirname(outDir)}`)
    }
    return { outExists: false }
  }
  if (!out.isDirectory()) {
    throw new Error(`Output path exists and is not a directory: ${outDir}`)
  }
  return { outExists: true }
}

/**
 * Remove what this run wrote: the claimed entry, and `outDir` when this run created it and
 * nothing else is in it. Nothing else in `outDir` is touched. Sync so a signal handler can call it.
 */
export function removeDecryptOutput(outDir: string, created: boolean, claimed: string | undefined): void {
  if (claimed != null) {
    rmSync(claimed, { recursive: true, force: true })
  }
  if (created) {
    try {
      rmdirSync(outDir)
    } catch {
      // Not empty (someone else wrote there) or already gone: keep it.
    }
  }
}

/**
 * Restore the file or folder inside an envelope made by {@link encryptPath} into `outDir`
 * under its original name, numbered like a browser download when the name is taken (see
 * `claim-output.ts`). `outDir` may hold anything; it is created owner-only when missing.
 * `resolveKey` is called with the envelope's labels and returns the piece key (see
 * `ownerKeyResolver`). `onClaim` gets the entry's path as soon as it is claimed, before any
 * content is written. On failure only the claimed entry is removed (and `outDir` when this
 * run created it and it is left empty). Errors raised past the path checks never carry a
 * name or CID from inside the envelope.
 */
export async function decryptToDirectory(
  inputPath: string,
  outDir: string,
  resolveKey: fee.KeyResolver,
  onClaim?: (path: string) => void
): Promise<UnpackResult> {
  const { outExists } = await checkDecryptPaths(inputPath, outDir)
  if (!outExists) {
    await mkdir(outDir, { mode: 0o700 })
  }
  let claimed: string | undefined
  let envelope: Awaited<ReturnType<typeof openEnvelope>> | undefined
  try {
    envelope = await openEnvelope(inputPath)
    const plaintext = envelope.stream.pipeThrough(
      fee.decrypt((info) => {
        if (info.contentType !== CAR_CONTENT_TYPE) {
          throw new Error(`unexpected content type ${String(info.contentType)}`)
        }
        return resolveKey(info)
      })
    )
    return await unpackCar(plaintext, outDir, (path) => {
      claimed = path
      onClaim?.(path)
    })
  } catch (error) {
    removeDecryptOutput(outDir, !outExists, claimed)
    if (error instanceof fee.errors.AuthenticationError) {
      throw new DecryptError('Wrong key, or the file was modified', { cause: error })
    }
    if (error instanceof fee.errors.InvalidCiphertextLengthError) {
      throw new DecryptError(TRUNCATED, { cause: error })
    }
    if (error instanceof fee.errors.KeyResolutionError && error.cause instanceof NotOwnerError) {
      throw new DecryptError(error.cause.message, { cause: error })
    }
    if (error instanceof fee.errors.KeyResolutionError || error instanceof fee.errors.MalformedEnvelopeError) {
      throw new DecryptError(NOT_OURS, { cause: error })
    }
    if (
      error instanceof DecryptError ||
      error instanceof NoFreeNameError ||
      error instanceof fee.errors.EnvelopeError
    ) {
      throw error
    }
    // Anything else came from unpacking the plaintext, so its message may hold an entry name
    // or a CID from inside the envelope: keep only the errno code (ENOSPC, EACCES, ...).
    const code = (error as NodeJS.ErrnoException | null)?.code
    throw new DecryptError(typeof code === 'string' ? `Decryption failed: ${code}` : MALFORMED, { cause: error })
  } finally {
    await envelope?.close()
  }
}
