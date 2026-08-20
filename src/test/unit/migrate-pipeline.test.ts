import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Synapse } from '@filoz/synapse-sdk'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'
import { migrateIncomplete } from '../../migrate/migrate.js'
import { describe, expect, it } from 'vitest'
import { MigrationDB } from '../../migrate/db.js'
import type { DirectUploadDeps, UploadContextLike } from '../../migrate/direct-upload.js'
import type { BinBuilder } from '../../migrate/pack-cars.js'
import { type MigrateRunOptions, runMigrate } from '../../migrate/run-migrate.js'
import type { stageMember } from '../../migrate/verify-car.js'

// Exercises the budget-clocked pipeline end to end with fake network edges:
// downloads overlap uploads, a small budget cycles instead of wedging, and a
// resumed run reuses members already staged on disk.

const fakeSynapse = { chain: { name: 'calibration' } } as unknown as Synapse

async function cidFor(text: string): Promise<string> {
  const digest = await sha256.digest(new TextEncoder().encode(text))
  return CID.createV1(raw.code, digest).toString()
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface HarnessOptions {
  cids: Array<{ cid: string; delayMs: number; rawSize?: number }>
  budgetBytes: number
  packTargetBytes: number
  /** CIDs the stager must never be asked for (already staged on disk). */
  forbiddenFetches?: string[]
}

async function harness(config: HarnessOptions) {
  const dir = await mkdtemp(join(tmpdir(), 'fp-pipeline-'))
  const memberDir = join(dir, 'members')
  const carStore = join(dir, 'cars')
  await mkdir(memberDir, { recursive: true })
  await mkdir(carStore, { recursive: true })
  const db = new MigrationDB(join(dir, 'migrate.db'), 'calibration:0xabc')
  db.addCids(config.cids.map((c) => c.cid))
  const events: string[] = []

  const stageMemberFn: typeof stageMember = async (cid, _gateways, dirForMembers, opts) => {
    const entry = config.cids.find((c) => c.cid === cid)
    if (entry == null) throw new Error(`unexpected cid ${cid}`)
    if (config.forbiddenFetches?.includes(cid)) throw new Error(`must not re-download ${cid}`)
    await sleep(entry.delayMs)
    const rawSize = entry.rawSize ?? 600
    // Byte accounting drives the budget gate; report the size like the real
    // stager does, then land a stand-in member file.
    opts?.onBytes?.(rawSize)
    const memberCarPath = join(dirForMembers, `${cid}.car`)
    await writeFile(memberCarPath, new Uint8Array(rawSize))
    events.push(`fetch:${cid}`)
    return {
      cid,
      pieceCid: await cidFor(`piece-${cid}`),
      rawSize,
      gateway: 'fake',
      url: `fake://gw/${cid}`,
      memberCarPath,
      memberSha256: 'sha',
    }
  }

  const buildBin: BinBuilder = async (bin, binStore, _memberPaths, onBytes) => {
    const pieceCid = await cidFor(`bin-${bin.memberCids.join('+')}`)
    events.push(`build:${bin.memberCids.length}`)
    onBytes?.(bin.totalRawSize)
    const filePath = join(binStore, `${pieceCid}.car`)
    await writeFile(filePath, new Uint8Array(8))
    return { pieceCid, assembledBytes: bin.totalRawSize, sha256: 'sha', filePath }
  }

  const ctx: UploadContextLike = {
    providerId: 'p1',
    serviceURL: 'fake://p1',
    dataSetId: '7',
    async store(_data, opts) {
      events.push(`store:${String(opts.pieceCid)}`)
      return { pieceCid: opts.pieceCid, size: 600 }
    },
    async presignForCommit() {
      return '0xfake'
    },
    async pull(opts) {
      return { status: 'complete', pieces: opts.pieces.map((p) => ({ pieceCid: p, status: 'complete' as const })) }
    },
    async commit(opts) {
      events.push(`commit:${opts.pieces.length}`)
      return { txHash: '0xtx', pieceIds: opts.pieces.map((_, i) => BigInt(i)), dataSetId: 7n }
    },
    getPieceUrl: (pieceCid) => `fake://p1/piece/${String(pieceCid)}`,
    hasPiece: async () => true,
  }

  const deps: DirectUploadDeps = {
    async setup() {
      return { contexts: [ctx] }
    },
    now: () => Date.now(),
    openCar: () => new Uint8Array(8),
    evictCar: async (path) => {
      // Mirror the real deps: eviction deletes the file, and the budget only
      // returns bytes for files actually gone.
      await rm(path, { force: true })
      events.push('evict')
    },
    txLanded: async () => false,
    fetchAddPiecesEvent: async () => null,
    dataSetPieceId: async () => null,
  }

  const options: MigrateRunOptions = {
    synapse: fakeSynapse,
    gateways: ['fake://gw'],
    memberDir,
    carStore,
    packTargetBytes: config.packTargetBytes,
    concurrency: 4,
    budgetBytes: config.budgetBytes,
    copies: 1,
    stageMemberFn,
    buildBin,
  }

  return { db, dir, events, options, deps }
}

describe('runMigrate pipeline', () => {
  it('uploads packed pieces while later CIDs still download', async () => {
    const cids = [
      { cid: await cidFor('a'), delayMs: 0 },
      { cid: await cidFor('b'), delayMs: 0 },
      { cid: await cidFor('c'), delayMs: 400 },
    ]
    const h = await harness({ cids, budgetBytes: 100_000, packTargetBytes: 1000 })
    try {
      const summary = await runMigrate(h.db, h.options, h.deps)

      const firstStore = h.events.findIndex((e) => e.startsWith('store:'))
      const lastFetch = h.events.lastIndexOf(`fetch:${cids[2]?.cid}`)
      expect(firstStore).toBeGreaterThanOrEqual(0)
      // The slow third CID must still have been downloading when the first
      // packed piece hit the provider: the point of the pipeline.
      expect(firstStore).toBeLessThan(lastFetch)

      expect(summary.pieces).toEqual({ total: 3, succeeded: 3, failed: 0, pending: 0, oversized: 0 })
      expect(summary.unpacked).toEqual([])
      expect(h.db.uploadsByStatus('p1', 'committed').length).toBeGreaterThan(0)
      expect(h.db.subPiecesNeedingUpload('p1')).toHaveLength(0)
    } finally {
      h.db.close()
      await rm(h.dir, { recursive: true, force: true })
    }
  })

  it('reports downloaded CIDs whose packing failed, so the run cannot exit 0', async () => {
    const cids = [{ cid: await cidFor('a'), delayMs: 0 }]
    const h = await harness({ cids, budgetBytes: 100_000, packTargetBytes: 1000 })
    try {
      const summary = await runMigrate(
        h.db,
        {
          ...h.options,
          buildBin: async () => {
            throw new Error('assembly exploded')
          },
        },
        h.deps
      )

      // Downloaded, never shipped: the summary must say so and the exit-code
      // predicate must treat it as incomplete.
      expect(summary.pieces.succeeded).toBe(1)
      expect(summary.unpacked).toEqual([cids[0]?.cid])
      expect(migrateIncomplete(summary)).toBe(true)
    } finally {
      h.db.close()
      await rm(h.dir, { recursive: true, force: true })
    }
  })

  it('cycles a budget smaller than the migration instead of wedging', async () => {
    const cids = await Promise.all(
      ['a', 'b', 'c', 'd', 'e', 'f'].map(async (t) => ({ cid: await cidFor(t), delayMs: 0 }))
    )
    // 2x the pack target is the minimum viable budget; the whole migration is
    // 3600 bytes, so completion proves eviction returns budget to the
    // download gate.
    const h = await harness({ cids, budgetBytes: 2000, packTargetBytes: 1000 })
    try {
      const summary = await runMigrate(h.db, h.options, h.deps)

      expect(summary.pieces).toEqual({ total: 6, succeeded: 6, failed: 0, pending: 0, oversized: 0 })
      const committed = h.db.uploadsByStatus('p1', 'committed')
      const memberCount = committed
        .map((u) => h.db.subPieceMemberCids(u.subPieceCid).length)
        .reduce((sum, n) => sum + n, 0)
      expect(memberCount).toBe(6)
      expect(h.events.filter((e) => e === 'evict').length).toBeGreaterThan(0)
    } finally {
      h.db.close()
      await rm(h.dir, { recursive: true, force: true })
    }
  }, 15_000)

  it('a resumed run after full completion re-downloads nothing', async () => {
    const cids = [
      { cid: await cidFor('a'), delayMs: 0 },
      { cid: await cidFor('b'), delayMs: 0 },
    ]
    const h = await harness({ cids, budgetBytes: 100_000, packTargetBytes: 1000 })
    try {
      const first = await runMigrate(h.db, h.options, h.deps)
      expect(first.pieces.pending).toBe(0)
      h.events.length = 0

      // Second run over the same state: packed members must not be treated
      // as missing downloads, and nothing re-uploads.
      const again = await runMigrate(
        h.db,
        { ...h.options, stageMemberFn: async (cid) => Promise.reject(new Error(`must not re-download ${cid}`)) },
        h.deps
      )
      expect(again.pieces).toEqual(first.pieces)
      expect(h.events.filter((e) => e.startsWith('fetch:') || e.startsWith('store:'))).toEqual([])
    } finally {
      h.db.close()
      await rm(h.dir, { recursive: true, force: true })
    }
  })

  it('rebuilds a staged piece whose CAR no longer matches its recorded hash', async () => {
    const cids = [{ cid: await cidFor('rebuild-me'), delayMs: 0 }]
    const h = await harness({ cids, budgetBytes: 100_000, packTargetBytes: 1000 })
    try {
      const first = await runMigrate(h.db, h.options, h.deps)
      expect(first.pieces.succeeded).toBe(1)

      // Corrupt the run's outcome: pretend an uncommitted staged piece is on
      // disk with bytes that no longer hash to what assembly recorded.
      const subPieceCid = await cidFor('corrupt-bin')
      const carPath = join(h.options.carStore, `${subPieceCid}.car`)
      await writeFile(carPath, new Uint8Array(64))
      const source = await cidFor('victim')
      h.db.addCids([source])
      h.db.recordPieceSuccess(source, {
        pieceCid: await cidFor(`piece-${source}`),
        rawSize: 600,
        gateway: 'fake',
        url: `fake://gw/${source}`,
        memberCarPath: join(h.options.memberDir, `${source}.car`),
        memberSha256: 'sha',
      })
      h.db.recordBuiltSubPiece({
        subPieceCid,
        assembledCarLength: 64,
        targetSizeBytes: 1000,
        carPath,
        assembledSha256: 'not-the-real-hash',
        members: [{ cid: source, sha256: 'sha', rawSize: 600 }],
      })

      const anyCidStager: typeof h.options.stageMemberFn = async (cid, _gateways, memberDir, opts) => {
        opts?.onBytes?.(600)
        const memberCarPath = join(memberDir, `${cid}.car`)
        await writeFile(memberCarPath, new Uint8Array(600))
        return {
          cid,
          pieceCid: await cidFor(`piece-${cid}`),
          rawSize: 600,
          gateway: 'fake',
          url: `fake://gw/${cid}`,
          memberCarPath,
          memberSha256: 'sha',
        }
      }
      const second = await runMigrate(h.db, { ...h.options, stageMemberFn: anyCidStager }, h.deps)
      // The corrupt piece was deleted and its source CID re-downloaded into a
      // fresh piece; nothing is left pending.
      expect(h.db.subPieceByCid(subPieceCid)).toBeNull()
      expect(second.pieces.pending).toBe(0)
      expect(second.pieces.failed).toBe(0)
    } finally {
      h.db.close()
      await rm(h.dir, { recursive: true, force: true })
    }
  })

  it('reuses members already staged on disk when resuming', async () => {
    const staged = await cidFor('already-staged')
    const fresh = await cidFor('fresh')
    const h = await harness({
      cids: [
        { cid: staged, delayMs: 0 },
        { cid: fresh, delayMs: 0 },
      ],
      budgetBytes: 100_000,
      packTargetBytes: 1000,
      forbiddenFetches: [staged],
    })
    try {
      // Simulate the prior run: the member is verified, recorded, and on disk
      // with a hash that matches, so the sweep trusts it.
      const memberCarPath = join(h.options.memberDir, `${staged}.car`)
      const memberBytes = new Uint8Array(600)
      await writeFile(memberCarPath, memberBytes)
      h.db.recordPieceSuccess(staged, {
        pieceCid: await cidFor(`piece-${staged}`),
        rawSize: 600,
        gateway: 'fake',
        url: `fake://gw/${staged}`,
        memberCarPath,
        memberSha256: createHash('sha256').update(memberBytes).digest('hex'),
      })

      const summary = await runMigrate(h.db, h.options, h.deps)

      expect(h.events.filter((e) => e.startsWith('fetch:'))).toEqual([`fetch:${fresh}`])
      expect(summary.pieces).toEqual({ total: 2, succeeded: 2, failed: 0, pending: 0, oversized: 0 })
      expect(h.db.subPiecesNeedingUpload('p1')).toHaveLength(0)
    } finally {
      h.db.close()
      await rm(h.dir, { recursive: true, force: true })
    }
  })
})
