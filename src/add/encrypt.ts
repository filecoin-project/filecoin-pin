/**
 * Password-based encryption for `add --encrypt`.
 *
 * The file is wrapped in a Filecoin Encryption Envelope (FEE, FIP-1253) whose
 * content-encryption key is derived from the password with PBKDF2-SHA256. The
 * KDF parameters ride in the envelope's authenticated `appMetadata` so a
 * decryptor holding only the password can derive the key again:
 *
 * ```json
 * { "kdf": "pbkdf2-sha256", "iterations": 600000, "salt": "<base64 of 16 random bytes>" }
 * ```
 */

import { createReadStream, createWriteStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { Readable, Writable } from 'node:stream'
import { isCancel, password as promptPassword } from '@clack/prompts'
// TODO: package.json links a local build of this package; switch to the npm release
// once FilOzone/synapse-sdk#1015 publishes it.
import * as fee from '@filoz/filecoin-encryption-envelope'
import { CliIncomplete } from '../common/cli-errors.js'
import { isInteractive } from '../utils/cli-helpers.js'

/** Basename of the envelope that gets packed, so the original filename never reaches piece metadata. */
export const ENCRYPTED_FILE_NAME = 'encrypted.fee'

const PBKDF2_ITERATIONS = 600_000
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

/**
 * Stream `inputPath` through FEE chunked encryption into `outputPath`.
 */
export async function encryptFileWithPassword(
  inputPath: string,
  inputSize: number,
  outputPath: string,
  password: string
): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const cek = await derivePasswordKey(password, salt, PBKDF2_ITERATIONS)
  const appMetadata = {
    kdf: 'pbkdf2-sha256',
    iterations: PBKDF2_ITERATIONS,
    salt: Buffer.from(salt).toString('base64'),
  }
  const source = Readable.toWeb(createReadStream(inputPath)) as ReadableStream<Uint8Array>
  await source
    .pipeThrough(fee.encrypt({ cek, contentLength: inputSize, appMetadata }))
    .pipeTo(Writable.toWeb(createWriteStream(outputPath)))
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
    throw new Error(`--encrypt needs a password: set FILECOIN_PIN_PASSWORD or pass --password-file <path>`)
  }

  const entered = await promptPassword({
    message: 'Password to encrypt with',
    validate: (value) => (value ? undefined : 'Password is required'),
  })
  if (isCancel(entered)) {
    throw new CliIncomplete('Password entry cancelled')
  }
  return entered
}
