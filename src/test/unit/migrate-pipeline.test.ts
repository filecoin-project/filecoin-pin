import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Synapse } from '@filoz/synapse-sdk'
import { CarWriter } from '@ipld/car'
import toBuffer from 'it-to-buffer'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'
import { describe, expect, it } from 'vitest'
import { MigrationDB } from '../../migrate/db.js'
import type { DirectUploadDeps, UploadContextLike } from '../../migrate/direct-upload.js'
import { migrateIncomplete } from '../../migrate/migrate.js'
import type { BinBuilder } from '../../migrate/pack-cars.js'
import { type MigrateRunOptions, runMigrate, stagingBudget } from '../../migrate/run-migrate.js'
import { stageMember } from '../../migrate/verify-car.js'

// Exercises the budget-clocked pipeline end to end with fake network edges:
// downloads overlap uploads, a small budget cycles instead of wedging, and a
// resumed run reuses members already staged on disk.

const fakeSynapse = { chain: { name: 'calibration' } } as unknown as Synapse

async function cidFor(text: string): Promise<string> {
  const digest = await sha256.digest(new TextEncoder().encode(text))
  return CID.createV1(raw.code, digest).toString()
}

interface HarnessOptions {
  /** `afterFirstStore` holds that CID's download until the first store() lands. */
  cids: Array<{ cid: string; rawSize?: number; afterFirstStore?: boolean }>
  budgetBytes: number
  packTargetBytes: number
  /** CIDs the stager must never be asked for (already staged on disk). */
  forbiddenFetches?: string[]
  /** The first store() on the provider fails like a dropped connection. */
  storeFailsOnce?: boolean
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
  let storeLanded: () => void = () => undefined
  const firstStore = new Promise<void>((resolve) => {
    storeLanded = resolve
  })

  const attempts = new Map<string, number>()
  const stageMemberFn: typeof stageMember = async (cid, _gateways, dirForMembers, opts) => {
    const entry = config.cids.find((c) => c.cid === cid)
    if (entry == null) throw new Error(`unexpected cid ${cid}`)
    // A retry loop spins on microtasks and would starve the test timeout; fail it instead.
    const attempt = (attempts.get(cid) ?? 0) + 1
    attempts.set(cid, attempt)
    if (attempt > 10) throw new Error(`re-download loop on ${cid}`)
    if (config.forbiddenFetches?.includes(cid)) throw new Error(`must not re-download ${cid}`)
    if (entry.afterFirstStore) await firstStore
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
      storeLanded()
      if (config.storeFailsOnce && events.filter((e) => e.startsWith('store:')).length === 1) {
        throw new Error('provider down')
      }
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
    stagingDir: dir,
    maxStagedBytes: config.budgetBytes,
    copies: 1,
    stageMemberFn,
    buildBin,
  }

  return { db, dir, events, options, deps }
}

describe('stagingBudget', () => {
  it('counts already-staged bytes as part of the disk budget, since free space excludes them', () => {
    expect(stagingBudget(100, 50, null)).toBe(120)
  })

  it('caps at the explicit limit', () => {
    expect(stagingBudget(100, 50, 100)).toBe(100)
  })
})

describe('runMigrate pipeline', () => {
  it('uploads packed pieces while later CIDs still download', async () => {
    const cids = [
      { cid: await cidFor('a') },
      { cid: await cidFor('b') },
      { cid: await cidFor('c'), afterFirstStore: true },
    ]
    const h = await harness({ cids, budgetBytes: 100_000, packTargetBytes: 1000 })
    try {
      const summary = await runMigrate(h.db, h.options, h.deps)

      const firstStore = h.events.findIndex((e) => e.startsWith('store:'))
      const lastFetch = h.events.lastIndexOf(`fetch:${cids[2]?.cid}`)
      expect(firstStore).toBeGreaterThanOrEqual(0)
      // The third CID could not finish downloading until the first packed
      // piece hit the provider: the two stages overlapped.
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

  it('waits for the packer instead of spinning when every built piece failed to store', async () => {
    // The first piece's store fails and is deferred; the second CID is still
    // downloading. The uploader must park until the packer delivers more, not
    // poll the deferred piece on the microtask queue and starve the download.
    const cids = [{ cid: await cidFor('a') }, { cid: await cidFor('b'), afterFirstStore: true }]
    const h = await harness({ cids, budgetBytes: 100_000, packTargetBytes: 600, storeFailsOnce: true })
    try {
      const summary = await runMigrate(h.db, h.options, h.deps)

      expect(summary.pieces.succeeded).toBe(2)
      expect(h.db.subPiecesNeedingUpload('p1')).toHaveLength(0)
      expect(h.events.filter((e) => e.startsWith('store:'))).toHaveLength(3)
    } finally {
      h.db.close()
      await rm(h.dir, { recursive: true, force: true })
    }
  }, 10_000)

  it('names each failed CID with its error in the summary', async () => {
    const cids = [{ cid: await cidFor('ok') }, { cid: 'notacid' }]
    const h = await harness({ cids, budgetBytes: 100_000, packTargetBytes: 1000 })
    try {
      const summary = await runMigrate(
        h.db,
        {
          ...h.options,
          stageMemberFn: async (cid, ...rest) => {
            if (cid === 'notacid') throw new Error('not a valid CID: nope')
            return (h.options.stageMemberFn as NonNullable<typeof h.options.stageMemberFn>)(cid, ...rest)
          },
        },
        h.deps
      )

      expect(summary.pieces.failed).toBe(1)
      expect(summary.failures).toEqual([{ cid: 'notacid', error: 'not a valid CID: nope', category: 'other' }])
    } finally {
      h.db.close()
      await rm(h.dir, { recursive: true, force: true })
    }
  })

  it('names CIDs marked oversized by an earlier run in the summary', async () => {
    const cids = [{ cid: await cidFor('big') }]
    const h = await harness({ cids, budgetBytes: 100_000, packTargetBytes: 1000 })
    try {
      h.db.markOversized([cids[0]?.cid ?? ''])
      const summary = await runMigrate(h.db, h.options, h.deps)

      expect(summary.pieces.oversized).toBe(1)
      expect(summary.overCap).toEqual([cids[0]?.cid])
      expect(migrateIncomplete(summary)).toBe(true)
    } finally {
      h.db.close()
      await rm(h.dir, { recursive: true, force: true })
    }
  })

  it('reports downloaded CIDs whose packing failed, so the run cannot exit 0', async () => {
    const cids = [{ cid: await cidFor('a') }]
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
    const cids = await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map(async (t) => ({ cid: await cidFor(t) })))
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

  it('waits for space instead of re-downloading a member that overran the budget', async () => {
    // a fits the budget alone but not on top of b's 500 staged bytes (b
    // downloads first). a must wait for b to ship and free space, not restart.
    const cids = [
      { cid: await cidFor('a'), rawSize: 2800 },
      { cid: await cidFor('b'), rawSize: 500 },
    ]
    const h = await harness({ cids, budgetBytes: 4000, packTargetBytes: 1000 })
    try {
      const summary = await runMigrate(h.db, h.options, h.deps)

      expect(summary.pieces).toEqual({ total: 2, succeeded: 2, failed: 0, pending: 0, oversized: 0 })
    } finally {
      h.db.close()
      await rm(h.dir, { recursive: true, force: true })
    }
  }, 10_000)

  it('fails a member bigger than the download ceiling instead of waiting on it', async () => {
    // hardCap is 4000 - 1000; the real stager refunds the overrun bytes before rethrowing.
    const bytes = new Uint8Array(3500)
    const cid = CID.createV1(raw.code, await sha256.digest(bytes))
    const { writer, out } = CarWriter.create([cid])
    const carP = toBuffer(out)
    await writer.put({ cid, bytes })
    await writer.close()
    const car = await carP
    const h = await harness({ cids: [{ cid: cid.toString() }], budgetBytes: 4000, packTargetBytes: 1000 })
    try {
      const summary = await runMigrate(
        h.db,
        {
          ...h.options,
          stageMemberFn: (c, gateways, dir, opts) =>
            stageMember(c, gateways, dir, opts, async () => ({ url: 'fake://gw', body: new Blob([car]).stream() })),
        },
        h.deps
      )

      expect(summary.failures).toHaveLength(1)
      expect(summary.failures[0]?.error).toContain('raise --max-staged-bytes')
    } finally {
      h.db.close()
      await rm(h.dir, { recursive: true, force: true })
    }
  }, 10_000)

  it('stops instead of hanging when the only free member is too small to pack', async () => {
    // b downloads first and is under the upload floor, so a non-final pack
    // builds nothing and frees nothing; a cannot fit until b is gone.
    const cids = [
      { cid: await cidFor('a'), rawSize: 2950 },
      { cid: await cidFor('b'), rawSize: 100 },
    ]
    const h = await harness({ cids, budgetBytes: 4000, packTargetBytes: 1000 })
    try {
      const summary = await runMigrate(h.db, h.options, h.deps)

      expect(summary.pieces).toEqual({ total: 2, succeeded: 0, failed: 1, pending: 1, oversized: 0 })
    } finally {
      h.db.close()
      await rm(h.dir, { recursive: true, force: true })
    }
  }, 10_000)

  it('a resumed run after full completion re-downloads nothing', async () => {
    const cids = [{ cid: await cidFor('a') }, { cid: await cidFor('b') }]
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

  it.each([
    ['no longer matches its recorded hash', true],
    ['is missing from disk', false],
  ])('rebuilds a staged piece whose CAR %s', async (_label, carOnDisk) => {
    const cids = [{ cid: await cidFor('rebuild-me') }]
    const h = await harness({ cids, budgetBytes: 100_000, packTargetBytes: 1000 })
    try {
      const first = await runMigrate(h.db, h.options, h.deps)
      expect(first.pieces.succeeded).toBe(1)

      // Pretend an uncommitted staged piece was recorded whose file is now
      // corrupt (bytes no longer hash to what assembly recorded) or gone.
      const subPieceCid = await cidFor('corrupt-bin')
      const carPath = join(h.options.carStore, `${subPieceCid}.car`)
      if (carOnDisk) await writeFile(carPath, new Uint8Array(64))
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
      // The bad piece was deleted and its source CID re-downloaded into a
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
      cids: [{ cid: staged }, { cid: fresh }],
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
