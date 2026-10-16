/**
 * Password-based encryption for `add --encrypt` and `decrypt`.
 *
 * The input (a file or a directory) is packed as a metadata-first UnixFS CAR under an
 * anonymous wrapping directory (see `unixfs-car-layout.ts`) and that CAR is wrapped in a
 * Filecoin Encryption Envelope (FEE, draft FRC filecoin-project/FIPs#1294) whose
 * content-encryption key is derived from the password with PBKDF2-SHA256. The envelope's
 * public `content_type` is `application/vnd.ipld.car`; its authenticated `appMetadata`
 * records how to derive the key again from the password:
 *
 * ```json
 * { "kdf": "pbkdf2-sha256", "iterations": 600000, "salt": "<base64 of 16 random bytes>" }
 * ```
 *
 * Nothing about the plaintext (names, sizes, the root CID) is in the public header.
 */

import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { isCancel, password as promptPassword } from '@clack/prompts'
import { CarIndexedReader } from '@ipld/car'
import * as fee from 'filecoin-encryption-envelope'
import { exporter } from 'ipfs-unixfs-exporter'
import { CID } from 'multiformats/cid'
import { isCar } from '../core/car/index.js'
import { isInteractive } from '../utils/cli-helpers.js'
import { CliIncomplete } from './cli-errors.js'
import { CAR_CONTENT_TYPE } from './unixfs-car-layout.js'
import { type CarPayloadPlan, emitCarPayload, planCarPayload, type WalkOptions } from './unixfs-car-payload.js'
import { type UnpackResult, unpackCar } from './unixfs-car-unpack.js'

/** Basename of the envelope that gets packed, so the original filename never reaches piece metadata. */
export const ENCRYPTED_FILE_NAME = 'encrypted.fee'

const PBKDF2_ITERATIONS = 600_000
// Caps the key-derivation work a crafted envelope can demand from a decryptor.
const MAX_PBKDF2_ITERATIONS = 10_000_000
const SALT_BYTES = 16

export async function derivePasswordKey(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number
): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    baseKey,
    fee.constants.KEY_SIZE * 8
  )
  return new Uint8Array(bits)
}

export interface EncryptResult {
  plan: CarPayloadPlan
}

/**
 * Pack `inputPath` (file or directory) as a CAR and stream it through FEE chunked
 * encryption into `outputPath`. No plaintext is written to disk.
 */
export async function encryptPathWithPassword(
  inputPath: string,
  outputPath: string,
  password: string,
  walkOptions: WalkOptions = {}
): Promise<EncryptResult> {
  const plan = await planCarPayload(inputPath, walkOptions)
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const cek = await derivePasswordKey(password, salt, PBKDF2_ITERATIONS)
  const appMetadata = {
    kdf: 'pbkdf2-sha256',
    iterations: PBKDF2_ITERATIONS,
    salt: Buffer.from(salt).toString('base64'),
  }
  await (Readable.toWeb(Readable.from(emitCarPayload(plan))) as ReadableStream<Uint8Array>)
    .pipeThrough(fee.encrypt({ cek, contentLength: plan.contentLength, contentType: CAR_CONTENT_TYPE, appMetadata }))
    .pipeTo(Writable.toWeb(createWriteStream(outputPath, { mode: 0o600 })))
  return { plan }
}

const NOT_OURS = 'This file was not encrypted by `filecoin-pin add --encrypt`'
const TRUNCATED = 'The file is incomplete (the download was probably interrupted); fetch it again'

/** Decode the KDF parameters from the public header, refusing anything but our exact shape. */
function kdfParams(appMetadata: fee.AppMetadata | undefined): { salt: Uint8Array<ArrayBuffer>; iterations: number } {
  const { kdf, iterations, salt } = appMetadata ?? {}
  if (kdf !== 'pbkdf2-sha256' || typeof salt !== 'string' || typeof iterations !== 'number') {
    throw new Error('missing or unsupported key derivation parameters')
  }
  if (!Number.isSafeInteger(iterations) || iterations <= 0 || iterations > MAX_PBKDF2_ITERATIONS) {
    throw new Error(`unsupported iteration count ${iterations}`)
  }
  const bytes = Buffer.from(salt, 'base64')
  if (bytes.length !== SALT_BYTES || bytes.toString('base64') !== salt) {
    throw new Error('malformed salt')
  }
  return { salt: new Uint8Array(bytes), iterations }
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
    const stream = Readable.toWeb(createReadStream(inputPath, { highWaterMark: 1 << 20 })) as ReadableStream<Uint8Array>
    return { stream, close: () => Promise.resolve() }
  }
  const reader = await CarIndexedReader.fromFile(inputPath)
  const [root] = await reader.getRoots()
  if (root == null) {
    await reader.close()
    throw new Error(NOT_OURS)
  }
  // The exporter's multiformats is a different major than the reader's; cross by string and bytes.
  const entry = await exporter(root.toString(), {
    async *get(cid) {
      const block = await reader.get(CID.decode(cid.bytes))
      if (block == null) {
        throw new Error(`block ${cid} is missing from the CAR`)
      }
      yield block.bytes
    },
  })
  if (entry.type !== 'file' && entry.type !== 'raw') {
    await reader.close()
    throw new Error(NOT_OURS)
  }
  return {
    stream: Readable.toWeb(Readable.from(entry.content())) as ReadableStream<Uint8Array>,
    close: () => reader.close(),
  }
}

/**
 * Write the files inside an envelope made by {@link encryptPathWithPassword} under
 * `outDir`, which is created (owner-only) or must be empty, like `git clone`. On
 * failure everything written is removed; a pre-existing directory itself is kept.
 */
export async function decryptToDirectory(inputPath: string, outDir: string, password: string): Promise<UnpackResult> {
  let created = false
  try {
    await mkdir(outDir, { mode: 0o700 })
    created = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }
    if ((await readdir(outDir)).length > 0) {
      throw new Error(`Output directory is not empty: ${outDir}`)
    }
  }
  const cleanup = async (): Promise<void> => {
    if (created) {
      await rm(outDir, { recursive: true, force: true })
      return
    }
    for (const entry of await readdir(outDir)) {
      await rm(join(outDir, entry), { recursive: true, force: true })
    }
  }
  let envelope: Awaited<ReturnType<typeof openEnvelope>> | undefined
  try {
    envelope = await openEnvelope(inputPath)
    const plaintext = envelope.stream.pipeThrough(
      fee.decrypt(({ contentType, appMetadata }) => {
        if (contentType !== CAR_CONTENT_TYPE) {
          throw new Error(`unexpected content type ${String(contentType)}`)
        }
        const { salt, iterations } = kdfParams(appMetadata)
        return derivePasswordKey(password, salt, iterations)
      })
    )
    return await unpackCar(plaintext, outDir)
  } catch (error) {
    await cleanup()
    if (error instanceof fee.errors.AuthenticationError) {
      throw new Error('Wrong password, or the file was modified', { cause: error })
    }
    if (error instanceof fee.errors.InvalidCiphertextLengthError) {
      throw new Error(TRUNCATED, { cause: error })
    }
    if (error instanceof fee.errors.KeyResolutionError || error instanceof fee.errors.MalformedEnvelopeError) {
      throw new Error(NOT_OURS, { cause: error })
    }
    throw error
  } finally {
    await envelope?.close()
  }
}

/**
 * Resolve the password from `--password-file`, then FILECOIN_PIN_PASSWORD,
 * then an interactive prompt. The password is never accepted as an argument.
 */
export async function resolvePassword(passwordFile?: string): Promise<string> {
  if (passwordFile != null) {
    // `echo secret > file` adds a newline that is not part of the password.
    const fromFile = (await readFile(passwordFile, 'utf8')).replace(/\r?\n$/, '')
    if (fromFile === '') {
      throw new Error(`Password file is empty: ${passwordFile}`)
    }
    return fromFile
  }

  const fromEnv = process.env.FILECOIN_PIN_PASSWORD
  if (fromEnv) {
    return fromEnv
  }

  if (!isInteractive()) {
    throw new Error('A password is required: set FILECOIN_PIN_PASSWORD or pass --password-file <path>')
  }

  const entered = await promptPassword({
    message: 'Password',
    validate: (value) => (value ? undefined : 'Password is required'),
  })
  if (isCancel(entered)) {
    throw new CliIncomplete('Password entry cancelled')
  }
  return entered
}
