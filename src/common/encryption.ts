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

import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { Readable, Writable } from 'node:stream'
import * as fee from 'filecoin-encryption-envelope'
import { NotOwnerError, type PieceKey } from './group-key.js'
import { CAR_CONTENT_TYPE } from './unixfs-car-layout.js'
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

/**
 * Write the files inside an envelope made by {@link encryptPath} under `outDir`,
 * which must not exist yet. `resolveKey` is called with the envelope's labels and
 * returns the piece key (see `ownerKeyResolver`). Nothing is left there on failure.
 */
export async function decryptToDirectory(
  inputPath: string,
  outDir: string,
  resolveKey: fee.KeyResolver
): Promise<UnpackResult> {
  await mkdir(outDir, { mode: 0o700 }).catch((error) => {
    throw error?.code === 'EEXIST' ? new Error(`Output directory already exists: ${outDir}`) : error
  })
  const source = Readable.toWeb(createReadStream(inputPath, { highWaterMark: 1 << 20 })) as ReadableStream<Uint8Array>
  try {
    const plaintext = source.pipeThrough(
      fee.decrypt((info) => {
        if (info.contentType !== CAR_CONTENT_TYPE) {
          throw new Error(`unexpected content type ${String(info.contentType)}`)
        }
        return resolveKey(info)
      })
    )
    return await unpackCar(plaintext, outDir)
  } catch (error) {
    await rm(outDir, { recursive: true, force: true })
    if (error instanceof fee.errors.AuthenticationError) {
      throw new Error('Wrong key, or the file was modified', { cause: error })
    }
    if (error instanceof fee.errors.KeyResolutionError && error.cause instanceof NotOwnerError) {
      throw new Error(error.cause.message, { cause: error })
    }
    if (error instanceof fee.errors.KeyResolutionError || error instanceof fee.errors.MalformedEnvelopeError) {
      throw new Error(NOT_OURS, { cause: error })
    }
    throw error
  }
}
