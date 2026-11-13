import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { calculate } from '@filoz/synapse-core/piece'
import { CarWriter } from '@ipld/car'
import * as dagCbor from '@ipld/dag-cbor'
import * as dagPb from '@ipld/dag-pb'
import toBuffer from 'it-to-buffer'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import * as Digest from 'multiformats/hashes/digest'
import { identity } from 'multiformats/hashes/identity'
import { sha256 } from 'multiformats/hashes/sha2'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StagingError } from '../../migrate/gateway.js'
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

async function buildCar(roots: CID[], blocks: Array<{ cid: CID; bytes: Uint8Array }>): Promise<Uint8Array> {
  const { writer, out } = CarWriter.create(roots)
  const bytes = toBuffer(out)
  for (const block of blocks) await writer.put(block)
  await writer.close()
  return bytes
}

/** Small fixed chunks, one per event-loop turn, so framing crosses chunk boundaries like a socket. */
function streamOf(bytes: Uint8Array, chunkSize = 7): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream({
    async pull(controller) {
      await new Promise((resolve) => setImmediate(resolve))
      if (offset >= bytes.length) return controller.close()
      controller.enqueue(bytes.subarray(offset, offset + chunkSize))
      offset += chunkSize
    },
  })
}

/** A stream whose first read fails like a reset socket. */
function brokenStream(err: Error): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull(controller) {
      controller.error(err)
    },
  })
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
    bytes: () => toBuffer(chunks),
  }
}

/** A two-block DAG: a dag-cbor root linking one raw leaf. */
async function linkedDag() {
  const leaf = await rawBlock(7, 128)
  const root = await cborBlock({ child: leaf.cid })
  return { root, leaf }
}

const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

describe('verifyCarStream', () => {
  it('accepts a complete CAR and computes the same commitment as the SDK', async () => {
    const { root, leaf } = await linkedDag()
    const car = await buildCar([root.cid], [root, leaf])
    const { sink, bytes } = memorySink()
    let seen = 0

    const verified = await verifyCarStream(streamOf(car), root.cid, sink, { onBytes: (n) => (seen += n) })

    expect(verified.rawSize).toBe(car.length)
    expect(seen).toBe(car.length)
    expect(verified.blockCount).toBe(2)
    expect(bytes()).toEqual(car)
    expect(verified.pieceCid).toBe((await calculate(car)).toString())
    expect(verified.sha256).toBe(sha256Hex(car))
  })

  it('rejects a CAR missing a reachable block (truncated at a block boundary)', async () => {
    const { root } = await linkedDag()
    const truncated = await buildCar([root.cid], [root])

    await expect(verifyCarStream(streamOf(truncated), root.cid, memorySink().sink)).rejects.toMatchObject({
      name: 'StagingError',
      category: 'car_incomplete',
    })
  })

  it('rejects a CAR truncated inside a block', async () => {
    const { root, leaf } = await linkedDag()
    const car = await buildCar([root.cid], [root, leaf])

    await expect(
      verifyCarStream(streamOf(car.subarray(0, car.length - 5)), root.cid, memorySink().sink)
    ).rejects.toMatchObject({ name: 'StagingError', category: 'car_incomplete' })
  })

  it('rejects a block whose bytes do not match its CID', async () => {
    const leaf = await rawBlock(7, 128)
    const corrupted = leaf.bytes.slice()
    corrupted[0] = (corrupted[0] ?? 0) ^ 0xff
    const car = await buildCar([leaf.cid], [{ cid: leaf.cid, bytes: corrupted }])

    await expect(verifyCarStream(streamOf(car), leaf.cid, memorySink().sink)).rejects.toMatchObject({
      name: 'StagingError',
      category: 'car_block_mismatch',
    })
  })

  it('rejects a CAR that does not declare the requested root', async () => {
    const { root, leaf } = await linkedDag()
    const car = await buildCar([root.cid], [root, leaf])

    await expect(verifyCarStream(streamOf(car), leaf.cid, memorySink().sink)).rejects.toMatchObject({
      name: 'StagingError',
      category: 'car_root_mismatch',
    })
  })

  it('rejects a CAR that declares no roots', async () => {
    const leaf = await rawBlock(7)
    const car = await buildCar([], [leaf])

    await expect(verifyCarStream(streamOf(car), leaf.cid, memorySink().sink)).rejects.toMatchObject({
      category: 'car_root_mismatch',
    })
  })

  it('walks the links of an identity-CID block that is not in the CAR', async () => {
    const leaf = await rawBlock(5)
    const inlineBytes = dagCbor.encode({ child: leaf.cid })
    const inline = CID.createV1(dagCbor.code, identity.digest(inlineBytes))
    const root = await cborBlock({ via: inline })

    const complete = await buildCar([root.cid], [root, leaf])
    await expect(verifyCarStream(streamOf(complete), root.cid, memorySink().sink)).resolves.toMatchObject({
      blockCount: 2,
    })

    const missingLeaf = await buildCar([root.cid], [root])
    await expect(verifyCarStream(streamOf(missingLeaf), root.cid, memorySink().sink)).rejects.toMatchObject({
      category: 'car_incomplete',
    })
  })

  it('walks a multihash reached under two codecs separately', async () => {
    // The same bytes linked as raw and as dag-cbor. Popping the raw link
    // first must not mark the dag-cbor view visited, or its children are
    // never checked and a truncated CAR passes.
    const leaf = await rawBlock(9)
    const midBytes = dagCbor.encode({ child: leaf.cid })
    const midDigest = await sha256.digest(midBytes)
    const midCbor = CID.createV1(dagCbor.code, midDigest)
    const midRaw = CID.createV1(raw.code, midDigest)
    // dfs pops the last link first: `a` (dag-cbor) is pushed first, `z` (raw) popped first.
    const root = await cborBlock({ a: midCbor, z: midRaw })
    const car = await buildCar([root.cid], [root, { cid: midCbor, bytes: midBytes }, { cid: midRaw, bytes: midBytes }])

    await expect(verifyCarStream(streamOf(car), root.cid, memorySink().sink)).rejects.toMatchObject({
      category: 'car_incomplete',
    })
  })

  it('rejects a CARv2 response', async () => {
    const leaf = await rawBlock(7)
    const v1 = await buildCar([leaf.cid], [leaf])
    // CARv2 pragma + header (no index) wrapping the v1 payload.
    const pragma = new Uint8Array([0x0a, 0xa1, 0x67, 0x76, 0x65, 0x72, 0x73, 0x69, 0x6f, 0x6e, 0x02])
    const header = new Uint8Array(40)
    const view = new DataView(header.buffer)
    view.setBigUint64(16, BigInt(pragma.length + 40), true) // dataOffset
    view.setBigUint64(24, BigInt(v1.length), true) // dataSize
    const car = toBuffer([pragma, header, v1])

    await expect(verifyCarStream(streamOf(car), leaf.cid, memorySink().sink)).rejects.toMatchObject({
      name: 'StagingError',
      message: expect.stringMatching(/CARv2/),
    })
  })

  it('treats a verified block that does not decode as unsupported, not as a gateway fault', async () => {
    const bytes = new Uint8Array([0xff, 0xff, 0xff]) // not CBOR
    const cid = CID.createV1(dagCbor.code, await sha256.digest(bytes))
    const car = await buildCar([cid], [{ cid, bytes }])

    await expect(verifyCarStream(streamOf(car), cid, memorySink().sink)).rejects.toMatchObject({
      category: 'unsupported_block',
    })

    const inline = CID.createV1(dagCbor.code, identity.digest(bytes))
    const root = await cborBlock({ via: inline })
    const rootCar = await buildCar([root.cid], [root])
    await expect(verifyCarStream(streamOf(rootCar), root.cid, memorySink().sink)).rejects.toMatchObject({
      category: 'unsupported_block',
    })
  })

  it('refuses blocks it cannot verify or decode as unsupported', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const digest = await sha256.digest(bytes)
    const unknownCodec = CID.createV1(0x300000, digest)
    const unknownHash = CID.createV1(raw.code, Digest.create(0x1e, digest.digest))

    for (const cid of [unknownCodec, unknownHash]) {
      const car = await buildCar([cid], [{ cid, bytes }])
      await expect(verifyCarStream(streamOf(car), cid, memorySink().sink)).rejects.toMatchObject({
        category: 'unsupported_block',
      })
    }
  })

  it('aborts when the byte callback throws (the staging-budget cutoff)', async () => {
    const leaf = await rawBlock(7, 128)
    const car = await buildCar([leaf.cid], [leaf])
    const cutoff = new StagingError('budget exhausted', 'staging_budget')

    const err = await verifyCarStream(streamOf(car), leaf.cid, memorySink().sink, {
      onBytes: () => {
        throw cutoff
      },
    }).catch((e: unknown) => e)

    expect(err).toBe(cutoff)
  })

  it('categorizes a stream that fails mid-body as a gateway network failure', async () => {
    const leaf = await rawBlock(7)
    const body = brokenStream(Object.assign(new TypeError('terminated'), { code: 'ECONNRESET' }))

    await expect(verifyCarStream(body, leaf.cid, memorySink().sink)).rejects.toMatchObject({
      name: 'StagingError',
      category: 'source_gateway_network',
    })
  })

  it('releases the body on every failure path', async () => {
    const { root, leaf } = await linkedDag()
    const cases = [
      { car: await buildCar([root.cid], [root]), root: root.cid }, // incomplete
      { car: await buildCar([root.cid], [root, leaf]), root: leaf.cid }, // root mismatch
    ]
    for (const { car, root: requested } of cases) {
      const body = streamOf(car)
      await expect(verifyCarStream(body, requested, memorySink().sink)).rejects.toThrow()
      expect(body.locked).toBe(false)
    }
  })
})

describe('stageMember', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fp-stage-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const serve = (car: Uint8Array) => async (gateway: string, requested: string) => ({
    url: `${gateway}/ipfs/${requested}`,
    body: streamOf(car),
  })

  it('lands a verified member atomically and reports its commitment', async () => {
    const { root, leaf } = await linkedDag()
    const car = await buildCar([root.cid], [root, leaf])
    const cid = root.cid.toString()

    const staged = await stageMember(cid, ['fake://gw'], dir, {}, serve(car))

    expect(staged).toMatchObject({
      cid,
      gateway: 'fake://gw',
      url: `fake://gw/ipfs/${cid}`,
      memberCarPath: join(dir, `${cid}.car`),
      memberSha256: sha256Hex(car),
      rawSize: car.length,
      pieceCid: (await calculate(car)).toString(),
    })
    expect(await readFile(staged.memberCarPath)).toEqual(Buffer.from(car))
    expect(await readdir(dir)).toEqual([`${cid}.car`])
  })

  it('rejects a CAR whose requested root is incomplete even when another declared root is complete', async () => {
    // Decoy: a complete single-block DAG declared as the first root. The
    // requested DAG's root block is present but its leaf is not.
    const decoy = await rawBlock(11, 64)
    const { root } = await linkedDag()
    const car = await buildCar([decoy.cid, root.cid], [decoy, root])

    await expect(stageMember(root.cid.toString(), ['fake://gw'], dir, {}, serve(car))).rejects.toMatchObject({
      category: 'car_incomplete',
    })
  })

  it('rejects a CAR whose root is not the requested CID and leaves no file behind', async () => {
    const { root, leaf } = await linkedDag()
    const car = await buildCar([root.cid], [root, leaf])
    const other = (await rawBlock(3)).cid.toString()
    const body = streamOf(car)

    await expect(
      stageMember(other, ['fake://gw'], dir, {}, async () => ({ url: 'fake://gw/x', body }))
    ).rejects.toMatchObject({ category: 'car_root_mismatch', message: expect.stringMatching(/all gateways failed/) })
    expect(await readdir(dir)).toEqual([])
    expect(body.locked).toBe(false)
  })

  it('rejects a truncated DAG whose root block is relabeled with a linkless codec', async () => {
    // Attack shape: the dag-cbor root's bytes served under a `raw` CID with
    // the same multihash, children omitted. Raw has no links, so a
    // multihash-only completeness walk would accept the truncated DAG; keyed
    // by codec, the dag-cbor root is simply missing.
    const { root } = await linkedDag()
    const relabeled = { cid: CID.createV1(raw.code, root.cid.multihash), bytes: root.bytes }
    const car = await buildCar([root.cid], [relabeled])

    await expect(stageMember(root.cid.toString(), ['fake://gw'], dir, {}, serve(car))).rejects.toMatchObject({
      category: 'car_incomplete',
      message: expect.stringMatching(/missing/),
    })
  })

  it('accepts the equivalent CIDv1 root for a CIDv0 request', async () => {
    const data = dagPb.encode({ Links: [] })
    const digest = await sha256.digest(data)
    const v0 = CID.createV0(digest)
    const v1 = CID.createV1(dagPb.code, digest)
    const car = await buildCar([v1], [{ cid: v1, bytes: data }])

    await expect(stageMember(v0.toString(), ['fake://gw'], dir, {}, serve(car))).resolves.toMatchObject({
      rawSize: car.length,
    })
  })

  it('falls through to the next gateway and reports which one served the CAR', async () => {
    const { root, leaf } = await linkedDag()
    const car = await buildCar([root.cid], [root, leaf])
    const asked: string[] = []

    const staged = await stageMember(root.cid.toString(), ['fake://down', 'fake://up'], dir, {}, async (gateway) => {
      asked.push(gateway)
      if (gateway === 'fake://down') throw new StagingError('HTTP 503', 'source_gateway_5xx')
      return { url: `${gateway}/ipfs/x`, body: streamOf(car) }
    })

    expect(asked).toEqual(['fake://down', 'fake://up'])
    expect(staged.gateway).toBe('fake://up')
  })

  it('refunds the bytes of a failed attempt before trying the next gateway', async () => {
    const { root, leaf } = await linkedDag()
    const car = await buildCar([root.cid], [root, leaf])
    let counted = 0

    const staged = await stageMember(
      root.cid.toString(),
      ['fake://truncating', 'fake://good'],
      dir,
      { onBytes: (n) => (counted += n) },
      async (gateway) => ({
        url: `${gateway}/x`,
        body: streamOf(gateway === 'fake://truncating' ? car.subarray(0, car.length - 5) : car),
      })
    )

    expect(staged.gateway).toBe('fake://good')
    expect(counted).toBe(car.length)
  })

  it('reports the first specific category when every gateway fails', async () => {
    const err = await stageMember(
      'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy',
      ['fake://a', 'fake://b'],
      dir,
      {},
      async (gateway) => {
        throw new StagingError(`${gateway} down`, gateway === 'fake://a' ? 'other' : 'source_gateway_429')
      }
    ).catch((e: Error) => e)

    expect(err).toMatchObject({ name: 'StagingError', category: 'source_gateway_429' })
    expect((err as Error).message).toContain('fake://a down')
    expect((err as Error).message).toContain('fake://b down')
  })

  it.each([
    ['a staging-budget cutoff', new StagingError('budget', 'staging_budget')],
    ['an unsupported block', new StagingError('no codec', 'unsupported_block')],
    ['a local error', Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })],
  ])('rethrows %s at once instead of trying other gateways', async (_label, failure) => {
    const leaf = await rawBlock(7, 128)
    const car = await buildCar([leaf.cid], [leaf])
    const fetcher = vi.fn(serve(car))

    const err = await stageMember(
      leaf.cid.toString(),
      ['fake://a', 'fake://b'],
      dir,
      {
        onBytes: () => {
          throw failure
        },
      },
      fetcher
    ).catch((e: unknown) => e)

    expect(err).toBe(failure)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(await readdir(dir)).toEqual([])
  })

  it('fails rather than hangs when the member directory cannot be written', async () => {
    const leaf = await rawBlock(7, 4096)
    const car = await buildCar([leaf.cid], [leaf])

    await expect(
      stageMember(leaf.cid.toString(), ['fake://gw'], join(dir, 'missing'), {}, serve(car))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails rather than hangs when the file cannot be opened and writes keep coming', async () => {
    const { createFileSink } = await import('../../migrate/verify-car.js')
    const sink = createFileSink(join(dir, 'missing', 'x.car'))
    const chunk = new Uint8Array(64)
    const writes = (async () => {
      // The open fails asynchronously; later writes must surface it, not wait for `drain` forever.
      for (let i = 0; i < 64; i++) {
        await new Promise((resolve) => setImmediate(resolve))
        await sink.write(chunk)
      }
      await sink.end()
    })()
    await expect(writes).rejects.toMatchObject({ code: 'ENOENT' })
    await sink.destroy()
  })

  it('reports a line that is not a CID in plain words', async () => {
    await expect(stageMember('notacid', ['fake://gw'], dir, {}, vi.fn())).rejects.toMatchObject({
      name: 'StagingError',
      category: 'other',
      message: expect.stringMatching(/not a valid CID/),
    })
  })

  it('overwrites a temp file left by a crashed run', async () => {
    const { root, leaf } = await linkedDag()
    const car = await buildCar([root.cid], [root, leaf])
    const cid = root.cid.toString()
    await import('node:fs/promises').then((fs) => fs.writeFile(join(dir, `${cid}.car.tmp`), 'garbage'))

    await stageMember(cid, ['fake://gw'], dir, {}, serve(car))

    expect(await readdir(dir)).toEqual([`${cid}.car`])
  })
})
