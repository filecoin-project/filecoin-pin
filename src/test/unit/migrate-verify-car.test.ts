import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { calculate } from '@filoz/synapse-core/piece'
import { CarWriter } from '@ipld/car'
import * as dagCbor from '@ipld/dag-cbor'
import * as dagPb from '@ipld/dag-pb'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'
import { describe, expect, it } from 'vitest'
import { stageMember, verifyCarStream } from '../../migrate/verify-car.js'

// The download stage's whole safety story: every block hash-verified, the
// DAG walked for completeness, and the commitment computed over the exact
// bytes that land on disk. A truncated or corrupt gateway response must
// fail loudly here, never migrate.

async function rawBlock(seed: number, size = 64): Promise<{ cid: CID; bytes: Uint8Array }> {
  const bytes = new Uint8Array(size).map((_, i) => (i * seed) % 251)
  return { cid: CID.createV1(raw.code, await sha256.digest(bytes)), bytes }
}

async function cborBlock(value: unknown): Promise<{ cid: CID; bytes: Uint8Array }> {
  const bytes = dagCbor.encode(value)
  return { cid: CID.createV1(dagCbor.code, await sha256.digest(bytes)), bytes }
}

async function buildCar(root: CID, blocks: Array<{ cid: CID; bytes: Uint8Array }>): Promise<Uint8Array> {
  const { writer, out } = CarWriter.create([root])
  const chunks: Uint8Array[] = []
  const drained = (async () => {
    for await (const chunk of out) chunks.push(chunk)
  })()
  for (const block of blocks) await writer.put(block)
  await writer.close()
  await drained
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const outBytes = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    outBytes.set(c, offset)
    offset += c.length
  }
  return outBytes
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  const from = (ReadableStream as unknown as { from(it: Iterable<Uint8Array>): ReadableStream<Uint8Array> }).from
  return from([bytes])
}

function memorySink() {
  const chunks: Uint8Array[] = []
  return {
    sink: {
      async write(chunk: Uint8Array) {
        chunks.push(chunk.slice())
      },
      async end() {
        // in-memory sink; nothing to flush
      },
    },
    bytes: () => {
      const total = chunks.reduce((sum, c) => sum + c.length, 0)
      const out = new Uint8Array(total)
      let offset = 0
      for (const c of chunks) {
        out.set(c, offset)
        offset += c.length
      }
      return out
    },
  }
}

/** A two-block DAG: a dag-cbor root linking one raw leaf. */
async function linkedDag() {
  const leaf = await rawBlock(7, 128)
  const root = await cborBlock({ child: leaf.cid })
  return { root, leaf }
}

describe('verifyCarStream', () => {
  it('accepts a complete CAR and computes the same commitment as the SDK', async () => {
    const { root, leaf } = await linkedDag()
    const car = await buildCar(root.cid, [root, leaf])
    const { sink, bytes } = memorySink()

    const verified = await verifyCarStream(streamOf(car), sink)

    expect(verified.rawSize).toBe(car.length)
    expect(verified.blockCount).toBe(2)
    expect(bytes()).toEqual(car)
    expect(verified.pieceCid).toBe((await calculate(car)).toString())
  })

  it('rejects a CAR missing a reachable block (truncated response)', async () => {
    const { root, leaf } = await linkedDag()
    // The root parses cleanly, declares its link, and the leaf never arrives:
    // the shape of a response that ended early at a block boundary.
    const truncated = await buildCar(root.cid, [root])
    void leaf
    const { sink } = memorySink()

    await expect(verifyCarStream(streamOf(truncated), sink)).rejects.toThrow(/incomplete/)
  })

  it('rejects a block whose bytes do not match its CID', async () => {
    const leaf = await rawBlock(7, 128)
    const corrupted = leaf.bytes.slice()
    corrupted[0] = (corrupted[0] ?? 0) ^ 0xff
    const car = await buildCar(leaf.cid, [{ cid: leaf.cid, bytes: corrupted }])
    const { sink } = memorySink()

    await expect(verifyCarStream(streamOf(car), sink)).rejects.toThrow(/does not match its multihash/)
  })

  it('aborts when the byte callback throws (the staging-budget cutoff)', async () => {
    const leaf = await rawBlock(7, 128)
    const car = await buildCar(leaf.cid, [leaf])
    const { sink } = memorySink()

    await expect(
      verifyCarStream(streamOf(car), sink, {
        onBytes: () => {
          throw new Error('budget exhausted')
        },
      })
    ).rejects.toThrow(/budget exhausted/)
  })
})

describe('stageMember', () => {
  it('lands a verified member atomically and reports its commitment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fp-stage-'))
    try {
      const { root, leaf } = await linkedDag()
      const car = await buildCar(root.cid, [root, leaf])
      const cid = root.cid.toString()

      const staged = await stageMember(cid, ['fake://gw'], dir, {}, async (gateway, requested) => ({
        url: `${gateway}/ipfs/${requested}`,
        body: streamOf(car),
      }))

      expect(staged.memberCarPath).toBe(join(dir, `${cid}.car`))
      expect(await readFile(staged.memberCarPath)).toEqual(Buffer.from(car))
      expect(staged.rawSize).toBe(car.length)
      expect(staged.pieceCid).toBe((await calculate(car)).toString())
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects a CAR whose requested root is incomplete even when another declared root is complete', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fp-stage-decoy-'))
    try {
      // Decoy: a complete single-block DAG declared as the first root. The
      // requested DAG's root block is present but its leaf is not.
      const decoy = await rawBlock(11, 64)
      const { root: requestedRoot } = await linkedDag()
      const requested = requestedRoot.cid.toString()
      const { writer, out } = CarWriter.create([decoy.cid, requestedRoot.cid])
      const chunks: Uint8Array[] = []
      const drained = (async () => {
        for await (const chunk of out) chunks.push(chunk)
      })()
      await writer.put(decoy)
      await writer.put(requestedRoot)
      await writer.close()
      await drained
      const total = chunks.reduce((sum, c) => sum + c.length, 0)
      const car = new Uint8Array(total)
      let offset = 0
      for (const c of chunks) {
        car.set(c, offset)
        offset += c.length
      }

      await expect(
        stageMember(requested, ['fake://gw'], dir, {}, async () => ({ url: 'fake://gw/x', body: streamOf(car) }))
      ).rejects.toThrow(/incomplete/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects a CAR whose root is not the requested CID and leaves no file behind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fp-stage-root-'))
    try {
      const { root, leaf } = await linkedDag()
      const car = await buildCar(root.cid, [root, leaf])
      const other = (await rawBlock(3)).cid.toString()

      await expect(
        stageMember(other, ['fake://gw'], dir, {}, async () => ({ url: 'fake://gw/x', body: streamOf(car) }))
      ).rejects.toThrow(/all gateways failed/)
      await expect(readFile(join(dir, `${other}.car`))).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects a truncated DAG whose root block is relabeled with a linkless codec', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fp-stage-relabel-'))
    try {
      // Attack shape: the dag-cbor root's bytes served under a `raw` CID with
      // the same multihash, children omitted. Raw has no links, so a
      // multihash-only completeness walk would accept the truncated DAG.
      const { root } = await linkedDag()
      const relabeled = { cid: CID.createV1(raw.code, root.cid.multihash), bytes: root.bytes }
      const car = await buildCar(root.cid, [relabeled])

      await expect(
        stageMember(root.cid.toString(), ['fake://gw'], dir, {}, async () => ({
          url: 'fake://gw/x',
          body: streamOf(car),
        }))
      ).rejects.toThrow(/codec/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('accepts the equivalent CIDv1 root for a CIDv0 request', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fp-stage-v0v1-'))
    try {
      const data = dagPb.encode({ Links: [] })
      const digest = await sha256.digest(data)
      const v0 = CID.createV0(digest)
      const v1 = CID.createV1(dagPb.code, digest)
      const car = await buildCar(v1, [{ cid: v1, bytes: data }])

      const staged = await stageMember(v0.toString(), ['fake://gw'], dir, {}, async () => ({
        url: 'fake://gw/x',
        body: streamOf(car),
      }))
      expect(staged.cid).toBe(v0.toString())
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
