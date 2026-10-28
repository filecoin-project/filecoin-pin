/**
 * A local record of this machine's encrypted uploads, so `get-share-link` can mint a link
 * without fetching anything.
 *
 * ## Why it exists
 *
 * A share link (#779) names one upload by its Keysmith piece node, `piece:<salt>`, and the
 * sharer derives that upload's key from its own group key and the salt. The salt is 16 random
 * bytes chosen before encryption and written only into the envelope's (cleartext) header. Every
 * other input is in hand when sharing: the owner, the group key (`foc/ks`, in data set metadata),
 * and the upload's root and piece CIDs. The salt is not, and it cannot be made deterministic:
 *
 * - anything per-upload that exists before encryption is random (must be stored to be found
 *   again), derived from the plaintext (gone by the time you share, and a fingerprint in the
 *   cleartext header that lets anyone confirm "this upload is file X"), or a counter (repeats
 *   across machines, reusing a piece key, which FEE forbids);
 * - the CIDs only exist after encryption, since the envelope is part of what they hash.
 *
 * So the salt has to be recorded somewhere or read back from the upload. Recording it on chain
 * (piece metadata) would grow every `addPieces` message, which FOC avoids. This file is the
 * zero-network option for the machine that uploaded; `envelope-labels.ts` reads the header back,
 * from verified blocks, for any other upload.
 *
 * ## What it holds
 *
 * One JSON object per line, appended after each successful `add --encrypt`:
 *
 *     {"v":1,"rootCid":"bafy…","pieceCid":"bafk…","labels":{"foc/v":1,"foc/own":"0x…","foc/ks":"0x…","foc/salt":"0x…"},"ipfs":true,"at":"2026-…"}
 *
 * `labels` are the envelope's header labels, exactly as written (public: anyone who fetches the
 * upload can read them). **No key is ever stored.** The file does reveal which uploads are this
 * machine's, so it is written owner-only (0600) beside `session.env`. Losing it loses nothing:
 * sharing then falls back to reading the header.
 *
 * Writing is best effort: an upload never fails because its record could not be written.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PieceMetadata } from '@filoz/keysmith'
import { getDataDirectory } from '../config.js'

export const UPLOAD_RECORD_FILE = 'encrypted-uploads.jsonl'

export interface UploadRecord {
  /** The Encrypted root CID: what `get` and share links name. */
  rootCid: string
  /** The piece the upload was stored as; carried into share links as the claim's locator. */
  pieceCid: string
  /** The envelope's header labels, including `foc/salt`. */
  labels: PieceMetadata
  /**
   * False for a `--no-ipfs` upload, which nothing can fetch by its CID, so a Share link to it
   * would open nothing. Absent in records written before this field.
   */
  ipfs?: boolean
}

const recordPath = (dataDir: string) => join(dataDir, UPLOAD_RECORD_FILE)

/** Append one upload's record. Throws on a write failure; the caller decides whether that matters. */
export function recordEncryptedUpload(record: UploadRecord, dataDir: string = getDataDirectory()): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const line = JSON.stringify({ v: 1, ...record, at: new Date().toISOString() })
  appendFileSync(recordPath(dataDir), `${line}\n`, { mode: 0o600 })
}

/**
 * The record for `rootCid`, or undefined when this machine has none. Unreadable or malformed
 * lines are skipped, so a damaged file degrades to the header read rather than failing.
 */
export function findEncryptedUpload(rootCid: string, dataDir: string = getDataDirectory()): UploadRecord | undefined {
  let text: string
  try {
    text = readFileSync(recordPath(dataDir), 'utf8')
  } catch {
    return undefined
  }
  let found: UploadRecord | undefined
  for (const line of text.split('\n')) {
    try {
      const entry = JSON.parse(line) as Partial<UploadRecord> & { v?: unknown }
      const labels = entry.labels as Partial<PieceMetadata> | undefined
      if (
        entry.v === 1 &&
        entry.rootCid === rootCid &&
        typeof entry.pieceCid === 'string' &&
        labels?.['foc/v'] === 1 &&
        typeof labels['foc/own'] === 'string' &&
        typeof labels['foc/ks'] === 'string' &&
        typeof labels['foc/salt'] === 'string'
      ) {
        // The last record for a root wins (an upload repeated after a failure, say).
        found = {
          rootCid: entry.rootCid,
          pieceCid: entry.pieceCid,
          labels: labels as PieceMetadata,
          ...(typeof entry.ipfs === 'boolean' && { ipfs: entry.ipfs }),
        }
      }
    } catch {
      // A partial line (a crash mid-append) or hand edits: skip it.
    }
  }
  return found
}
