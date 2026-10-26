/**
 * Build the plaintext payload of an encrypted upload: a metadata-first UnixFS CAR of the
 * input (file or directory) under an anonymous wrapping directory, streamed in two passes
 * so no plaintext is ever written to disk.
 *
 *   pass 1  the UnixFS importer (`unixfs-v1-2025` profile, so CIDs match an unencrypted
 *           `add`) computes the DAG; dag-pb nodes are kept in memory, leaf bytes are not
 *   pass 2  every leaf is re-read at its known offset and emitted in layout order
 *
 * A file that changes between the passes would produce leaves that no longer match their
 * CIDs, so pass 2 hashes every leaf again before emitting it, and checks the size and mtime
 * of every input file after the last leaf (cheap, and catches growth past the last leaf).
 *
 * Errors about the input are {@link EncryptInputError}s, which name an entry by its position
 * (`entry #N`, in walk order), never by its path: they reach terminals, CI logs and pino.
 */

import { createReadStream } from 'node:fs'
import { lstat, open, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { BufferImporter, ImportCandidate, ImporterOptions, WritableStorage } from 'ipfs-unixfs-importer'
import { importer } from 'ipfs-unixfs-importer'
import { equals } from 'multiformats/bytes'
import { CID } from 'multiformats/cid'
import * as Digest from 'multiformats/hashes/digest'
import { importerOptions } from '../core/unixfs/importer-options.js'
import {
  type CarLayout,
  DAG_PB_CODEC,
  encodeVarint,
  layout,
  type MetadataNode,
  RAW_CODEC,
} from './unixfs-car-layout.js'

const SHA256_CODE = 0x12

/** Chunks hashed at once in pass 1; WebCrypto digests run on the libuv threadpool, so this is real parallelism. */
const HASH_CONCURRENCY = 8

/** An input problem, described without the entry's path or name. */
export class EncryptInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EncryptInputError'
  }
}

/** The error's `code` (EACCES, ENOENT, ...) or its class name: never its message, which may hold a path. */
export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  return error instanceof Error ? error.name : 'unknown error'
}

const unreadable = (entry: number, error: unknown): EncryptInputError =>
  new EncryptInputError(`Cannot read an input entry (entry #${entry}): ${errorCode(error)}`)

const changed = (entry: number): EncryptInputError =>
  new EncryptInputError(`Input changed during encryption (entry #${entry}); re-run`)

export interface InputFile {
  /** Path inside the wrapper, `basename(input)/...`. */
  rel: string
  abs: string
  size: number
  mtimeNs: bigint
  /** 1-based position in walk order, the only way errors refer to this file. */
  entry: number
}

export interface InputWalk {
  name: string
  isDirectory: boolean
  files: InputFile[]
  /** Directory paths inside the wrapper, parents first. */
  dirs: string[]
  /** Symlinks found under the input, which are not packed. */
  skippedSymlinks: string[]
  /** FIFOs, sockets and devices found under the input, which are not packed. */
  skippedSpecial: string[]
}

export interface WalkOptions {
  /** Pack dotfiles and dot-directories; always on for a root that is itself hidden, matching `add`. */
  includeHidden?: boolean
}

/**
 * List the input's files and directories. Symlinks are reported and skipped, never followed;
 * FIFOs, sockets and devices are reported and skipped too.
 */
export async function walkInput(inputPath: string, { includeHidden = false }: WalkOptions = {}): Promise<InputWalk> {
  const name = basename(inputPath)
  const hidden = includeHidden || name.startsWith('.')
  const files: InputFile[] = []
  const dirs: string[] = []
  const skippedSymlinks: string[] = []
  const skippedSpecial: string[] = []
  // 1-based position of the next entry, in walk order, for error messages.
  const nextEntry = (): number => dirs.length + files.length + skippedSymlinks.length + skippedSpecial.length + 1
  const checkName = (entryName: string): void => {
    // `\` is a path separator on Windows, so such a name could not be restored safely there.
    if (entryName.includes('\\')) {
      throw new EncryptInputError(`Entry #${nextEntry()} has a name containing "\\", which cannot be restored safely`)
    }
  }
  const root = await lstat(inputPath, { bigint: true }).catch((error: unknown) => {
    throw unreadable(1, error)
  })
  if (root.isSymbolicLink()) {
    throw new EncryptInputError('The input is a symlink; pass the path it points to')
  }
  checkName(name)
  if (root.isFile()) {
    files.push({ rel: name, abs: inputPath, size: Number(root.size), mtimeNs: root.mtimeNs, entry: 1 })
    return { name, isDirectory: false, files, dirs, skippedSymlinks, skippedSpecial }
  }
  const visit = async (abs: string, rel: string): Promise<void> => {
    const entry = nextEntry()
    dirs.push(rel)
    const names = await readdir(abs).catch((error: unknown) => {
      throw unreadable(entry, error)
    })
    for (const entryName of names.sort()) {
      if (!hidden && entryName.startsWith('.')) {
        continue
      }
      checkName(entryName)
      const childAbs = join(abs, entryName)
      const childRel = `${rel}/${entryName}`
      const childEntry = nextEntry()
      const st = await lstat(childAbs, { bigint: true }).catch((error: unknown) => {
        throw unreadable(childEntry, error)
      })
      if (st.isSymbolicLink()) {
        skippedSymlinks.push(childRel)
      } else if (st.isDirectory()) {
        await visit(childAbs, childRel)
      } else if (st.isFile()) {
        files.push({ rel: childRel, abs: childAbs, size: Number(st.size), mtimeNs: st.mtimeNs, entry: childEntry })
      } else {
        skippedSpecial.push(childRel)
      }
    }
  }
  await visit(inputPath, name)
  return { name, isDirectory: true, files, dirs, skippedSymlinks, skippedSpecial }
}

/** Raw-leaf importer that hashes with `crypto.subtle.digest`, so `blockWriteConcurrency` chunks hash at once. */
const parallelHashImporter: BufferImporter = (file, blockstore) =>
  (async function* () {
    for await (const block of file.content) {
      if (!(block instanceof Uint8Array)) {
        throw new Error('chunker yielded a non-buffer block')
      }
      const chunk = block
      yield async () => {
        // The chunker hands out plain Uint8Arrays; WebCrypto's type wants the ArrayBuffer-backed view.
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', chunk as Uint8Array<ArrayBuffer>))
        const cid = CID.createV1(RAW_CODEC, Digest.create(SHA256_CODE, digest))
        await blockstore.put(cid, chunk)
        return { cid, size: BigInt(chunk.length), block: chunk }
      }
    }
  })()

/** A file's bytes for the importer, with read errors reported by position only. */
async function* readEntry(abs: string, entry: number): AsyncGenerator<Uint8Array> {
  try {
    yield* createReadStream(abs, { highWaterMark: 1 << 20 }) as AsyncIterable<Uint8Array>
  } catch (error) {
    throw unreadable(entry, error)
  }
}

export interface CarPayloadPlan {
  walk: InputWalk
  root: CID
  nodes: Map<string, MetadataNode>
  layout: CarLayout
  /** Exact plaintext length, known before any byte is emitted. */
  contentLength: number
}

/**
 * Pass 1: compute the DAG and its byte layout. `maxBytes` fails fast, before any hashing,
 * when the files alone exceed it (the CAR is always larger than its files).
 */
export async function planCarPayload(
  inputPath: string,
  walkOptions: WalkOptions = {},
  maxBytes = Number.POSITIVE_INFINITY
): Promise<CarPayloadPlan> {
  const walk = await walkInput(inputPath, walkOptions)
  const inputBytes = walk.files.reduce((sum, file) => sum + file.size, 0)
  if (inputBytes > maxBytes) {
    throw new EncryptInputError(
      `The input is ${inputBytes} bytes, more than the ${maxBytes} bytes one upload can hold; split it into smaller uploads`
    )
  }
  const nodes = new Map<string, MetadataNode>()
  // The importer's multiformats is a different major than ours; re-decode CIDs at the boundary.
  const blockstore: WritableStorage = {
    async put(cid, bytes) {
      if (!(bytes instanceof Uint8Array)) {
        throw new Error('importer wrote a non-buffer block')
      }
      if (cid.code === DAG_PB_CODEC) {
        const ours = CID.decode(cid.bytes)
        nodes.set(ours.toString(), { cid: ours, bytes })
      }
      return cid
    },
  }
  async function* candidates(): AsyncGenerator<ImportCandidate> {
    for (const dir of walk.dirs) {
      yield { path: dir }
    }
    for (const file of walk.files) {
      yield { path: file.rel, content: readEntry(file.abs, file.entry) }
    }
  }
  const options: ImporterOptions = {
    ...importerOptions,
    wrapWithDirectory: true,
    bufferImporter: parallelHashImporter,
    blockWriteConcurrency: HASH_CONCURRENCY,
  }
  let root: CID | undefined
  for await (const entry of importer(candidates(), blockstore, options)) {
    root = CID.decode(entry.cid.bytes)
  }
  if (root == null) {
    throw new Error('importer produced no root')
  }
  let lay: CarLayout
  try {
    lay = layout(root, nodes)
  } catch {
    // layout's messages name paths; the walk has already rejected every name it could.
    throw new EncryptInputError('The input cannot be packed as an encrypted upload')
  }
  if (lay.total > maxBytes) {
    throw new EncryptInputError(
      `The packed input is ${lay.total} bytes, more than the ${maxBytes} bytes one upload can hold; split it into smaller uploads`
    )
  }
  return { walk, root, nodes, layout: lay, contentLength: lay.total }
}

/** Pass 2: the CAR bytes, in layout order. */
export async function* emitCarPayload(plan: CarPayloadPlan): AsyncGenerator<Uint8Array> {
  const byRel = new Map(plan.walk.files.map((f) => [f.rel, f]))
  yield plan.layout.header
  for (const { cid } of plan.layout.metadata) {
    const node = plan.nodes.get(cid.toString())
    if (node == null) {
      throw new Error(`metadata node ${cid} vanished`)
    }
    yield encodeVarint(cid.bytes.length + node.bytes.length)
    yield cid.bytes
    yield node.bytes
  }
  let current: { abs: string; fd: Awaited<ReturnType<typeof open>> } | undefined
  try {
    for (const leaf of plan.layout.leaves) {
      const target = leaf.targets[0]
      const source = target == null ? undefined : byRel.get(target.path)
      if (target == null || source == null) {
        throw new EncryptInputError('The input cannot be packed as an encrypted upload')
      }
      const { abs, entry } = source
      if (current?.abs !== abs) {
        await current?.fd.close()
        current = undefined
        const fd = await open(abs, 'r').catch((error: unknown) => {
          throw unreadable(entry, error)
        })
        current = { abs, fd }
      }
      const buf = new Uint8Array(leaf.len)
      const { bytesRead } = await current.fd.read(buf, 0, leaf.len, target.fileOffset).catch((error: unknown) => {
        throw unreadable(entry, error)
      })
      if (bytesRead !== leaf.len) {
        throw changed(entry)
      }
      // Size and mtime miss a same-size rewrite with its mtime restored (`touch -r`, `cp -p`).
      // Every leaf comes from parallelHashImporter, so it is sha2-256, never identity.
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buf))
      if (leaf.cid.multihash.code !== SHA256_CODE || !equals(digest, leaf.cid.multihash.digest)) {
        throw changed(entry)
      }
      yield encodeVarint(leaf.cid.bytes.length + leaf.len)
      yield leaf.cid.bytes
      yield buf
    }
  } finally {
    await current?.fd.close()
  }
  for (const file of plan.walk.files) {
    const st = await stat(file.abs, { bigint: true }).catch(() => {
      throw changed(file.entry)
    })
    if (Number(st.size) !== file.size || st.mtimeNs !== file.mtimeNs) {
      throw changed(file.entry)
    }
  }
}
