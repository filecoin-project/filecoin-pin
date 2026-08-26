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
// actually gone, commP verification of what the provider received, and CAR
// eviction once the primary copy is committed.

// Real PieceCIDs so CID.parse succeeds.
const P1 = 'bafkzcibf3ck4uais4fgennh4hbfx5z3i6hue4xgq2cdeamtus4hjbsrjs5lf2azbxmsa'
const P2 = 'bafkzcibewpkqwewyhz3yxutlxbpt2nkb6si5qilg4qqtzzij32uw7ammsc73a4wkgi'

const fakeSynapse = { chain: { name: 'calibration' } } as unknown as Synapse
const OPTS: DirectUploadOptions = { synapse: fakeSynapse, copies: 2 }
const SCOPE = 'calibration:0xabc'

async function dbAt(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `fp-${name}-`))
  return { dir, db: new MigrationDB(join(dir, 'migrate.db'), SCOPE) }
}

function seedBuilt(db: MigrationDB, subPieceCid: string, carPath: string) {
  const src = `src-${subPieceCid.slice(-8)}`
  db.addCids([src])
  db.recordPieceSuccess(src, {
    pieceCid: subPieceCid,
    rawSize: 1024,
    gateway: 'g',
    url: `https://gw/ipfs/${src}?format=car`,
    memberCarPath: `${carPath}.member`,
    memberSha256: 'sha',
  })
  db.recordBuiltSubPiece({
    subPieceCid,
    assembledCarLength: 1024,
    targetSizeBytes: 1024,
    carPath,
    assembledSha256: 'sha',
    members: [{ cid: src, sha256: 'sha', rawSize: 1024 }],
  })
}

interface FakeBehavior {
  /** Throw on the numbered commit call (1-based) on the given provider. */
  failCommit?: { providerId: string; call: number; message: string }
  /** Per-CID presence answers for hasPiece during re-verify. */
  present?: (cid: string) => boolean
  pullFails?: boolean
  /** Store answers a different commitment than requested (commP mismatch). */
  storeReturns?: (pieceCid: string) => string
  /** Receipt answers for add_unconfirmed reconciliation. Default: not landed. */
  txLanded?: (txHash: string) => boolean
  /** PiecesAdded event answers for landed-tx resolution. Default: none found. */
  addPiecesEvent?: (
    dataSetId: string | null,
    txHash: string
  ) => { dataSetId: bigint; pieceIds: bigint[]; pieceCids: string[] } | null
  /** On-chain piece-id answers for hashless reconciliation. Default: absent. */
  dataSetPieceId?: (dataSetId: string, pieceCid: string) => string | null
  /** Pre-resolved data set id for every context. Default null (created lazily). */
  ctxDataSetId?: string
  /** Offset added to the fake clock, for aging add_unconfirmed breadcrumbs. */
  nowOffsetMs?: number
}

function fakeDeps(b: FakeBehavior = {}) {
  const calls = { store: [] as string[], pull: 0, commit: new Map<string, number>() }
  const evicted: string[] = []
  const mkCtx = (providerId: string): UploadContextLike => ({
    providerId,
    serviceURL: `fake://${providerId}`,
    dataSetId: b.ctxDataSetId ?? null,
    async store(_data, options) {
      const requested = String(options.pieceCid)
      calls.store.push(`${providerId}:${requested}`)
      const answered = b.storeReturns ? b.storeReturns(requested) : requested
      return { pieceCid: answered, size: 1024 }
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
    now: () => Date.now() + (b.nowOffsetMs ?? 0),
    openCar: () => new Uint8Array(8),
    evictCar: async (path) => {
      evicted.push(path)
    },
    txLanded: async (_synapse, txHash) => (b.txLanded ? b.txLanded(txHash) : false),
    fetchAddPiecesEvent: async (_synapse, txHash, dataSetId) => {
      const event = b.addPiecesEvent ? b.addPiecesEvent(dataSetId, txHash) : null
      return event == null ? null : { ...event, blockNumber: 1n }
    },
    dataSetPieceId: async (_synapse, dataSetId, pieceCid) =>
      b.dataSetPieceId ? b.dataSetPieceId(dataSetId, pieceCid) : null,
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
      expect(summary.providers[0]?.addUnconfirmed).toBe(0)
      // The summary must surface the addPieces transactions behind the commits.
      expect(summary.providers[0]?.txHashes).toEqual(['0xtx-p1-1'])
      expect(summary.providers[1]?.txHashes).toEqual(['0xtx-p2-1'])
    } finally {
      db.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('secondary pull failure leaves the secondary failed but frees the CAR once the primary commits', async () => {
    const { dir, db } = await dbAt('du-pullfail')
    try {
      seedBuilt(db, P1, join(dir, 'a.car'))
      const { deps, evicted } = fakeDeps({ pullFails: true })
      const summary = await runDirectUpload(db, OPTS, deps)

      expect(db.uploadsByStatus('p1', 'committed')).toHaveLength(1)
      expect(db.uploadsByStatus('p2', 'failed')).toHaveLength(1)
      // A secondary retry pulls provider-to-provider from the committed
      // primary; it never needs the local file, so the CAR is evicted.
      expect(evicted).toHaveLength(1)
      // The failed copy still marks the run incomplete for the exit code.
      expect(summary.providers[1]?.failed).toBe(1)
    } finally {
      db.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a commP mismatch from store() fails the piece instead of committing the wrong bytes', async () => {
    const { dir, db } = await dbAt('du-commp')
    try {
      seedBuilt(db, P1, join(dir, 'a.car'))
      const { deps, calls, evicted } = fakeDeps({ storeReturns: () => P2 })
      await runDirectUpload(db, OPTS, deps)

      const failed = db.uploadsByStatus('p1', 'failed')
      expect(failed).toHaveLength(1)
      expect(failed[0]?.error).toMatch(/commP mismatch/)
      expect(calls.commit.get('p1') ?? 0).toBe(0)
      expect(evicted).toHaveLength(0)
    } finally {
      db.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('repairs a missing secondary copy left by a crash between store and pull', async () => {
    const { dir, db } = await dbAt('du-repair')
    try {
      seedBuilt(db, P1, join(dir, 'a.car'))
      // The crash shape: the primary parked but the secondary pull never
      // started, so the secondary has no row at all.
      db.recordUploadParked(P1, 'p1', 'primary', null)
      const { deps, calls } = fakeDeps()
      await runDirectUpload(db, OPTS, deps)

      // No re-store on the primary; the secondary copy was pulled and both
      // copies committed.
      expect(calls.store).toHaveLength(0)
      expect(calls.pull).toBe(1)
      expect(db.uploadsByStatus('p1', 'committed')).toHaveLength(1)
      expect(db.uploadsByStatus('p2', 'committed')).toHaveLength(1)
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
      // was missed. The reconciliation must leave the row alone: no store,
      // no commit: and the summary must count it.
      const second = fakeDeps({ txLanded: () => true })
      const summary = await runDirectUpload(db, OPTS, second.deps)
      expect(db.uploadsByStatus('p1', 'add_unconfirmed')).toHaveLength(1)
      expect(second.calls.store.filter((s) => s.startsWith('p1:'))).toHaveLength(0)
      expect(second.calls.commit.get('p1') ?? 0).toBe(0)
      expect(summary.providers[0]?.addUnconfirmed).toBe(1)
    } finally {
      db.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a landed tx resolves from the PiecesAdded event using the data set recorded on the row', async () => {
    const { dir, db } = await dbAt('du-landed-event')
    try {
      seedBuilt(db, P1, join(dir, 'a.car'))
      const first = fakeDeps({
        ctxDataSetId: '7',
        failCommit: { providerId: 'p1', call: 1, message: 'confirmation poll timed out' },
      })
      await runDirectUpload(db, OPTS, first.deps)
      expect(db.uploadsByStatus('p1', 'add_unconfirmed')).toHaveLength(1)

      // Second run opens fresh contexts with no resolved data set; the row's
      // own data_set_id (recorded when the piece parked) must drive the
      // event lookup.
      const second = fakeDeps({
        txLanded: () => true,
        addPiecesEvent: (dataSetId) =>
          dataSetId === '7' ? { dataSetId: 7n, pieceIds: [42n], pieceCids: [P1] } : null,
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

  it('non-GC commit failure leaves the batch add_unconfirmed with no stale tx hash after re-park', async () => {
    const { dir, db } = await dbAt('du-unconfirmed')
    try {
      seedBuilt(db, P1, join(dir, 'a.car'))
      const first = fakeDeps({
        failCommit: { providerId: 'p1', call: 1, message: 'insufficient funds' },
      })
      await runDirectUpload(db, OPTS, first.deps)
      expect(db.uploadsByStatus('p1', 'add_unconfirmed')).toHaveLength(1)

      // Second run, past the requeue window (a younger row with a captured
      // tx hash is held: the tx could still land and re-adding would
      // double-add). The piece is still parked on the provider, so the
      // resume reconciliation re-queues it and the commit lands, without
      // re-storing and with the failed attempt's tx hash replaced by the
      // real one.
      const second = fakeDeps({ nowOffsetMs: 61 * 60_000 })
      await runDirectUpload(db, OPTS, second.deps)
      const committed = db.uploadsByStatus('p1', 'committed')
      expect(committed).toHaveLength(1)
      expect(committed[0]?.txHash).toBe('0xtx-p1-1')
      expect(second.calls.store.filter((s) => s.startsWith('p1:'))).toHaveLength(0)
    } finally {
      db.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('resolves a hashless add_unconfirmed row from the data set itself when the piece is on chain', async () => {
    const { dir, db } = await dbAt('du-hashless-committed')
    try {
      seedBuilt(db, P1, join(dir, 'a.car'))
      // The crash shape: the breadcrumb was written and the commit may have
      // broadcast, but the process died before the tx hash callback.
      db.recordUploadParked(P1, 'p1', 'primary', '7')
      db.markUploadsAddUnconfirmed([P1], 'p1')

      const { deps, calls } = fakeDeps({ dataSetPieceId: (dataSetId) => (dataSetId === '7' ? '42' : null) })
      await runDirectUpload(db, OPTS, deps)

      const committed = db.uploadsByStatus('p1', 'committed')
      expect(committed).toHaveLength(1)
      expect(committed[0]?.pieceId).toBe('42')
      // Resolved from the chain: no re-store, no second commit for it.
      expect(calls.store.filter((s) => s.startsWith('p1:'))).toHaveLength(0)
    } finally {
      db.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('holds a fresh add_unconfirmed row whose tx has no receipt yet', async () => {
    const { dir, db } = await dbAt('du-pending-tx')
    try {
      seedBuilt(db, P1, join(dir, 'a.car'))
      db.recordUploadParked(P1, 'p1', 'primary', '7')
      db.markUploadsAddUnconfirmed([P1], 'p1')
      db.markUploadTxSubmitted([P1], 'p1', '0xpending')

      // txLanded false = no receipt. The tx can still be in the mempool, so
      // the row must not re-park (a second commit would double-add).
      const { deps, calls } = fakeDeps({ txLanded: () => false })
      await runDirectUpload(db, OPTS, deps)

      expect(db.uploadsByStatus('p1', 'add_unconfirmed')).toHaveLength(1)
      expect(calls.commit.get('p1') ?? 0).toBe(0)
    } finally {
      db.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('recovers the data set id from the PiecesAdded event when none was recorded', async () => {
    const { dir, db } = await dbAt('du-event-setid')
    try {
      seedBuilt(db, P1, join(dir, 'a.car'))
      // First-commit crash shape on a new data set: parked before any set id
      // existed, tx hash captured, no data_set_id anywhere.
      db.recordUploadParked(P1, 'p1', 'primary', null)
      db.markUploadsAddUnconfirmed([P1], 'p1')
      db.markUploadTxSubmitted([P1], 'p1', '0xfirst')

      const { deps } = fakeDeps({
        txLanded: () => true,
        addPiecesEvent: (dataSetId) =>
          dataSetId == null ? { dataSetId: 9n, pieceIds: [5n], pieceCids: [P1] } : null,
      })
      await runDirectUpload(db, OPTS, deps)

      const committed = db.uploadsByStatus('p1', 'committed')
      expect(committed).toHaveLength(1)
      expect(committed[0]?.dataSetId).toBe('9')
      expect(committed[0]?.pieceId).toBe('5')
    } finally {
      db.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('holds a fresh hashless add_unconfirmed row even when absent from the data set', async () => {
    const { dir, db } = await dbAt('du-hashless-fresh')
    try {
      seedBuilt(db, P1, join(dir, 'a.car'))
      db.recordUploadParked(P1, 'p1', 'primary', '7')
      db.markUploadsAddUnconfirmed([P1], 'p1')

      // A just-written breadcrumb cannot rule out a transaction still in
      // flight; the row must stay unresolved this run.
      const { deps, calls } = fakeDeps()
      const summary = await runDirectUpload(db, OPTS, deps)

      expect(db.uploadsByStatus('p1', 'add_unconfirmed')).toHaveLength(1)
      expect(calls.commit.get('p1') ?? 0).toBe(0)
      expect(summary.providers[0]?.addUnconfirmed).toBe(1)
    } finally {
      db.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('re-parks a hashless add_unconfirmed row absent from the data set once it has aged out', async () => {
    const { dir, db } = await dbAt('du-hashless-aged')
    try {
      seedBuilt(db, P1, join(dir, 'a.car'))
      db.recordUploadParked(P1, 'p1', 'primary', '7')
      db.markUploadsAddUnconfirmed([P1], 'p1')

      // Two hours later, an in-flight transaction would have landed or died;
      // absent on chain and still parked on the provider means re-queue, and
      // the commit lands without re-storing.
      const { deps, calls } = fakeDeps({ nowOffsetMs: 2 * 60 * 60_000 })
      await runDirectUpload(db, OPTS, deps)

      expect(db.uploadsByStatus('p1', 'committed')).toHaveLength(1)
      expect(calls.store.filter((s) => s.startsWith('p1:'))).toHaveLength(0)
      expect(calls.commit.get('p1')).toBe(1)
    } finally {
      db.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('leaves a hashless add_unconfirmed row alone when no data set is known', async () => {
    const { dir, db } = await dbAt('du-hashless-unknown')
    try {
      seedBuilt(db, P1, join(dir, 'a.car'))
      db.recordUploadParked(P1, 'p1', 'primary', null)
      db.markUploadsAddUnconfirmed([P1], 'p1')

      const { deps, calls } = fakeDeps()
      const summary = await runDirectUpload(db, OPTS, deps)

      expect(db.uploadsByStatus('p1', 'add_unconfirmed')).toHaveLength(1)
      expect(calls.commit.get('p1') ?? 0).toBe(0)
      expect(summary.providers[0]?.addUnconfirmed).toBe(1)
    } finally {
      db.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses to rebuild a staged piece while it has live upload state', async () => {
    const { dir, db } = await dbAt('du-rebuild-guard')
    try {
      seedBuilt(db, P1, join(dir, 'a.car'))
      db.recordUploadParked(P1, 'p1', 'primary', '7')
      db.markUploadsAddUnconfirmed([P1], 'p1')

      // An unresolved breadcrumb must survive any rebuild attempt: deleting
      // it and re-adding the source CIDs could duplicate the piece on chain.
      expect(() => db.deleteSubPieceForRebuild(P1)).toThrow(/live upload/)
      expect(db.uploadsByStatus('p1', 'add_unconfirmed')).toHaveLength(1)

      // Once reconciliation resolves the row to a terminal retry state, the
      // rebuild goes through and frees the members.
      db.markUploadCollected(P1, 'p1')
      const members = db.deleteSubPieceForRebuild(P1)
      expect(members).toHaveLength(1)
      expect(db.subPieceByCid(P1)).toBeNull()
    } finally {
      db.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('scopes state: another network/owner scope sees none of the rows', async () => {
    const { dir, db } = await dbAt('du-scope')
    try {
      seedBuilt(db, P1, join(dir, 'a.car'))
      const { deps } = fakeDeps()
      await runDirectUpload(db, OPTS, deps)
      expect(db.uploadsByStatus('p1', 'committed')).toHaveLength(1)

      const other = new MigrationDB(db.path, 'mainnet:0xdef')
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
