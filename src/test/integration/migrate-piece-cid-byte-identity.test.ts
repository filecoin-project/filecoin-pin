import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildCarUrl, CAR_ACCEPT } from '../../migrate/car-url.js'
import { fetchAndComputePiece } from '../../migrate/piece.js'

// HARD GUARDRAIL: the migrate runner's PieceCID must equal what the storage
// provider recomputes from the bytes it receives. The commP pass serializes
// the canonical CAR locally from block-verified data, and the same
// serialization rebuilds the packed piece at upload time, so the locally
// computed commitment IS the committed bytes' commitment, byte-safe by
// construction. This regression test pins the known-good CAR size/sha256 and
// the resulting PieceCID for two real CIDs so a gateway framing change or a
// piece-hasher regression is caught.
//
// Live: it fetches real CARs from a public trustless gateway. Opt in with
// LIVE_TESTS=1 so the default suite stays hermetic: an offline machine or
// filtered DNS must not fail it. When the canary does run and the gateway is
// unreachable, the assertions fail loudly rather than silently passing.

const live = process.env.LIVE_TESTS != null

const GATEWAY = 'https://trustless-gateway.link'

interface KnownCar {
  cid: string
  /** sha256 + size of the direct `?format=car…` gateway CAR (pinned). */
  sha256: string
  bytes: number
  /** PieceCID v2 computed over that CAR. */
  pieceCid: string
}

const KNOWN: KnownCar[] = [
  {
    cid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    sha256: '89795ad1b0d2a9a712e67989122929c56bfa00ef3c1e063aca86d19a4025f589',
    bytes: 119874,
    pieceCid: 'bafkzcibdxzhqyefkufvnsmqlyrjyr3el6affnfo3l7ipfncjjzjl4hkaqhbaema3',
  },
  {
    cid: 'bafybeia2yt37rxkqu7ovw6ja3nf2aqatrzpcwh2tvl2kqbgeqcccn5evhy',
    sha256: '57aec52dbfc093616afb482a8eec4c877fba1bbf209e4b115764c131a88a0cbc',
    bytes: 5010728,
    pieceCid: 'bafkzcibf3ck4uais4fgennh4hbfx5z3i6hue4xgq2cdeamtus4hjbsrjs5lf2azbxmsa',
  },
]

async function hashStream(body: ReadableStream<Uint8Array>): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    hash.update(chunk)
    bytes += chunk.length
  }
  return { sha256: hash.digest('hex'), bytes }
}

describe.runIf(live)('migrate PieceCID byte identity (live gateway canary; set LIVE_TESTS=1 to run)', () => {
  it('the canonical serialization matches the pinned direct gateway CAR and PieceCID', {
    timeout: 120_000,
  }, async () => {
    for (const known of KNOWN) {
      // 1. The pinned gateway URL streams the known CAR bytes.
      const direct = await fetch(buildCarUrl(GATEWAY, known.cid), { headers: { accept: CAR_ACCEPT } })
      expect(direct.ok, `direct gateway fetch failed for ${known.cid}: HTTP ${direct.status}`).toBe(true)
      expect(direct.body).not.toBeNull()
      const directDigest = await hashStream(direct.body as ReadableStream<Uint8Array>)
      expect(directDigest.sha256, `pinned direct CAR sha256 drifted for ${known.cid}`).toBe(known.sha256)
      expect(directDigest.bytes).toBe(known.bytes)

      // 2. The commP pass (block-verified canonical serialization) produces
      //    byte-identical output: same sha256, size, and the pinned PieceCID.
      const piece = await fetchAndComputePiece(known.cid, [GATEWAY])
      expect(piece.pieceCid, `PieceCID drifted for ${known.cid}`).toBe(known.pieceCid)
      expect(piece.rawSize).toBe(known.bytes)
      expect(piece.memberSha256).toBe(known.sha256)
      expect(piece.url).toBe(buildCarUrl(GATEWAY, known.cid))
    }
  })
})
