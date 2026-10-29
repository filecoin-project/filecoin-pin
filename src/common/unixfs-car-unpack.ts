/**
 * Write the entry of a metadata-first UnixFS CAR into a directory in a single streaming pass.
 *
 * The dag-pb nodes arrive first, so the whole tree (names, sizes, which leaf goes where) is
 * known before the first data byte; every leaf is then written to each file position that
 * references it as it streams past. Memory is bounded by the metadata plus one leaf.
 *
 * The wrapper holds exactly one entry (the uploaded file or folder). Its name is claimed in
 * `outDir` with {@link claimEntry} before any content is written, so an existing entry is
 * never touched and a clash gets a numbered name; everything else in `outDir` is left alone.
 *
 * Output is owner-only (directories 0700, files 0600, exclusive create). Names that could
 * escape the output directory are rejected by `layout` before anything is written, and
 * every path is checked to resolve inside `outDir` before it is created or opened.
 */

import { mkdir, open } from 'node:fs/promises'
import { basename, dirname, resolve, sep } from 'node:path'
import { CarBlockIterator } from '@ipld/car'
import { claimEntry } from './claim-output.js'
import {
  type CarLayout,
  DAG_PB_CODEC,
  type LeafPlacement,
  layout,
  type MetadataNode,
  RAW_CODEC,
} from './unixfs-car-layout.js'

/** Leaf digests checked at once; the envelope already authenticates every byte, this catches a malformed CAR. */
const VERIFY_CONCURRENCY = 8
const MAX_OPEN_FILES = 64

export interface UnpackResult {
  files: number
  dirs: number
  bytes: number
  /** The claimed entry: `outDir/<name>`, or a numbered variant when the name was taken. */
  path: string
}

type FileHandle = Awaited<ReturnType<typeof open>>

/** `outDir/path`, refusing any path that resolves outside `outDir`. */
export function insideDir(outDir: string, path: string): string {
  const base = resolve(outDir)
  const target = resolve(base, path)
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`entry ${JSON.stringify(path)} would be written outside the output directory`)
  }
  return target
}

/**
 * `onClaim` is called synchronously with the claimed path, before anything is written into it,
 * so a signal handler can remove it.
 */
export async function unpackCar(
  source: ReadableStream<Uint8Array>,
  outDir: string,
  onClaim?: (path: string) => void
): Promise<UnpackResult> {
  const blocks = await CarBlockIterator.fromIterable(source)
  const roots = await blocks.getRoots()
  const root = roots[0]
  if (root == null || roots.length !== 1) {
    throw new Error(`expected exactly one root, got ${roots.length}`)
  }

  const nodes = new Map<string, MetadataNode>()
  let lay: CarLayout | undefined
  let expected: LeafPlacement[] = []
  let next = 0
  const result: UnpackResult = { files: 0, dirs: 0, bytes: 0, path: '' }
  // Maps a wrapper-relative path onto the claimed entry; set once the entry is claimed.
  let top = ''
  let claimed = ''
  const target = (path: string): string => insideDir(outDir, claimed + path.slice(top.length))

  // ponytail: bounded open-file cache, oldest closed first; leaves arrive grouped per file so churn is low
  const handles = new Map<string, FileHandle>()
  const handleFor = async (path: string): Promise<FileHandle> => {
    const cached = handles.get(path)
    if (cached != null) {
      return cached
    }
    if (handles.size >= MAX_OPEN_FILES) {
      const oldest = handles.entries().next().value
      if (oldest != null) {
        await oldest[1].close()
        handles.delete(oldest[0])
      }
    }
    const handle = await open(target(path), 'r+')
    handles.set(path, handle)
    return handle
  }

  // Checks never reject: the first failure is recorded here and thrown by the loop, so no
  // rejection goes unhandled even when the loop stops early on another error.
  const pending = new Set<Promise<void>>()
  let corrupt: Error | undefined
  const throwIfCorrupt = (): void => {
    if (corrupt != null) {
      throw corrupt
    }
  }
  const verify = (leaf: LeafPlacement, bytes: Uint8Array): void => {
    const check: Promise<void> = crypto.subtle
      .digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
      .then(
        (digest) => {
          if (Buffer.compare(Buffer.from(digest), Buffer.from(leaf.cid.multihash.digest)) !== 0) {
            corrupt ??= new Error(`block ${leaf.cid} does not match its CID`)
          }
        },
        (error: unknown) => {
          corrupt ??= error instanceof Error ? error : new Error(String(error))
        }
      )
      .then(() => {
        pending.delete(check)
      })
    pending.add(check)
  }

  // Called once the first raw leaf arrives: the tree is complete, claim the entry and create
  // every directory and file under it.
  const startData = async (): Promise<void> => {
    const tree = layout(root, nodes)
    const entries = new Set([...tree.dirs, ...tree.files].map((path) => path.split('/')[0]))
    const [only] = entries
    if (entries.size !== 1 || only == null) {
      throw new Error(`expected exactly one entry in the wrapper, got ${entries.size}`)
    }
    top = only
    const kind = tree.files.has(top) ? 'file' : 'folder'
    // Check containment before the claim creates anything.
    insideDir(outDir, top)
    result.path = claimEntry(outDir, top, kind)
    claimed = basename(result.path)
    onClaim?.(result.path)
    lay = tree
    for (const dir of lay.dirs) {
      await mkdir(target(dir), { recursive: true, mode: 0o700 })
    }
    for (const path of lay.files) {
      if (path === top) {
        // The claim created it.
        continue
      }
      const file = target(path)
      await mkdir(dirname(file), { recursive: true, mode: 0o700 })
      await (await open(file, 'wx', 0o600)).close()
    }
    result.files = lay.files.size
    result.dirs = lay.dirs.length
    expected = lay.leaves
  }

  try {
    for await (const { cid, bytes } of blocks) {
      if (cid.code === DAG_PB_CODEC) {
        if (lay != null) {
          throw new Error('dag-pb block after data began: the CAR is not metadata-first')
        }
        nodes.set(cid.toString(), { cid, bytes })
        continue
      }
      if (cid.code !== RAW_CODEC) {
        throw new Error(`unexpected codec 0x${cid.code.toString(16)} in payload`)
      }
      if (lay == null) {
        await startData()
      }
      const leaf = expected[next]
      next++
      if (leaf == null || !leaf.cid.equals(cid)) {
        throw new Error(`leaf out of order: got ${cid}, expected ${leaf?.cid.toString() ?? 'end of data'}`)
      }
      if (bytes.length !== leaf.len) {
        throw new Error(`leaf ${cid} is ${bytes.length} bytes, expected ${leaf.len}`)
      }
      throwIfCorrupt()
      verify(leaf, bytes)
      if (pending.size >= VERIFY_CONCURRENCY) {
        await Promise.race(pending)
        throwIfCorrupt()
      }
      for (const target of leaf.targets) {
        const handle = await handleFor(target.path)
        await handle.write(bytes, 0, bytes.length, target.fileOffset)
      }
      result.bytes += bytes.length
    }
    if (lay == null) {
      // Only directories and empty files: no leaf ever arrived.
      await startData()
    }
    if (next !== expected.length) {
      throw new Error(`truncated payload: ${next} of ${expected.length} blocks`)
    }
    await Promise.all(pending)
    throwIfCorrupt()
  } finally {
    // Let in-flight checks settle before the caller removes the output directory.
    await Promise.all(pending)
    for (const handle of handles.values()) {
      await handle.close()
    }
  }
  return result
}
