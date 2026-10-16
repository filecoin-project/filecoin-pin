/**
 * Refuse files whose UnixFS node the installed encoder cannot write correctly.
 *
 * protons-runtime releases up to 8.0.1 mis-encode any uint64 in [2^31, 2^32)
 * (ipfs/protons#212), so a file between 2 GiB and 4 GiB gets a root node Kubo
 * rejects (#773). The workspace carries a patch, but a published install of this
 * package resolves its own copy of the runtime, so the encoder is probed once at
 * load and the guard only bites where the bug is present. Delete this file once
 * the fixed runtime is in the dependency graph.
 */

import { UnixFS } from 'ipfs-unixfs'

const LOW = 2n ** 31n
const HIGH = 2n ** 32n

function probeEncoder(): boolean {
  try {
    const bytes = new UnixFS({ type: 'file', blockSizes: [LOW] }).marshal()
    return UnixFS.unmarshal(bytes).fileSize() === LOW
  } catch {
    return false
  }
}

/** True when the installed `ipfs-unixfs` round-trips a 2^31 file size. */
export const unixfsEncodesUint64 = probeEncoder()

/**
 * Throw when `size` falls in the broken window and the installed encoder has the bug.
 * Under the 1 MiB / 1024-wide profile every subtree of a larger file is exactly 1 GiB,
 * so the file's own size is the only value that can land in the window.
 */
export function assertUnixFsSizeEncodable(
  size: number | bigint,
  label: string,
  encodes: boolean = unixfsEncodesUint64
): void {
  if (encodes) {
    return
  }
  const bytes = BigInt(size)
  if (bytes >= LOW && bytes < HIGH) {
    throw new Error(
      `${label} is ${bytes} bytes; files between 2 GiB and 4 GiB cannot be uploaded until the UnixFS encoder fix is released (filecoin-project/filecoin-pin#773)`
    )
  }
}
