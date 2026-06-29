/**
 * IPIP-499 CID conformance tests for the unixfs-v1-2025 profile.
 *
 * Verifies that `importerOptions` (the @helia/unixfs `AddOptions` filecoin-pin
 * applies on every import) produces byte-identical root CIDs to kubo's
 * cid_profiles fixtures and js-ipfs-unixfs's importer for the same inputs.
 *
 * Expected CIDs and helpers are ported from:
 *  - https://github.com/ipfs/kubo/blob/master/test/cli/cid_profiles_test.go
 *  - https://github.com/ipfs/js-ipfs-unixfs/blob/main/packages/ipfs-unixfs-importer/test/ipip-499-profiles.spec.ts
 *  - https://github.com/ipfs/js-ipfs-unixfs/blob/main/packages/ipfs-unixfs-importer/test/helpers/deterministic.ts
 *
 * The seeded-bytes helpers use node:crypto's `chacha20` cipher (OpenSSL
 * RFC 7539: 32-byte key, 16-byte IV laid out as 4-byte LE counter || 12-byte
 * nonce). Initial counter 0 + nonce of 12 zero bytes matches the upstream Go
 * and js-ipfs-unixfs implementations bit-for-bit.
 */

import { createCipheriv } from 'node:crypto'
import { unixfs } from '@helia/unixfs'
import { BlackHoleBlockstore, MemoryBlockstore } from 'blockstore-core'
import { sha256 } from 'multiformats/hashes/sha2'
import { beforeAll, describe, expect, it } from 'vitest'
import { importerOptions } from '../../core/unixfs/importer-options.js'

async function last<T>(source: AsyncIterable<T>): Promise<T | undefined> {
  let value: T | undefined
  for await (const item of source) {
    value = item
  }
  return value
}

const ALPHABET_EASY = 'abcdefghijklmnopqrstuvwxyz01234567890-_'
const CHACHA20_BLOCK_LEN = 64
const CHUNK = 1_048_576

async function chachaKey(seed: string): Promise<Buffer> {
  const hash = await sha256.digest(new TextEncoder().encode(seed))
  return Buffer.from(hash.digest)
}

function makeIv(counter: number): Buffer {
  // 16-byte IV: 4-byte LE block counter || 12-byte nonce (all-zero nonce).
  const iv = Buffer.alloc(16)
  iv.writeUInt32LE(counter >>> 0, 0)
  return iv
}

async function deterministicRandomBytes(size: number, seed: string): Promise<Uint8Array> {
  const cipher = createCipheriv('chacha20', await chachaKey(seed), makeIv(0))
  const out = Buffer.concat([cipher.update(Buffer.alloc(size)), cipher.final()])
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
}

async function* deterministicRandomStream(size: number, seed: string): AsyncGenerator<Uint8Array> {
  const key = await chachaKey(seed)
  let remaining = size
  let counter = 0
  while (remaining > 0) {
    const n = Math.min(remaining, CHUNK)
    const cipher = createCipheriv('chacha20', key, makeIv(counter))
    const chunk = Buffer.concat([cipher.update(Buffer.alloc(n)), cipher.final()])
    yield new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    counter += Math.ceil(n / CHACHA20_BLOCK_LEN)
    remaining -= n
  }
}

async function deterministicFilenames(
  count: number,
  nameLen: number,
  lastNameLen: number,
  seed: string
): Promise<string[]> {
  // Matches Go's createDeterministicFiles: always derives names from a fixed
  // 1 MiB keystream so output is stable regardless of total name byte count.
  const stream = await deterministicRandomBytes(1_048_576, seed)
  const names: string[] = []
  let offset = 0
  for (let i = 0; i < count; i++) {
    const len = i === count - 1 ? lastNameLen : nameLen
    let name = ''
    for (let j = 0; j < len; j++) {
      // biome-ignore lint/style/noNonNullAssertion: offset+j is in-range by construction
      name += ALPHABET_EASY[stream[offset + j]! % ALPHABET_EASY.length]
    }
    names.push(name)
    offset += len
  }
  return names
}

function newFs() {
  return unixfs({ blockstore: new MemoryBlockstore() })
}

// Discards blocks after CID computation — bounds memory for multi-GiB inputs.
// Safe for single-file imports: ipfs-unixfs-importer builds files bottom-up
// without reading back from the blockstore.
function newStreamingFs() {
  return unixfs({ blockstore: new BlackHoleBlockstore() })
}

describe('IPIP-499 unixfs-v1-2025 conformance', () => {
  it('asserts the profile we ship is unixfs-v1-2025', () => {
    expect(importerOptions.profile).toBe('unixfs-v1-2025')
  })

  it('"hello world" matches the kubo fixture (raw leaf)', async () => {
    const fs = newFs()
    const cid = await fs.addBytes(new TextEncoder().encode('hello world'), importerOptions)
    expect(cid.toString()).toBe('bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e')
  })

  it('empty directory matches the kubo fixture', async () => {
    const fs = newFs()
    const cid = await fs.addDirectory(undefined, importerOptions)
    expect(cid.toString()).toBe('bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354')
  })

  it('file at chunk boundary (1 MiB, chunk-v1-seed)', async () => {
    const fs = newFs()
    const data = await deterministicRandomBytes(1_048_576, 'chunk-v1-seed')
    const cid = await fs.addBytes(data, importerOptions)
    expect(cid.toString()).toBe('bafkreiacndfy443ter6qr2tmbbdhadvxxheowwf75s6zehscklu6ezxmta')
  })

  it('file one byte over chunk boundary (1 MiB + 1, chunk-v1-seed)', async () => {
    const fs = newFs()
    const data = await deterministicRandomBytes(1_048_577, 'chunk-v1-seed')
    const cid = await fs.addBytes(data, importerOptions)
    expect(cid.toString()).toBe('bafybeigmix7t42i6jacydtquhet7srwvgpizfg7gjbq7627d35mjomtu64')
  })

  // 1 GiB streams: exercise the 1024-link DAG-width transition. Uses a
  // discarding blockstore so peak memory stays at one chunk + importer
  // transient state, not the full multi-GiB block set.
  it('file at max-links boundary (1024 x 1 MiB, v1-2025-seed)', async () => {
    const fs = newStreamingFs()
    const size = 1024 * 1_048_576
    const cid = await fs.addByteStream(deterministicRandomStream(size, 'v1-2025-seed'), importerOptions)
    expect(cid.toString()).toBe('bafybeihmf37wcuvtx4hpu7he5zl5qaf2ineo2lqlfrapokkm5zzw7zyhvm')
  }, 180_000)

  it('file one byte over max-links boundary (1024 x 1 MiB + 1, v1-2025-seed)', async () => {
    const fs = newStreamingFs()
    const size = 1024 * 1_048_576 + 1
    const cid = await fs.addByteStream(deterministicRandomStream(size, 'v1-2025-seed'), importerOptions)
    expect(cid.toString()).toBe('bafybeibdsi225ugbkmpbdohnxioyab6jsqrmkts3twhpvfnzp77xtzpyhe')
  }, 180_000)

  describe('HAMT shard threshold (block-bytes estimator)', () => {
    let namesAtThreshold: string[]
    let namesOverThreshold: string[]

    beforeAll(async () => {
      namesAtThreshold = await deterministicFilenames(4766, 11, 21, 'hamt-unixfs-v1-2025')
      namesOverThreshold = await deterministicFilenames(4766, 11, 22, 'hamt-unixfs-v1-2025')
    })

    it('directory at threshold stays a flat directory', async () => {
      const fs = newFs()
      const source = namesAtThreshold.map((name) => ({
        path: `rootDir/${name}`,
        content: new Uint8Array([120]),
      }))
      const result = await last(fs.addAll(source, importerOptions))
      expect(result).toBeDefined()
      expect(result?.cid.toString()).toBe('bafybeic3h7rwruealwxkacabdy45jivq2crwz6bufb5ljwupn36gicplx4')
    })

    it('directory one byte over threshold becomes HAMT sharded', async () => {
      const fs = newFs()
      const source = namesOverThreshold.map((name) => ({
        path: `rootDir/${name}`,
        content: new Uint8Array([120]),
      }))
      const result = await last(fs.addAll(source, importerOptions))
      expect(result).toBeDefined()
      expect(result?.cid.toString()).toBe('bafybeiegvuterwurhdtkikfhbxcldohmxp566vpjdofhzmnhv6o4freidu')
    })
  })
})
