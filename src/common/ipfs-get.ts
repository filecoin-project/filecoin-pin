/**
 * `get`: fetch an upload by its IPFS root CID and write the original into a new directory,
 * decrypted when it is an `add --encrypt` envelope, unchanged otherwise.
 *
 * The CAR is downloaded and verified first (see `ipfs-car-fetch.ts`), so everything below
 * reads a complete, hash-checked DAG from a private temp file.
 */

import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { CarIndexedReader } from '@ipld/car'
import * as dagPb from '@ipld/dag-pb'
import * as fee from 'filecoin-encryption-envelope'
import { UnixFS } from 'ipfs-unixfs'
import { exporter, type UnixFSEntry } from 'ipfs-unixfs-exporter'
import type { CID } from 'multiformats/cid'
import { checkOutputDir, decryptToDirectory, removeDecryptOutput, unixfsFileBytes } from './encryption.js'
import { type FetchOptions, fetchVerifiedCar, NotUnixfsError } from './ipfs-car-fetch.js'
import { CAR_CONTENT_TYPE, DAG_PB_CODEC, isUnsafeName, RAW_CODEC } from './unixfs-car-layout.js'
import { insideDir } from './unixfs-car-unpack.js'

/** Bytes read from a UnixFS file per exporter call: the exporter queues a whole file's blocks otherwise. */
const READ_WINDOW = 8 * 1024 * 1024
/** The FEE header (about 260 bytes) always fits in the first leaf. */
const HEADER_PROBE_BYTES = 1024 * 1024

export interface GetResult {
  encrypted: boolean
  files: number
  dirs: number
  /** Base URL of the provider whose CAR was used. */
  provider: string
}

export interface GetOptions extends FetchOptions {
  /** A private, empty directory owned by the caller for the downloaded CAR. */
  tempDir: string
  concurrency?: number
}

/** A verified CAR that still lacks a block: only reachable if the file changed after verification. */
class IncompleteCarError extends Error {
  constructor() {
    super('The download is incomplete; try again')
    this.name = 'IncompleteCarError'
  }
}

type BlockReader = { get(cid: CID): Promise<{ bytes: Uint8Array } | undefined> }

/**
 * Fetch `cid` from the first provider that serves a verified CAR and write it
 * under `outDir` (created owner-only, or must be empty). An encrypted upload is decrypted
 * with `resolveKey`, which is not called for plain content. A plain file is written as
 * `<outDir>/<cid>` (its name is not in its DAG); a directory's contents go under `outDir`.
 * On failure everything written is removed.
 *
 * `findProviders` each list candidate provider URLs; they start together once the paths
 * are checked, and fetching starts as each one returns.
 */
export async function getToDirectory(
  cid: CID,
  outDir: string,
  findProviders: Array<() => Promise<string[]>>,
  resolveKey: fee.KeyResolver,
  options: GetOptions
): Promise<GetResult> {
  if (cid.code !== RAW_CODEC && cid.code !== DAG_PB_CODEC) {
    throw new NotUnixfsError(`the root has codec 0x${cid.code.toString(16)}`)
  }
  await checkOutputDir(outDir)
  const carPath = join(options.tempDir, 'download.car')
  const { provider } = await fetchVerifiedCar(
    cid,
    findProviders.map((find) => find()),
    carPath,
    options
  )
  const kind = await detect(carPath, cid)
  if (kind === 'encrypted') {
    const { files, dirs } = await decryptToDirectory(carPath, outDir, resolveKey)
    return { encrypted: true, files, dirs, provider }
  }
  return { encrypted: false, ...(await extractUnixfs(carPath, cid, outDir)), provider }
}

/** What a verified CAR holds: an `add --encrypt` envelope, a plain file, or a plain directory. */
export async function detect(carPath: string, root: CID): Promise<'encrypted' | 'file' | 'directory'> {
  const reader = await CarIndexedReader.fromFile(carPath)
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
    await reader.close()
  }
}

/** Whether the file at `root` opens with a FEE header for a CAR, as `add --encrypt` writes. */
async function isEnvelope(reader: BlockReader, root: CID): Promise<boolean> {
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

/**
 * Write the plain UnixFS DAG at `root` from a verified CAR under `outDir`: a file as
 * `<outDir>/<root>`, a directory's contents directly under `outDir`. Directories 0700,
 * files 0600 created exclusively. Unsafe entry names, symlinks and other non-file
 * entries fail the whole extraction, and everything written is removed.
 */
export async function extractUnixfs(
  carPath: string,
  root: CID,
  outDir: string
): Promise<{ files: number; dirs: number }> {
  const { outExists } = await checkOutputDir(outDir)
  if (!outExists) await mkdir(outDir, { mode: 0o700 })
  const reader = await CarIndexedReader.fromFile(carPath)
  const blockstore = {
    async *get(cid: CID): AsyncGenerator<Uint8Array> {
      if (cid.multihash.code === 0x00) {
        yield cid.multihash.digest
        return
      }
      const block = await reader.get(cid)
      if (block == null) throw new IncompleteCarError()
      yield block.bytes
    },
  }
  const counts = { files: 0, dirs: 0 }

  const writeFile = async (entry: UnixFSEntry, path: string): Promise<void> => {
    let content: AsyncIterable<Uint8Array>
    if (entry.type === 'file') {
      const type = entry.unixfs.type
      if (type !== 'file' && type !== 'raw') throw new NotUnixfsError(`entry ${path} is a UnixFS ${type}`)
      content = readWindows(entry, Number(entry.unixfs.fileSize()))
    } else if (entry.type === 'raw' || entry.type === 'identity') {
      content = entry.content()
    } else {
      throw new NotUnixfsError(`entry ${path} is ${entry.type}`)
    }
    await pipeline(Readable.from(content), createWriteStream(insideDir(outDir, path), { flags: 'wx', mode: 0o600 }))
    counts.files++
  }

  const writeDirectory = async (entry: UnixFSEntry & { type: 'directory' }, path: string): Promise<void> => {
    for await (const child of entry.entries()) {
      if (isUnsafeName(child.name)) {
        throw new Error(`entry ${JSON.stringify(child.name)} is unsafe to write`)
      }
      const childPath = path === '' ? child.name : `${path}/${child.name}`
      const node = await exporter(child.cid.toString(), blockstore)
      if (node.type === 'directory') {
        await mkdir(insideDir(outDir, childPath), { mode: 0o700 })
        counts.dirs++
        await writeDirectory(node, childPath)
      } else {
        await writeFile(node, childPath)
      }
    }
  }

  try {
    // A string, since our multiformats CID class is not the exporter's.
    const entry = await exporter(root.toString(), blockstore)
    if (entry.type === 'directory') await writeDirectory(entry, '')
    else await writeFile(entry, root.toString())
    return counts
  } catch (error) {
    removeDecryptOutput(outDir, !outExists)
    throw error
  } finally {
    await reader.close()
  }
}
