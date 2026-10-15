/**
 * Guards the protons-runtime patch in patches/protons-runtime.patch: a uint64 whose low
 * 32 bits have the top bit set (2^31 <= n < 2^32) must still encode as a valid varint.
 * UnixFS `filesize` and `blocksizes` are uint64, so without the patch every file node
 * between 2 GiB and 4 GiB is malformed and Kubo rejects it (#773).
 */

import { UnixFS } from 'ipfs-unixfs'
import { describe, expect, it } from 'vitest'

describe('UnixFS uint64 encoding', () => {
  it.each([
    2n ** 31n - 1n,
    2n ** 31n,
    3_000_000_000n,
    2n ** 32n - 1n,
    2n ** 32n,
    5n * 2n ** 30n,
  ])('round-trips a file size of %s', (size) => {
    const bytes = new UnixFS({ type: 'file', blockSizes: [size] }).marshal()
    expect(UnixFS.unmarshal(bytes).fileSize()).toBe(size)
  })

  it('encodes 2^31 as the five-byte varint protobuf requires', () => {
    const bytes = new UnixFS({ type: 'file', blockSizes: [2n ** 31n] }).marshal()
    expect(Buffer.from(bytes).toString('hex')).toBe('0802188080808008208080808008')
  })
})
