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
 * CIDs, so the size and mtime of every input file are checked before pass 1 and after pass 2.
 */

import { createReadStream } from 'node:fs'
import { lstat, open, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { BufferImporter, ImportCandidate, ImporterOptions, WritableStorage } from 'ipfs-unixfs-importer'
import { importer } from 'ipfs-unixfs-importer'
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

export interface InputFile {
  /** Path inside the wrapper, `basename(input)/...`. */
  rel: string
  abs: string
  size: number
  mtimeNs: bigint
}

export interface InputWalk {
  name: string
  isDirectory: boolean
  files: InputFile[]
  /** Directory paths inside the wrapper, parents first. */
  dirs: string[]
  /** Symlinks found under the input, which are not packed. */
  skippedSymlinks: string[]
}

export interface WalkOptions {
  /** Pack dotfiles and dot-directories; always on for a root that is itself hidden, matching `add`. */
  includeHidden?: boolean
}

/** List the input's files and directories. Symlinks are reported and skipped, never followed. */
export async function walkInput(inputPath: string, { includeHidden = false }: WalkOptions = {}): Promise<InputWalk> {
  const name = basename(inputPath)
  const hidden = includeHidden || name.startsWith('.')
  const root = await lstat(inputPath, { bigint: true })
  if (root.isSymbolicLink()) {
    throw new Error(`${inputPath} is a symlink`)
  }
  const files: InputFile[] = []
  const dirs: string[] = []
  const skippedSymlinks: string[] = []
  if (root.isFile()) {
    files.push({ rel: name, abs: inputPath, size: Number(root.size), mtimeNs: root.mtimeNs })
    return { name, isDirectory: false, files, dirs, skippedSymlinks }
  }
  const visit = async (abs: string, rel: string): Promise<void> => {
    dirs.push(rel)
    for (const entryName of (await readdir(abs)).sort()) {
      if (!hidden && entryName.startsWith('.')) {
        continue
      }
      const childAbs = join(abs, entryName)
      const childRel = `${rel}/${entryName}`
      const st = await lstat(childAbs, { bigint: true })
      if (st.isSymbolicLink()) {
        skippedSymlinks.push(childRel)
      } else if (st.isDirectory()) {
        await visit(childAbs, childRel)
      } else if (st.isFile()) {
        files.push({ rel: childRel, abs: childAbs, size: Number(st.size), mtimeNs: st.mtimeNs })
      }
    }
  }
  await visit(inputPath, name)
  return { name, isDirectory: true, files, dirs, skippedSymlinks }
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

export interface CarPayloadPlan {
  walk: InputWalk
  root: CID
  nodes: Map<string, MetadataNode>
  layout: CarLayout
  /** Exact plaintext length, known before any byte is emitted. */
  contentLength: number
}

/** Pass 1: compute the DAG and its byte layout. */
export async function planCarPayload(inputPath: string, walkOptions: WalkOptions = {}): Promise<CarPayloadPlan> {
  const walk = await walkInput(inputPath, walkOptions)
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
      yield { path: file.rel, content: createReadStream(file.abs, { highWaterMark: 1 << 20 }) }
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
  const lay = layout(root, nodes)
  return { walk, root, nodes, layout: lay, contentLength: lay.total }
}

/** Pass 2: the CAR bytes, in layout order. */
export async function* emitCarPayload(plan: CarPayloadPlan): AsyncGenerator<Uint8Array> {
  const absByRel = new Map(plan.walk.files.map((f) => [f.rel, f.abs]))
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
      const abs = target == null ? undefined : absByRel.get(target.path)
      if (target == null || abs == null) {
        throw new Error(`leaf ${leaf.cid} has no source file`)
      }
      if (current?.abs !== abs) {
        await current?.fd.close()
        current = { abs, fd: await open(abs, 'r') }
      }
      const buf = new Uint8Array(leaf.len)
      const { bytesRead } = await current.fd.read(buf, 0, leaf.len, target.fileOffset)
      if (bytesRead !== leaf.len) {
        throw new Error(`${abs} changed during encryption`)
      }
      yield encodeVarint(leaf.cid.bytes.length + leaf.len)
      yield leaf.cid.bytes
      yield buf
    }
  } finally {
    await current?.fd.close()
  }
  for (const file of plan.walk.files) {
    const st = await stat(file.abs, { bigint: true })
    if (Number(st.size) !== file.size || st.mtimeNs !== file.mtimeNs) {
      throw new Error(`${file.abs} changed during encryption`)
    }
  }
}
