import { calculate, hasher } from '@filoz/synapse-core/piece'
import { CarWriter } from '@ipld/car'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'
import { describe, expect, it } from 'vitest'
import { assembleMultiRootCar, planBins, type WritableStreamWithLength } from '../../migrate/pack-cars.js'

// The migrate runner computes piece commitments locally (streaming, chunked
// writes) and the SDK recomputes them at store() time over the same bytes.
// The two must agree for every write pattern, or the provider rejects the
// upload with a commP mismatch.

describe('local piece hasher equals the SDK calculation', () => {
  it('agrees across fr32 padding edges', async () => {
    // 0/1: degenerate; 64/65 and 127/128: fr32 254-bit padding boundaries;
    // 1 MiB + 3: multi-chunk write paths; the rest: a mid-size payload.
    const sizes = [0, 1, 64, 65, 127, 128, 1024, 1048579]
    for (const size of sizes) {
      const data = new Uint8Array(size).map((_, i) => (i * 7) % 251)
      const streamed = hasher().write(data).finalize().toString()
      const sdk = (await calculate(data)).toString()
      expect(streamed, `hashers diverged at ${size} bytes`).toBe(sdk)
    }
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

async function memberCar(seed: number): Promise<{ cid: string; body: ReadableStream<Uint8Array> }> {
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
  return { cid: block.cid.toString(), body: from(chunks) }
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
    await expect(assembleMultiRootCar([{ cid: other.cid, body: member.body }], sink)).rejects.toThrow(
      /CAR root mismatch/
    )
  })
})

describe('planBins', () => {
  it('rejects duplicate source CIDs', () => {
    expect(() =>
      planBins(
        [
          { cid: 'bafkzcibewpkqwewyhz3yxutlxbpt2nkb6si5qilg4qqtzzij32uw7ammsc73a4wkgi', rawSize: 1 },
          { cid: 'bafkzcibewpkqwewyhz3yxutlxbpt2nkb6si5qilg4qqtzzij32uw7ammsc73a4wkgi', rawSize: 1 },
        ],
        10
      )
    ).toThrow(/duplicate source CID/)
  })

  it('returns pieces above the target as oversized', () => {
    const small = { cid: 'bafkzcibewpkqwewyhz3yxutlxbpt2nkb6si5qilg4qqtzzij32uw7ammsc73a4wkgi', rawSize: 4 }
    const big = { cid: 'bafkzcibf3ck4uais4fgennh4hbfx5z3i6hue4xgq2cdeamtus4hjbsrjs5lf2azbxmsa', rawSize: 100 }
    const { bins, oversized } = planBins([small, big], 10)
    expect(bins).toHaveLength(1)
    expect(bins[0]?.memberCids).toEqual([small.cid])
    expect(oversized).toEqual([big])
  })
})
