/**
 * Byte layout of the metadata-first UnixFS CAR that `add --encrypt` wraps in the envelope.
 *
 * A CARv1 has no index, so a reader that holds only the root cannot locate a file's
 * bytes until it has seen every dag-pb node. The profile therefore orders blocks as:
 *
 *   header, every dag-pb node (breadth-first from the root, each CID once),
 *   then every raw leaf in file order (each CID once, first occurrence)
 *
 * Given the root and the dag-pb nodes, `layout` computes where every block sits, which
 * is what lets a decryptor stream in one pass with memory bounded by the metadata, and
 * lets a viewer map `(file, offset)` to a byte range with no further reads.
 *
 * Pure code: no Node imports, so a browser viewer can reuse it.
 */

import { encode as cborEncode } from '@ipld/dag-cbor'
import * as dagPb from '@ipld/dag-pb'
import { UnixFS } from 'ipfs-unixfs'
import { varint } from 'multiformats'
import type { CID } from 'multiformats/cid'

export const RAW_CODEC = 0x55
export const DAG_PB_CODEC = 0x70

/** Public `content_type` of the envelope; decryptors reject anything else. */
export const CAR_CONTENT_TYPE = 'application/vnd.ipld.car'

export interface MetadataNode {
  cid: CID
  bytes: Uint8Array
}

/** One place a leaf's bytes belong in the unpacked tree. */
export interface LeafTarget {
  path: string
  fileOffset: number
}

export interface LeafPlacement {
  cid: CID
  len: number
  /** Byte offset of the section (varint prefix) inside the CAR. */
  offset: number
  /** Byte offset of the block bytes inside the CAR. */
  dataOffset: number
  /** Every file position holding these bytes; more than one when the input repeats a chunk. */
  targets: LeafTarget[]
}

export interface CarLayout {
  header: Uint8Array
  metadata: { cid: CID; offset: number; len: number }[]
  leaves: LeafPlacement[]
  /** Wrapper-relative file paths, in tree order. */
  files: Set<string>
  /** Wrapper-relative directory paths, in tree order. */
  dirs: string[]
  /** Total CAR length in bytes. */
  total: number
}

export function encodeVarint(n: number): Uint8Array {
  return varint.encodeTo(n, new Uint8Array(varint.encodingLength(n)))
}

export function sectionLength(cid: CID, dataLen: number): number {
  const body = cid.bytes.length + dataLen
  return varint.encodingLength(body) + body
}

export function carHeader(root: CID): Uint8Array {
  const header = cborEncode({ roots: [root], version: 1 })
  const prefix = encodeVarint(header.length)
  const out = new Uint8Array(prefix.length + header.length)
  out.set(prefix)
  out.set(header, prefix.length)
  return out
}

interface DecodedNode {
  links: dagPb.PBLink[]
  unixfs: UnixFS | undefined
}

/** Characters Windows refuses in a file name: `<>:"|?*` and the control characters. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const WINDOWS_FORBIDDEN = /[<>:"|?*\x00-\x1f]/
/** Device names Windows reserves in any directory, with or without an extension. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/**
 * A link name that could escape or alias a path when the tree is written to disk.
 * `\` is a separator on Windows, so `..\x` would escape there. On Windows also the names it
 * cannot create or silently changes: forbidden characters, a trailing dot or space, and
 * reserved device names (`CON`, `nul.txt`, ...). Elsewhere those are ordinary names and kept.
 */
export function isUnsafeName(name: string, platform: NodeJS.Platform = process.platform): boolean {
  if (
    name === '' ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  ) {
    return true
  }
  return platform === 'win32' && (WINDOWS_FORBIDDEN.test(name) || /[. ]$/.test(name) || WINDOWS_RESERVED.test(name))
}

/**
 * Compute the block order and byte offsets from the root and the dag-pb nodes alone.
 * Throws when a referenced dag-pb node is missing (the CAR is not metadata-first or is
 * truncated), when a node is not UnixFS, or when a name is unsafe to write to disk.
 */
export function layout(root: CID, nodes: Map<string, MetadataNode>): CarLayout {
  const decoded = new Map<string, DecodedNode>()
  const node = (cid: CID): DecodedNode => {
    const key = cid.toString()
    const cached = decoded.get(key)
    if (cached != null) {
      return cached
    }
    const raw = nodes.get(key)
    if (raw == null) {
      throw new Error(`metadata incomplete: missing dag-pb node ${key}`)
    }
    const pb = dagPb.decode(raw.bytes)
    const value = { links: pb.Links, unixfs: pb.Data == null ? undefined : UnixFS.unmarshal(pb.Data) }
    decoded.set(key, value)
    return value
  }

  const header = carHeader(root)
  let pos = header.length
  const metadata: CarLayout['metadata'] = []
  const seen = new Set<string>()
  const queue = [root]
  while (queue.length > 0) {
    const cid = queue.shift()
    if (cid == null) {
      break
    }
    const key = cid.toString()
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    const raw = nodes.get(key)
    if (raw == null) {
      throw new Error(`metadata incomplete: missing dag-pb node ${key}`)
    }
    const len = sectionLength(cid, raw.bytes.length)
    metadata.push({ cid, offset: pos, len })
    pos += len
    for (const link of node(cid).links) {
      if (link.Hash.code === DAG_PB_CODEC) {
        queue.push(link.Hash)
      }
    }
  }

  const leaves: LeafPlacement[] = []
  const leafByCid = new Map<string, LeafPlacement>()
  const files = new Set<string>()
  const dirs: string[] = []
  const dirSet = new Set<string>()

  const leaf = (cid: CID, size: number, path: string, fileOffset: number): void => {
    const key = cid.toString()
    let placement = leafByCid.get(key)
    if (placement == null) {
      placement = { cid, len: size, offset: 0, dataOffset: 0, targets: [] }
      leafByCid.set(key, placement)
      leaves.push(placement)
    } else if (placement.len !== size) {
      throw new Error(`leaf ${key} is referenced with two sizes`)
    }
    placement.targets.push({ path, fileOffset })
  }

  // Returns the subtree's byte length so the caller can advance the file offset.
  const fileTree = (cid: CID, size: number, path: string, fileOffset: number): number => {
    if (cid.code === RAW_CODEC) {
      leaf(cid, size, path, fileOffset)
      return size
    }
    const { links, unixfs } = node(cid)
    if (unixfs == null || (unixfs.type !== 'file' && unixfs.type !== 'raw')) {
      throw new Error(`expected a file node at ${path}, got ${unixfs?.type ?? 'no UnixFS data'}`)
    }
    if (unixfs.data != null && unixfs.data.length > 0) {
      throw new Error(`inline file data is not part of the profile (${path})`)
    }
    let offset = fileOffset
    links.forEach((link, i) => {
      offset += fileTree(link.Hash, Number(unixfs.blockSizes[i] ?? link.Tsize ?? 0), path, offset)
    })
    return offset - fileOffset
  }

  const entry = (cid: CID, tsize: number, path: string): void => {
    if (files.has(path) || dirSet.has(path)) {
      throw new Error(`duplicate path ${path}`)
    }
    if (cid.code === RAW_CODEC) {
      files.add(path)
      leaf(cid, tsize, path, 0)
      return
    }
    const { unixfs } = node(cid)
    if (unixfs?.type === 'file' || unixfs?.type === 'raw') {
      const size = Number(unixfs.fileSize())
      files.add(path)
      const got = fileTree(cid, size, path, 0)
      if (got !== size) {
        throw new Error(`file size mismatch at ${path}: ${got} vs ${size}`)
      }
      return
    }
    if (unixfs?.type === 'symlink') {
      throw new Error(`symlink entries are not part of the profile (${path})`)
    }
    dir(cid, path)
  }

  // HAMT shards nest: a link named with only the 2-char bucket prefix is a sub-shard of the same directory.
  const shard = (cid: CID, path: string): void => {
    for (const link of node(cid).links) {
      const name = (link.Name ?? '').slice(2)
      if (name === '') {
        shard(link.Hash, path)
      } else {
        if (isUnsafeName(name)) {
          throw new Error(`unsafe entry name ${JSON.stringify(name)} in ${path === '' ? '<root>' : path}`)
        }
        entry(link.Hash, Number(link.Tsize ?? 0), path === '' ? name : `${path}/${name}`)
      }
    }
  }

  const dir = (cid: CID, path: string): void => {
    const { links, unixfs } = node(cid)
    if (unixfs == null) {
      throw new Error('dag-pb node without UnixFS data')
    }
    if (unixfs.type === 'hamt-sharded-directory') {
      if (path !== '') {
        dirs.push(path)
        dirSet.add(path)
      }
      shard(cid, path)
      return
    }
    if (unixfs.type !== 'directory') {
      throw new Error(`unexpected UnixFS type ${unixfs.type} at ${path === '' ? '<root>' : path}`)
    }
    if (path !== '') {
      dirs.push(path)
      dirSet.add(path)
    }
    for (const link of links) {
      const name = link.Name ?? ''
      if (isUnsafeName(name)) {
        throw new Error(`unsafe entry name ${JSON.stringify(name)} in ${path === '' ? '<root>' : path}`)
      }
      entry(link.Hash, Number(link.Tsize ?? 0), path === '' ? name : `${path}/${name}`)
    }
  }

  // The root is the anonymous wrapper directory.
  dir(root, '')

  for (const placement of leaves) {
    placement.offset = pos
    placement.dataOffset =
      pos + encodeVarint(placement.cid.bytes.length + placement.len).length + placement.cid.bytes.length
    pos += sectionLength(placement.cid, placement.len)
  }

  return { header, metadata, leaves, files, dirs, total: pos }
}
