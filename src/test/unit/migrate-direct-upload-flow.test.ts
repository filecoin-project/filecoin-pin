import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Synapse } from '@filoz/synapse-sdk'
import { describe, expect, it } from 'vitest'
import { MigrationDB } from '../../migrate/db.js'
import {
  type DirectUploadDeps,
  type DirectUploadOptions,
  runDirectUpload,
  type UploadContextLike,
} from '../../migrate/direct-upload.js'

// Drives the real runDirectUpload control flow with fake providers, to lock in
// the direct-upload guarantees: store-then-batch-commit, the add_unconfirmed
// breadcrumb, GC detection lowering the window and re-storing only what is
// actually gone, and CAR eviction only after every copy is committed.

// Real PieceCIDs so CID.parse succeeds.
const P1 = 'bafkzcibf3ck4uais4fgennh4hbfx5z3i6hue4xgq2cdeamtus4hjbsrjs5lf2azbxmsa'
const P2 = 'bafkzcibewpkqwewyhz3yxutlxbpt2nkb6si5qilg4qqtzzij32uw7ammsc73a4wkgi'

const fakeSynapse = { chain: { name: 'calibration' } } as unknown as Synapse
const OPTS: DirectUploadOptions = { synapse: fakeSynapse, copies: 2 }

async function dbAt(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `fp-${name}-`))
  return { dir, db: new MigrationDB(join(dir, 'migrate.db'), 'calibration') }
}

function seedBuilt(db: MigrationDB, subPieceCid: string, carPath: string) {
  const src = `src-${subPieceCid.slice(-8)}`
  db.addCids([src])
  db.recordPieceSuccess(src, subPieceCid, 1024, 'g', `https://gw/ipfs/${src}?format=car`, null)
  db.recordBuiltSubPiece({
    subPieceCid,
    assembledCarLength: 1024,
    targetSizeBytes: 1024,
    carPath,
    assembledSha256: 'sha',
    members: [{ cid: src, sha256: null, rawSize: 1024 }],
  })
}

interface FakeBehavior {
  /** Throw on the numbered commit call (1-based) on the given provider. */
  failCommit?: { providerId: string; call: number; message: string }
  /** Per-CID presence answers for hasPiece during re-verify. */
  present?: (cid: string) => boolean
  pullFails?: boolean
  /** Receipt answers for add_unconfirmed reconciliation. Default: not landed. */
  txLanded?: (txHash: string) => boolean
  /** PiecesAdded event answers for landed-tx resolution. Default: none found. */
  addPiecesEvent?: (dataSetId: number, txHash: string) => { pieceIds: bigint[]; pieceCids: string[] } | null
  /** Pre-resolved data set id for every context. Default null (created lazily). */
  ctxDataSetId?: string
}

function fakeDeps(b: FakeBehavior = {}) {
  const calls = { store: [] as string[], pull: 0, commit: new Map<string, number>() }
  const evicted: string[] = []
  const mkCtx = (providerId: string): UploadContextLike => ({
    providerId,
    serviceURL: `fake://${providerId}`,
    dataSetId: b.ctxDataSetId ?? null,
    async store(_data, options) {
      calls.store.push(`${providerId}:${String(options.pieceCid)}`)
      return { pieceCid: options.pieceCid, size: 1024 }
    },
    async presignForCommit() {
      return '0xfake'
    },
    async pull(options) {
      calls.pull++
      const status = b.pullFails ? ('failed' as const) : ('complete' as const)
      return { status, pieces: options.pieces.map((p) => ({ pieceCid: p, status })) }
    },
    async commit(options) {
      const n = (calls.commit.get(providerId) ?? 0) + 1
      calls.commit.set(providerId, n)
      const f = b.failCommit
      if (f != null && f.providerId === providerId && f.call === n) {
        // Simulate a commit that was submitted (tx hash recorded) but then
        // failed at confirmation: the shape of the add_unconfirmed hazard.
        options.onSubmitted?.(`0xtx-${providerId}-${n}`)
        throw new Error(f.message)
      }
      return {
        txHash: `0xtx-${providerId}-${n}`,
        pieceIds: options.pieces.map((_, i) => BigInt(i)),
        dataSetId: 7n,
      }
    },
    getPieceUrl: (pieceCid) => `fake://${providerId}/piece/${String(pieceCid)}`,
    hasPiece: async (pieceCid) => (b.present ? b.present(String(pieceCid)) : true),
  })
  const deps: DirectUploadDeps = {
    async setup() {
      return { contexts: [mkCtx('p1'), mkCtx('p2')] }
    },
    now: () => Date.now(),
    openCar: () => new Uint8Array(8),
    evictCar: async (path) => {
      evicted.push(path)
    },
    txLanded: async (_synapse, txHash) => (b.txLanded ? b.txLanded(txHash) : false),
    fetchAddPiecesEvent: async (_synapse, dataSetId, txHash) => {
      const event = b.addPiecesEvent ? b.addPiecesEvent(dataSetId, txHash) : null
      return event == null ? null : { ...event, blockNumber: 1n }
    },
  }
  return { deps, calls, evicted }
}

describe('runDirectUpload', () => {
  it('happy path: stores on primary, pulls to secondary, drained flush commits both, evicts CARs', async () => {
    const { dir, db } = await dbAt('du-happy')
    try {
      seedBuilt(db, P1, join(dir, 'a.car'))
      seedBuilt(db, P2, join(dir, 'b.car'))
      const { deps, calls, evicted } = fakeDeps()
      const summary = await runDirectUpload(db, OPTS, deps)

      expect(calls.store).toEqual([`p1:${P1}`, `p1:${P2}`])
      expect(calls.pull).toBe(2)
      // One drained flush per provider, both pieces in one batch.
      expect(calls.commit.get('p1')).toBe(1)
      expect(calls.commit.get('p2')).toBe(1)
      for (const provider of ['p1', 'p2']) {
        const committed = db.uploadsByStatus(provider, 'committed')
        expect(committed.map((u) => u.subPieceCid).sort()).toEqual([P2, P1].sort())
        for (const u of committed) expect(u.dataSetId).toBe('7')
      }
      expect(evicted).toHaveLength(2)
      expect(summary.providers[0]?.committed).toBe(2)
      expect(summary.providers[0]?.role).toBe('primary')
      // The summary must surface the addPieces transactions behind the commits.
      expect(summary.providers[0]?.txHashes).toEqual(['0xtx-p1-1'])
      expect(summary.providers[1]?.txHashes).toEqual(['0xtx-p2-1'])
    } finally {
      db.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('secondary pull failure leaves the primary committed and the secondary failed', async () => {
    const { dir, db } = await dbAt('du-pullfail')
    try {
      seedBuilt(db, P1, join(dir, 'a.car'))
      const { deps, evicted } = fakeDeps({ pullFails: true })
      await runDirectUpload(db, OPTS, deps)

      expect(db.uploadsByStatus('p1', 'committed')).toHaveLength(1)
      expect(db.uploadsByStatus('p2', 'failed')).toHaveLength(1)
      // The CAR must survive: the secondary copy never landed.
      expect(evicted).toHaveLength(0)
    } finally {
      db.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('GC rejection: lowers the provider window, re-stores only the collected piece, keeps the rest parked', async () => {
    const { dir, db } = await dbAt('du-gc')
    try {
      seedBuilt(db, P1, join(dir, 'a.car'))
      seedBuilt(db, P2, join(dir, 'b.car'))
      const { deps, calls } = fakeDeps({
        failCommit: {
          providerId: 'p1',
          call: 1,
          message: `Failed to process request: subPiece CID ${P1} not found or does not belong to service svc`,
        },
        present: (cid) => cid !== P1,
      })
      await runDirectUpload(db, OPTS, deps)

      // P1 was re-stored on the primary after being collected; P2 was not.
      expect(calls.store.filter((s) => s === `p1:${P1}`)).toHaveLength(2)
      expect(calls.store.filter((s) => s === `p1:${P2}`)).toHaveLength(1)
      // Both pieces end up committed via the retry flush.
      expect(db.uploadsByStatus('p1', 'committed')).toHaveLength(2)
      // The window guess dropped below the default for the flaky provider only.
      const defaultMs = 60 * 60_000
      expect(db.providerWindowMs('p1', defaultMs)).toBeLessThan(defaultMs)
      expect(db.providerWindowMs('p2', defaultMs)).toBe(defaultMs)
    } finally {
      db.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a landed-but-unconfirmed tx is never re-queued: no blind re-add', async () => {
    const { dir, db } = await dbAt('du-landed')
    try {
      seedBuilt(db, P1, join(dir, 'a.car'))
      const first = fakeDeps({
        failCommit: { providerId: 'p1', call: 1, message: 'confirmation poll timed out' },
      })
      await runDirectUpload(db, OPTS, first.deps)
      expect(db.uploadsByStatus('p1', 'add_unconfirmed')).toHaveLength(1)

      // Second run: the tx actually landed on chain even though confirmation
      // was missed. The reconciliation must leave the row alone: no store, no
      // commit.
      const second = fakeDeps({ txLanded: () => true })
      await runDirectUpload(db, OPTS, second.deps)
      expect(db.uploadsByStatus('p1', 'add_unconfirmed')).toHaveLength(1)
      expect(second.calls.store.filter((s) => s.startsWith('p1:'))).toHaveLength(0)
      expect(second.calls.commit.get('p1') ?? 0).toBe(0)
    } finally {
      db.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a landed tx with a verifiable PiecesAdded event auto-resolves to committed', async () => {
    const { dir, db } = await dbAt('du-landed-event')
    try {
      seedBuilt(db, P1, join(dir, 'a.car'))
      const first = fakeDeps({
        failCommit: { providerId: 'p1', call: 1, message: 'confirmation poll timed out' },
      })
      await runDirectUpload(db, OPTS, first.deps)
      expect(db.uploadsByStatus('p1', 'add_unconfirmed')).toHaveLength(1)

      const second = fakeDeps({
        txLanded: () => true,
        ctxDataSetId: '7',
        addPiecesEvent: () => ({ pieceIds: [42n], pieceCids: [P1] }),
      })
      await runDirectUpload(db, OPTS, second.deps)
      const committed = db.uploadsByStatus('p1', 'committed')
      expect(committed).toHaveLength(1)
      expect(committed[0]?.pieceId).toBe('42')
      expect(committed[0]?.dataSetId).toBe('7')
      // Resolved from the chain, not re-executed.
      expect(second.calls.commit.get('p1') ?? 0).toBe(0)
    } finally {
      db.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('non-GC commit failure leaves the batch add_unconfirmed, and a later run reconciles it', async () => {
    const { dir, db } = await dbAt('du-unconfirmed')
    try {
      seedBuilt(db, P1, join(dir, 'a.car'))
      const first = fakeDeps({
        failCommit: { providerId: 'p1', call: 1, message: 'insufficient funds' },
      })
      await runDirectUpload(db, OPTS, first.deps)
      expect(db.uploadsByStatus('p1', 'add_unconfirmed')).toHaveLength(1)

      // Second run: the piece is still parked on the provider, so the resume
      // reconciliation re-queues it and the commit lands: without re-storing.
      const second = fakeDeps()
      await runDirectUpload(db, OPTS, second.deps)
      expect(db.uploadsByStatus('p1', 'committed')).toHaveLength(1)
      expect(second.calls.store.filter((s) => s.startsWith('p1:'))).toHaveLength(0)
    } finally {
      db.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('scopes state per network: another network sees none of the rows', async () => {
    const { dir, db } = await dbAt('du-network')
    try {
      seedBuilt(db, P1, join(dir, 'a.car'))
      const { deps } = fakeDeps()
      await runDirectUpload(db, OPTS, deps)
      expect(db.uploadsByStatus('p1', 'committed')).toHaveLength(1)

      const other = new MigrationDB(db.path, 'mainnet')
      try {
        expect(other.subPiecesNeedingUpload('p1')).toHaveLength(0)
        expect(other.uploadsByStatus('p1', 'committed')).toHaveLength(0)
        expect(other.counts().total).toBe(0)
      } finally {
        other.close()
      }
    } finally {
      db.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
