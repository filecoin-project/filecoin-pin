import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { calculate, hasher } from '@filoz/synapse-core/piece'
import { CarWriter } from '@ipld/car'
import * as dagPb from '@ipld/dag-pb'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import * as Digest from 'multiformats/hashes/digest'
import { sha256 } from 'multiformats/hashes/sha2'
import { describe, expect, it, vi } from 'vitest'
import { MigrationDB } from '../../migrate/db.js'
import {
  assembleMultiRootCar,
  MAX_BIN_MEMBERS,
  MAX_UPLOAD_BYTES,
  MIN_UPLOAD_BYTES,
  planBins,
  runPackCars,
  type WritableStreamWithLength,
} from '../../migrate/pack-cars.js'

// The migrate runner computes piece commitments locally (streaming, chunked
// writes) and the SDK recomputes them at store() time over the same bytes.
// The two must agree for every write pattern, or the provider rejects the
// upload with a commP mismatch.

describe('local piece hasher equals the SDK calculation', () => {
  // 0/1: degenerate; 64/65 and 127/128: fr32 254-bit padding boundaries;
  // 1 MiB + 3: multi-chunk write paths; the rest: a mid-size payload.
  it.each([0, 1, 64, 65, 127, 128, 1024, 1048579])('agrees at %i bytes', async (size) => {
    const data = new Uint8Array(size).map((_, i) => (i * 7) % 251)
    const streamed = hasher().write(data).finalize().toString()
    const sdk = (await calculate(data)).toString()
    expect(streamed).toBe(sdk)
  })

  it('is chunk-size independent', async () => {
    // Streaming hashers classically diverge on awkward write boundaries, not
    // on single-shot input. Feed the same payload in prime-sized chunks and
    // compare to the single write.
    const data = new Uint8Array(1048579).map((_, i) => (i * 31) % 251)
    const whole = (await calculate(data)).toString()
    for (const chunkSize of [1024, 997, 65537]) {
      const h = hasher()
      for (let off = 0; off < data.length; off += chunkSize) {
        h.write(data.subarray(off, Math.min(off + chunkSize, data.length)))
      }
      expect(h.finalize().toString(), `chunk size ${chunkSize} diverged from single-shot`).toBe(whole)
    }
  })
})

async function rawBlock(seed: number, size: number): Promise<{ cid: CID; bytes: Uint8Array }> {
  const bytes = new Uint8Array(size).map((_, i) => (i * seed) % 251)
  const digest = await sha256.digest(bytes)
  return { cid: CID.createV1(raw.code, digest), bytes }
}

async function memberCar(seed: number): Promise<{ cid: string; open(): ReadableStream<Uint8Array> }> {
  const block = await rawBlock(seed, 256 + seed)
  const { writer, out } = CarWriter.create([block.cid])
  const chunks: Uint8Array[] = []
  const drained = (async () => {
    for await (const chunk of out) chunks.push(chunk)
  })()
  await writer.put(block)
  await writer.close()
  await drained
  const from = (ReadableStream as unknown as { from(it: Iterable<Uint8Array>): ReadableStream<Uint8Array> }).from
  return { cid: block.cid.toString(), open: () => from([...chunks]) }
}

function memorySink(): { sink: WritableStreamWithLength; bytes: () => Uint8Array } {
  const chunks: Uint8Array[] = []
  return {
    sink: {
      async write(chunk) {
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

describe('assembleMultiRootCar', () => {
  it("computes a piece CID equal to the SDK's over the assembled bytes", async () => {
    const members = [await memberCar(3), await memberCar(5), await memberCar(7)]
    const { sink, bytes } = memorySink()
    const result = await assembleMultiRootCar(members, sink)

    const assembled = bytes()
    expect(result.assembledBytes).toBe(assembled.length)
    expect(result.roots).toEqual(members.map((m) => m.cid))
    const sdk = (await calculate(assembled)).toString()
    expect(result.pieceCid).toBe(sdk)
  })

  it('rejects a member whose CAR is not rooted at its CID', async () => {
    const member = await memberCar(3)
    const other = await memberCar(5)
    const { sink } = memorySink()
    await expect(assembleMultiRootCar([{ cid: other.cid, open: member.open }], sink)).rejects.toThrow(
      /CAR root mismatch/
    )
  })

  it('settles with the sink error when the sink fails mid-assembly', async () => {
    // A disk-full write must reject the assembly, not leave it waiting on a
    // writer whose output nobody drains any more.
    const members = [await memberCar(3), await memberCar(5)]
    const enospc = Object.assign(new Error('no space'), { code: 'ENOSPC' })
    const sink: WritableStreamWithLength = {
      write: vi.fn(async () => {
        throw enospc
      }),
      end: async () => undefined,
    }
    await expect(assembleMultiRootCar(members, sink)).rejects.toBe(enospc)
  })

  it('releases every member source it opened, on success and on failure', async () => {
    const opened: Array<{ returned: boolean }> = []
    const tracked = async (seed: number) => {
      const car = await memberCar(seed)
      return {
        cid: car.cid,
        open: () => {
          const state = { returned: false }
          opened.push(state)
          const it = car.open()[Symbol.asyncIterator]()
          return {
            [Symbol.asyncIterator]: () => ({
              next: () => it.next(),
              return: async () => {
                state.returned = true
                return { done: true as const, value: undefined }
              },
            }),
          }
        },
      }
    }
    const good = await tracked(3)
    const bad = { cid: (await memberCar(5)).cid, open: (await tracked(7)).open }

    await assembleMultiRootCar([good], memorySink().sink)
    await expect(assembleMultiRootCar([good, bad], memorySink().sink)).rejects.toThrow(/CAR root mismatch/)
    expect(opened).toHaveLength(3)
    expect(opened.every((o) => o.returned)).toBe(true)
  })

  it('assembles a member containing an empty block', async () => {
    // An empty file is a zero-byte raw block. Its CAR section still has a
    // positive length (the CID bytes), so it is not the zero-length-section
    // truncation hazard and must pack.
    const empty = new Uint8Array(0)
    const cid = CID.createV1(raw.code, await sha256.digest(empty))
    const { writer, out } = CarWriter.create([cid])
    const chunks: Uint8Array[] = []
    const drained = (async () => {
      for await (const chunk of out) chunks.push(chunk)
    })()
    await writer.put({ cid, bytes: empty })
    await writer.close()
    await drained
    const from = (ReadableStream as unknown as { from(it: Iterable<Uint8Array>): ReadableStream<Uint8Array> }).from
    const member = { cid: cid.toString(), open: () => from([...chunks]) }

    const { sink, bytes } = memorySink()
    const result = await assembleMultiRootCar([member], sink)
    expect(result.roots).toEqual([cid.toString()])
    expect((await calculate(bytes())).toString()).toBe(result.pieceCid)
  })
})

describe('runPackCars oversized handling', () => {
  it('marks an over-cap CID terminal and reclaims its staged bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fp-overcap-'))
    const db = new MigrationDB(join(dir, 'migrate.db'), 'calibration:0xabc')
    try {
      const cid = 'bafkzcibf3ck4uais4fgennh4hbfx5z3i6hue4xgq2cdeamtus4hjbsrjs5lf2azbxmsa'
      const memberCarPath = join(dir, 'member.car')
      await writeFile(memberCarPath, new Uint8Array(8))
      db.addCids([cid])
      db.recordPieceSuccess(cid, {
        pieceCid: cid,
        rawSize: MAX_UPLOAD_BYTES + 1,
        gateway: 'g',
        url: 'fake://gw/x',
        memberCarPath,
        memberSha256: 'sha',
      })

      const freed: number[] = []
      const summary = await runPackCars(db, {
        targetSizeBytes: 1000,
        carStore: join(dir, 'cars'),
        onMemberEvicted: (bytes) => freed.push(bytes),
      })

      expect(summary.overCap).toEqual([cid])
      // Terminal: out of the free pool and the retry queue, budget returned,
      // member file gone.
      expect(db.counts().oversized).toBe(1)
      expect(db.pendingCids()).toEqual([])
      expect(db.freeMemberBytes()).toBe(0)
      expect(freed).toEqual([MAX_UPLOAD_BYTES + 1])
      await expect(readFile(memberCarPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      db.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('runPackCars', () => {
  it('assembles a bin from member files, records it, deletes the members and refunds their bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fp-pack-'))
    const db = new MigrationDB(join(dir, 'migrate.db'), 'calibration:0xabc')
    try {
      const members = [await memberCar(3), await memberCar(5)]
      const sizes: number[] = []
      for (const m of members) {
        const chunks: Uint8Array[] = []
        for await (const c of m.open()) chunks.push(c)
        const bytes = Buffer.concat(chunks)
        sizes.push(bytes.length)
        await writeFile(join(dir, `${m.cid}.car`), bytes)
        db.addCids([m.cid])
        db.recordPieceSuccess(m.cid, {
          pieceCid: m.cid,
          rawSize: bytes.length,
          gateway: 'g',
          url: 'fake://gw/x',
          memberCarPath: join(dir, `${m.cid}.car`),
          memberSha256: 'sha',
        })
      }
      const freed: number[] = []
      let staged = 0

      const summary = await runPackCars(db, {
        targetSizeBytes: 10_000,
        carStore: join(dir, 'cars'),
        onBytesStaged: (d) => (staged += d),
        onMemberEvicted: (b) => freed.push(b),
      })

      expect(summary).toMatchObject({ bins: 1, built: 1, failed: 0 })
      expect(freed.sort()).toEqual(sizes.sort())
      expect(db.freeMemberBytes()).toBe(0)
      const [piece] = await import('node:fs/promises').then((fs) => fs.readdir(join(dir, 'cars')))
      expect(piece).toMatch(/^bafkzcib.*\.car$/)
      const bytes = await readFile(join(dir, 'cars', piece ?? ''))
      expect(staged).toBe(bytes.length)
      expect((await calculate(bytes)).toString()).toBe(piece?.replace(/\.car$/, ''))
      for (const m of members)
        await expect(readFile(join(dir, `${m.cid}.car`))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      db.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refunds an over-cap member whose file is already gone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fp-overcap-gone-'))
    const db = new MigrationDB(join(dir, 'migrate.db'), 'calibration:0xabc')
    try {
      const cid = 'bafkzcibf3ck4uais4fgennh4hbfx5z3i6hue4xgq2cdeamtus4hjbsrjs5lf2azbxmsa'
      db.addCids([cid])
      db.recordPieceSuccess(cid, {
        pieceCid: cid,
        rawSize: MAX_UPLOAD_BYTES + 1,
        gateway: 'g',
        url: 'fake://gw/x',
        memberCarPath: join(dir, 'missing.car'),
        memberSha256: 'sha',
      })
      const freed: number[] = []
      await runPackCars(db, {
        targetSizeBytes: 1000,
        carStore: join(dir, 'cars'),
        onMemberEvicted: (b) => freed.push(b),
      })
      expect(freed).toEqual([MAX_UPLOAD_BYTES + 1])
    } finally {
      db.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('runPackCars final pass', () => {
  it('fails a deferred sub-floor member, deletes its file and refunds its bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fp-deferred-'))
    const db = new MigrationDB(join(dir, 'migrate.db'), 'calibration:0xabc')
    try {
      const cid = 'bafkzcibccmbbyafx5e5lzyqq2upjo5j4ziulp6phikah6p7ujgv2cmqrkxcqepq'
      const memberCarPath = join(dir, 'tiny.car')
      await writeFile(memberCarPath, new Uint8Array(50))
      db.addCids([cid])
      db.recordPieceSuccess(cid, {
        pieceCid: cid,
        rawSize: 50,
        gateway: 'g',
        url: 'u',
        memberCarPath,
        memberSha256: 's',
      })
      const freed: number[] = []

      await runPackCars(db, {
        final: true,
        targetSizeBytes: 1000,
        carStore: join(dir, 'cars'),
        onMemberEvicted: (b) => freed.push(b),
      })

      expect(db.counts().failed).toBe(1)
      expect(freed).toEqual([50])
      await expect(readFile(memberCarPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      db.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('planBins', () => {
  const A = 'bafkzcibewpkqwewyhz3yxutlxbpt2nkb6si5qilg4qqtzzij32uw7ammsc73a4wkgi'
  const B = 'bafkzcibf3ck4uais4fgennh4hbfx5z3i6hue4xgq2cdeamtus4hjbsrjs5lf2azbxmsa'
  const C = 'bafkzcibccmbbyafx5e5lzyqq2upjo5j4ziulp6phikah6p7ujgv2cmqrkxcqepq'

  it('rejects the same DAG registered as CIDv0 and CIDv1', async () => {
    const digest = await sha256.digest(dagPb.encode({ Links: [] }))
    const v0 = CID.createV0(digest).toString()
    const v1 = CID.createV1(dagPb.code, digest).toString()
    expect(() =>
      planBins(
        [
          { cid: v0, rawSize: 1 },
          { cid: v1, rawSize: 1 },
        ],
        1000
      )
    ).toThrow(/duplicate source CID/)
  })

  it('rejects duplicate source CIDs', () => {
    expect(() =>
      planBins(
        [
          { cid: A, rawSize: 1 },
          { cid: A, rawSize: 1 },
        ],
        1000
      )
    ).toThrow(/duplicate source CID/)
  })

  it('rejects a target under the upload floor', () => {
    expect(() => planBins([], MIN_UPLOAD_BYTES - 1)).toThrow(/at least 127/)
  })

  it('returns pieces above the target as solo pieces', () => {
    const small = { cid: A, rawSize: 400 }
    const big = { cid: B, rawSize: 5000 }
    const { bins, solo, deferred } = planBins([small, big], 1000)
    expect(bins).toHaveLength(1)
    expect(bins[0]?.memberCids).toEqual([small.cid])
    expect(solo).toEqual([big])
    expect(deferred).toEqual([])
  })

  it('folds a bin under the upload floor into another bin with room', () => {
    const tiny = { cid: C, rawSize: 100 }
    const full = { cid: A, rawSize: 950 }
    const roomy = { cid: B, rawSize: 600 }
    const { bins, deferred } = planBins([tiny, full, roomy], 1000)
    expect(deferred).toEqual([])
    expect(bins.map((b) => b.totalRawSize).sort()).toEqual([700, 950])
    expect(bins.find((b) => b.totalRawSize === 700)?.memberCids).toEqual([C, B].sort())
  })

  it('folds a sub-floor leftover into a bin first-fit already filled to the target', () => {
    // 600 + 400 fill the target exactly, so first-fit opens a new bin for the
    // 100-byte piece. The target is not the bound for folding, the upload cap
    // is: the leftover rides along instead of waiting forever.
    const { bins, deferred } = planBins(
      [
        { cid: A, rawSize: 600 },
        { cid: B, rawSize: 400 },
        { cid: C, rawSize: 100 },
      ],
      1000
    )
    expect(deferred).toEqual([])
    expect(bins).toHaveLength(1)
    expect(bins[0]?.memberCids).toEqual([A, B, C].sort())
  })

  it('defers a bin under the upload floor when no other bin can take it', () => {
    const tiny = { cid: C, rawSize: 100 }
    const { bins, deferred } = planBins([tiny], 1000)
    expect(bins).toEqual([])
    expect(deferred).toEqual([tiny])
  })

  // Every member is a CAR header root; go-car rejects headers over 32 MiB.
  it('caps members per bin', () => {
    const pieces = Array.from({ length: MAX_BIN_MEMBERS + 1 }, (_, i) => {
      const bytes = new Uint8Array(32)
      new DataView(bytes.buffer).setUint32(0, i)
      return { cid: CID.createV1(raw.code, Digest.create(sha256.code, bytes)).toString(), rawSize: 1 }
    })
    const { bins } = planBins(pieces, Number.MAX_SAFE_INTEGER)
    expect(bins.map((b) => b.memberCids.length)).toEqual([MAX_BIN_MEMBERS, 1])
  })
})
