/**
 * `get`: fetch an upload by its IPFS root CID and save the original into a directory,
 * decrypted when it is an `add --encrypt` envelope, unchanged otherwise.
 *
 * The CAR is downloaded and verified first (see `ipfs-car-fetch.ts`), so everything below
 * reads a complete, hash-checked DAG from a private temp file.
 */

import { createWriteStream } from 'node:fs'
import { mkdir, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { CarIndexedReader } from '@ipld/car'
import * as dagPb from '@ipld/dag-pb'
import * as fee from 'filecoin-encryption-envelope'
import { UnixFS } from 'ipfs-unixfs'
import { exporter, type UnixFSEntry } from 'ipfs-unixfs-exporter'
import { CID } from 'multiformats/cid'
import { claimEntry } from './claim-output.js'
import {
  anyCidVersion,
  checkOutputDir,
  decryptToDirectory,
  removeDecryptOutput,
  unixfsFileBytes,
} from './encryption.js'
import {
  type FetchOptions,
  fetchVerifiedCar,
  isSupportedHash,
  NotUnixfsError,
  type ProviderSource,
  UnsupportedHashError,
} from './ipfs-car-fetch.js'
import { CAR_CONTENT_TYPE, DAG_PB_CODEC, isUnsafeName, RAW_CODEC } from './unixfs-car-layout.js'
import { insideDir } from './unixfs-car-unpack.js'

/** Bytes read from a UnixFS file per exporter call: the exporter queues a whole file's blocks otherwise. */
const READ_WINDOW = 8 * 1024 * 1024
/** The FEE header (about 260 bytes) always fits in the first leaf. */
const HEADER_PROBE_BYTES = 1024 * 1024
/**
 * Entries a plain folder may hold, counting every place a shared sub-tree is linked from: with
 * `dups=n` a small CAR can link one folder many times over.
 */
export const MAX_ENTRIES = 1_000_000

export interface GetResult {
  encrypted: boolean
  files: number
  dirs: number
  /** The saved entry: `<outDir>/<name>`, or a numbered variant when the name was taken. */
  path: string
  /** Base URL of the provider whose CAR was used. */
  provider: string
}

export interface GetOptions extends FetchOptions {
  /** A private, empty directory owned by the caller for the downloaded CAR. */
  tempDir: string
  /** Called with the entry's path as soon as it is claimed, before any content is written. */
  onClaim?: (path: string) => void
}

/** A verified CAR that still lacks a block: only reachable if the file changed after verification. */
class IncompleteCarError extends Error {
  constructor() {
    super('The download is incomplete; try again')
    this.name = 'IncompleteCarError'
  }
}

/** The plain content does not fit: refused before anything is written. */
export class NotEnoughSpaceError extends Error {
  constructor(needed: bigint, free: bigint, outDir: string) {
    super(`The content needs ${needed} bytes but only ${free} bytes are free in ${outDir}`)
    this.name = 'NotEnoughSpaceError'
  }
}

/**
 * Fetch `cid` from the first provider that serves a verified CAR and save it as one entry
 * in `outDir`, which may hold anything and is created owner-only when missing. An encrypted
 * upload is decrypted with `resolveKey`, which is not called for plain content, and keeps its
 * original name. A plain file or folder is named `<cid>`, since its DAG holds no root name. A
 * taken name is numbered like a browser download (see `claim-output.ts`). On failure only
 * that entry is removed.
 *
 * `sources` each list candidate provider URLs; they start together once the paths are
 * checked, and fetching starts as each one returns.
 */
export async function getToDirectory(
  cid: CID,
  outDir: string,
  sources: ProviderSource[],
  resolveKey: fee.KeyResolver,
  options: GetOptions
): Promise<GetResult> {
  if (cid.code !== RAW_CODEC && cid.code !== DAG_PB_CODEC) {
    throw new NotUnixfsError(`the root has codec 0x${cid.code.toString(16)}`)
  }
  if (!isSupportedHash(cid)) throw new UnsupportedHashError(cid)
  await checkOutputDir(outDir)
  const carPath = join(options.tempDir, 'download.car')
  const { provider } = await fetchVerifiedCar(cid, sources, carPath, options)
  const kind = await detect(carPath, cid)
  if (kind === 'encrypted') {
    const { files, dirs, path } = await decryptToDirectory(carPath, outDir, resolveKey, options.onClaim)
    return { encrypted: true, files, dirs, path, provider }
  }
  return { encrypted: false, ...(await extractUnixfs(carPath, cid, outDir, options.onClaim)), provider }
}

/** What a verified CAR holds: an `add --encrypt` envelope, a plain file, or a plain directory. */
export async function detect(carPath: string, root: CID): Promise<'encrypted' | 'file' | 'directory'> {
  const car = await CarIndexedReader.fromFile(carPath)
  const reader = anyCidVersion(car)
  try {
    const block = await reader.get(root)
    if (block == null) throw new IncompleteCarError()
    if (root.code === DAG_PB_CODEC) {
      let type: string
      try {
        const data = dagPb.decode(block.bytes).Data
        if (data == null) throw new Error('no UnixFS data')
        type = UnixFS.unmarshal(data).type
      } catch (error) {
        throw new NotUnixfsError('the root is dag-pb without UnixFS data', { cause: error })
      }
      if (type === 'directory' || type === 'hamt-sharded-directory') return 'directory'
      if (type !== 'file' && type !== 'raw') throw new NotUnixfsError(`the root is a UnixFS ${type}`)
    }
    return (await isEnvelope(reader, root)) ? 'encrypted' : 'file'
  } finally {
    await car.close()
  }
}

/** Whether the file at `root` opens with a FEE header for a CAR, as `add --encrypt` writes. */
async function isEnvelope(reader: ReturnType<typeof anyCidVersion>, root: CID): Promise<boolean> {
  const head: Uint8Array[] = []
  let length = 0
  for await (const chunk of unixfsFileBytes(reader, root)) {
    head.push(chunk)
    length += chunk.length
    if (length >= HEADER_PROBE_BYTES) break
  }
  try {
    return (await fee.parse(Buffer.concat(head))).contentType === CAR_CONTENT_TYPE
  } catch {
    return false
  }
}

/** Read a UnixFS file in bounded windows; see {@link READ_WINDOW}. */
async function* readWindows(
  entry: { content(options: { offset: number; length: number }): AsyncIterable<Uint8Array> },
  size: number
): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < size; offset += READ_WINDOW) {
    yield* entry.content({ offset, length: Math.min(READ_WINDOW, size - offset) })
  }
}

/** Fail once `source` yields more than `limit` bytes: a file never outgrows its declared size. */
async function* capped(source: AsyncIterable<Uint8Array>, limit: bigint): AsyncGenerator<Uint8Array> {
  let total = 0n
  for await (const chunk of source) {
    total += BigInt(chunk.length)
    if (total > limit) throw new Error('a file holds more bytes than its UnixFS size declares')
    yield chunk
  }
}

/**
 * Write the plain UnixFS DAG at `root` from a verified CAR into `outDir` as a file or folder
 * named `<root>` (numbered when taken), claimed before anything is written; `onClaim` gets its
 * path. Directories 0700, files 0600 created exclusively. Unsafe entry names, symlinks and
 * other non-file entries fail the whole extraction, and the claimed entry is removed.
 *
 * The declared size of the whole tree (every file's UnixFS size, counted wherever it is linked)
 * is checked against the free space in `outDir` before the claim, so a small CAR that links one
 * leaf many times cannot fill the disk; each file is also stopped at its declared size.
 */
export async function extractUnixfs(
  carPath: string,
  root: CID,
  outDir: string,
  onClaim?: (path: string) => void
): Promise<{ files: number; dirs: number; path: string }> {
  const { outExists } = await checkOutputDir(outDir)
  if (!outExists) await mkdir(outDir, { mode: 0o700 })
  const car = await CarIndexedReader.fromFile(carPath)
  const reader = anyCidVersion(car)
  const blockstore = {
    async *get(cid: { bytes: Uint8Array }): AsyncGenerator<Uint8Array> {
      // The exporter's CID class is not ours; cross by bytes.
      const block = await reader.get(CID.decode(cid.bytes))
      if (block == null) throw new IncompleteCarError()
      yield block.bytes
    },
  }
  const counts = { files: 0, dirs: 0 }
  let claimed: string | undefined

  // `flags` is `wx` for a new file, `r+` for the claimed one.
  const writeFile = async (entry: UnixFSEntry, path: string, target: string, flags: string): Promise<void> => {
    let content: AsyncIterable<Uint8Array>
    if (entry.type === 'file') {
      const type = entry.unixfs.type
      if (type !== 'file' && type !== 'raw') throw new NotUnixfsError(`entry ${path} is a UnixFS ${type}`)
      content = capped(readWindows(entry, Number(entry.unixfs.fileSize())), entry.unixfs.fileSize())
    } else if (entry.type === 'raw' || entry.type === 'identity') {
      content = capped(entry.content(), entry.size)
    } else {
      throw new NotUnixfsError(`entry ${path} is ${entry.type}`)
    }
    await pipeline(Readable.from(content), createWriteStream(target, { flags, mode: 0o600 }))
    counts.files++
  }

  const writeDirectory = async (
    entry: UnixFSEntry & { type: 'directory' },
    base: string,
    path: string
  ): Promise<void> => {
    for await (const child of entry.entries()) {
      if (isUnsafeName(child.name)) {
        throw new Error(`entry ${JSON.stringify(child.name)} is unsafe to write`)
      }
      const childPath = path === '' ? child.name : `${path}/${child.name}`
      const node = await exporter(child.cid.toString(), blockstore)
      if (node.type === 'directory') {
        await mkdir(insideDir(base, childPath), { mode: 0o700 })
        counts.dirs++
        await writeDirectory(node, base, childPath)
      } else {
        await writeFile(node, childPath, insideDir(base, childPath), 'wx')
      }
    }
  }

  // Every file's declared size, wherever it is linked; content checks come later, while writing.
  let entries = 0
  const declaredSize = async (entry: UnixFSEntry): Promise<bigint> => {
    if (++entries > MAX_ENTRIES) throw new Error(`the folder holds more than ${MAX_ENTRIES} entries`)
    if (entry.type === 'file') return entry.unixfs.fileSize()
    if (entry.type === 'raw' || entry.type === 'identity') return entry.size
    if (entry.type !== 'directory') return 0n
    let total = 0n
    for await (const child of entry.entries()) {
      total += await declaredSize(await exporter(child.cid.toString(), blockstore))
    }
    return total
  }

  try {
    // A string, since our multiformats CID class is not the exporter's.
    const entry = await exporter(root.toString(), blockstore)
    const needed = await declaredSize(entry)
    const { bavail, bsize } = await statfs(outDir)
    const free = BigInt(bavail) * BigInt(bsize)
    if (needed > free) throw new NotEnoughSpaceError(needed, free, outDir)
    claimed = claimEntry(outDir, root.toString(), entry.type === 'directory' ? 'folder' : 'file')
    onClaim?.(claimed)
    if (entry.type === 'directory') await writeDirectory(entry, claimed, '')
    else await writeFile(entry, root.toString(), claimed, 'r+')
    return { ...counts, path: claimed }
  } catch (error) {
    removeDecryptOutput(outDir, !outExists, claimed)
    throw error
  } finally {
    await car.close()
  }
}
