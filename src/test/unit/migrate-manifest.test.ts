import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CID } from 'multiformats/cid'
import { describe, expect, it } from 'vitest'
import { MigrationDB } from '../../migrate/db.js'
import type { DirectUploadSummary, UploadContextLike } from '../../migrate/direct-upload.js'
import { buildManifest, uploadManifest } from '../../migrate/manifest.js'

const P1 = 'bafkzcibf3ck4uais4fgennh4hbfx5z3i6hue4xgq2cdeamtus4hjbsrjs5lf2azbxmsa'
const SRC = 'bafybeia2yt37rxkqu7ovw6ja3nf2aqatrzpcwh2tvl2kqbgeqcccn5evhy'

const summary: DirectUploadSummary = {
  network: 'calibration',
  providers: [],
  storedBytes: 0,
  evictedCars: 0,
}

describe('buildManifest', () => {
  it('maps every source CID to its packed piece with the on-chain coordinates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fp-manifest-'))
    const db = new MigrationDB(join(dir, 'migrate.db'), 'calibration')
    try {
      db.addCids([SRC])
      db.recordPieceSuccess(SRC, P1, 1024, 'g', `https://gw/ipfs/${SRC}?format=car`, 'sha')
      db.recordBuiltSubPiece({
        subPieceCid: P1,
        assembledCarLength: 1024,
        targetSizeBytes: 1024,
        carPath: join(dir, 'a.car'),
        assembledSha256: 'sha',
        members: [{ cid: SRC, sha256: null, rawSize: 1024 }],
      })
      db.recordUploadParked(P1, 'p1', 'primary', '7')
      db.markUploadCommitted(P1, 'p1', { dataSetId: '7', pieceId: '42', txHash: '0xtx' })

      const manifest = buildManifest(db, summary, '2026-08-12T00:00:00.000Z')
      expect(manifest.network).toBe('calibration')
      expect(manifest.sources).toEqual({ [SRC]: P1 })
      expect(manifest.pieces).toHaveLength(1)
      expect(manifest.pieces[0]?.members).toEqual([SRC])
      expect(manifest.pieces[0]?.uploads).toEqual([
        { providerId: 'p1', role: 'primary', status: 'committed', dataSetId: '7', pieceId: '42', txHash: '0xtx' },
      ])
      expect(manifest.failures).toEqual([])
    } finally {
      db.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('uploadManifest', () => {
  it('imports the manifest via UnixFS, stores it, and commits it tagged migrationManifest', async () => {
    const commits: Array<{ pieceCid: string; pieceMetadata?: Record<string, string> }> = []
    const stores: string[] = []
    const pulls: string[] = []
    const mkCtx = (providerId: string): UploadContextLike => ({
      providerId,
      serviceURL: `fake://${providerId}`,
      dataSetId: '7',
      async store(_data, opts) {
        // The manifest CAR carries no pre-computed pieceCid; the provider
        // would compute it. Fake one deterministic value.
        const pieceCid = opts.pieceCid == null ? P1 : String(opts.pieceCid)
        stores.push(`${providerId}:${pieceCid}`)
        return { pieceCid: CID.parse(pieceCid), size: 128 }
      },
      async presignForCommit() {
        return '0xfake'
      },
      async pull(opts) {
        pulls.push(providerId)
        return { status: 'complete', pieces: opts.pieces.map((p) => ({ pieceCid: p, status: 'complete' as const })) }
      },
      async commit(opts) {
        for (const piece of opts.pieces) {
          const entry: { pieceCid: string; pieceMetadata?: Record<string, string> } = {
            pieceCid: String(piece.pieceCid),
          }
          if (piece.pieceMetadata != null) entry.pieceMetadata = piece.pieceMetadata
          commits.push(entry)
        }
        return { txHash: `0xtx-${providerId}`, pieceIds: [1n], dataSetId: 7n }
      },
      getPieceUrl: (pieceCid) => `fake://${providerId}/piece/${String(pieceCid)}`,
      hasPiece: async () => true,
    })

    const dir = await mkdtemp(join(tmpdir(), 'fp-manifest-up-'))
    const db = new MigrationDB(join(dir, 'migrate.db'), 'calibration')
    try {
      const manifest = buildManifest(db, summary, '2026-08-12T00:00:00.000Z')
      const result = await uploadManifest(manifest, [mkCtx('p1'), mkCtx('p2')], {
        openCar: () => new Uint8Array(8),
      })

      // The root CID is a real UnixFS import of the JSON document.
      expect(() => CID.parse(result.rootCid)).not.toThrow()
      expect(result.pieceCid).toBe(P1)
      expect(stores).toEqual([`p1:${P1}`])
      expect(pulls).toEqual(['p2'])
      // Every context committed the manifest piece with the tag.
      expect(commits).toHaveLength(2)
      for (const commit of commits) {
        expect(commit.pieceCid).toBe(P1)
        expect(commit.pieceMetadata).toEqual({ migrationManifest: 'true' })
      }
      expect(result.txHashes).toEqual(['0xtx-p1', '0xtx-p2'])
    } finally {
      db.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
