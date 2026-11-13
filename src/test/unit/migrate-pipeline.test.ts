import { createHash } from 'node:crypto'
import { readdirSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keyspaceKeys as deriveGroupKey, writeTarget } from '@filoz/keysmith'
import type { Synapse } from '@filoz/synapse-sdk'
import { CarWriter } from '@ipld/car'
import toBuffer from 'it-to-buffer'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'
import { describe, expect, it } from 'vitest'
import { MigrationDB } from '../../migrate/db.js'
import type { DirectUploadDeps, UploadContextLike } from '../../migrate/direct-upload.js'
import { type GcsFetch, gcsSource, listGcsObjects } from '../../migrate/gcs.js'
import { migrateIncomplete } from '../../migrate/migrate.js'
import type { BinBuilder } from '../../migrate/pack-cars.js'
import { type MigrateRunOptions, runMigrate, stagingBudget } from '../../migrate/run-migrate.js'
import { stageMember } from '../../migrate/verify-car.js'
import { GROUP_KEY, OWNER } from '../fixtures/group-key-grants.js'

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
  /** The first commit is rejected by GC and the re-store after it fails. */
  gcThenStoreFails?: boolean
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

  let peakOnDisk = 0
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
    await writeFile(filePath, new Uint8Array(bin.totalRawSize))
    peakOnDisk = Math.max(peakOnDisk, (await dirBytes(memberDir)) + (await dirBytes(carStore)))
    return { pieceCid, assembledBytes: bin.totalRawSize, sha256: 'sha', filePath }
  }

  const ctx: UploadContextLike = {
    providerId: 'p1',
    serviceURL: 'fake://p1',
    dataSetId: '7',
    async store(_data, opts) {
      events.push(`store:${String(opts.pieceCid)}`)
      storeLanded()
      const stores = events.filter((e) => e.startsWith('store:')).length
      if (config.storeFailsOnce && stores === 1) throw new Error('provider down')
      if (config.gcThenStoreFails && stores === 2) throw new Error('provider down')
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
      if (config.gcThenStoreFails && events.filter((e) => e.startsWith('commit:')).length === 1) {
        throw new Error(`subPiece CID ${String(opts.pieces[0]?.pieceCid)} not found or does not belong to service x`)
      }
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
    contextForDataSet: async () => ctx,
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

  return { db, dir, events, options, deps, peakOnDisk: () => peakOnDisk }
}

async function dirBytes(dir: string): Promise<number> {
  let total = 0
  // A concurrent stager may unlink a temp CAR between readdir and stat.
  for (const entry of await readdir(dir)) total += (await stat(join(dir, entry)).catch(() => null))?.size ?? 0
  return total
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

  it('does not spin on a collected piece whose re-store was deferred', async () => {
    const cids = await Promise.all(['a', 'b', 'c', 'd'].map(async (t) => ({ cid: await cidFor(t) })))
    const h = await harness({ cids, budgetBytes: 2000, packTargetBytes: 600, gcThenStoreFails: true })
    try {
      await runMigrate(h.db, h.options, h.deps)

      expect(h.db.uploadsByStatus('p1', 'collected')).toHaveLength(0)
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

  it('fails before any download when the budget is under 3x the pack target', async () => {
    // The budget that split run 1's bins: new downloads stop at budget - 2 x target, before a bin can fill.
    const cids = await Promise.all(['a', 'b', 'c'].map(async (t) => ({ cid: await cidFor(t), rawSize: 300 })))
    const h = await harness({ cids, budgetBytes: 2200, packTargetBytes: 1000 })
    try {
      await expect(runMigrate(h.db, h.options, h.deps)).rejects.toThrow(
        /2\.1 KiB \(--max-staged-bytes\) is under 3x the 1000\.0 B pack target.*at least 3000 bytes.*at most 733 bytes/
      )
      expect(h.events).toEqual([])
    } finally {
      h.db.close()
      await rm(h.dir, { recursive: true, force: true })
    }
  })

  it('does not ship a partial bin while a download that would fill it is in flight', async () => {
    // Two slow downloads hold 1100 bytes, so the fast one's worker parks on the gate (3000 - 2 x 1000) with only 300 free.
    const cids = await Promise.all(['a', 'b', 'c', 'd'].map(async (t) => ({ cid: await cidFor(t), rawSize: 300 })))
    const h = await harness({ cids, budgetBytes: 3000, packTargetBytes: 1000 })
    try {
      // Workers take CIDs in pendingCids order; the first two are the slow 600 and 500 byte members.
      const [slowA, slowB] = h.db.pendingCids()
      const sizes: Record<string, number> = { [slowA ?? '']: 600, [slowB ?? '']: 500 }
      for (const c of cids) c.rawSize = sizes[c.cid] ?? 300
      const stage = h.options.stageMemberFn as NonNullable<typeof h.options.stageMemberFn>
      await runMigrate(
        h.db,
        {
          ...h.options,
          concurrency: 3,
          stageMemberFn: async (cid, ...rest) => {
            const member = await stage(cid, ...rest)
            if (cid === slowA || cid === slowB) await new Promise((resolve) => setTimeout(resolve, 200))
            return member
          },
        },
        h.deps
      )

      // The fast 300 byte member joins the 600 byte one instead of shipping alone.
      expect(h.events.find((e) => e.startsWith('build:'))).toBe('build:2')
    } finally {
      h.db.close()
      await rm(h.dir, { recursive: true, force: true })
    }
  }, 10_000)

  it('returns the bytes of a bin evicted before its pack call returns', async () => {
    // a and b pack as two bins in one call; c parks on the gate (3000 - 2 x 1000) until a's bin frees its 900 bytes.
    const cids = await Promise.all(['a', 'b', 'c'].map(async (t) => ({ cid: await cidFor(t), rawSize: 900 })))
    const h = await harness({ cids, budgetBytes: 3000, packTargetBytes: 1000 })
    try {
      const last = h.db.pendingCids()[2]
      let cStaged: () => void = () => undefined
      const cLanded = new Promise<void>((resolve) => {
        cStaged = resolve
      })
      const stage = h.options.stageMemberFn as NonNullable<typeof h.options.stageMemberFn>
      const build = h.options.buildBin as NonNullable<typeof h.options.buildBin>
      let builds = 0
      await runMigrate(
        h.db,
        {
          ...h.options,
          concurrency: 2,
          stageMemberFn: async (cid, ...rest) => {
            const member = await stage(cid, ...rest)
            if (cid === last) cStaged()
            return member
          },
          buildBin: async (...args) => {
            // Without the early bin's bytes back, c never starts and this holds the pack forever.
            if (++builds === 2) await cLanded
            return build(...args)
          },
        },
        h.deps
      )

      expect(h.events.indexOf(`fetch:${last}`)).toBeGreaterThan(h.events.indexOf('evict'))
    } finally {
      h.db.close()
      await rm(h.dir, { recursive: true, force: true })
    }
  }, 10_000)

  it('cycles a budget smaller than the migration instead of wedging', async () => {
    const cids = await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map(async (t) => ({ cid: await cidFor(t) })))
    // 3x the pack target is the minimum viable budget; the whole migration is
    // 3600 bytes, so completion proves eviction returns budget to the
    // download gate.
    const h = await harness({ cids, budgetBytes: 3000, packTargetBytes: 1000 })
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
      { cid: await cidFor('a'), rawSize: 1900 },
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
      // The whole CAR plus its assembly reservation over the 1000-byte pack target.
      const needed = ((2 * car.length - 1000) / 1024).toFixed(1)
      expect(summary.failures[0]?.error).toContain(`needs at least ${needed} KiB of staging`)
      expect(summary.failures[0]?.error).toContain('raise --max-staged-bytes')
    } finally {
      h.db.close()
      await rm(h.dir, { recursive: true, force: true })
    }
  }, 10_000)

  it('counts the encrypted temporary copy in the download ceiling error', async () => {
    // hardCap is 3000: 1200 bytes stage plain within it, but not alongside their encrypted copy.
    const { kk, descriptor } = await deriveGroupKey(OWNER, { owner: OWNER.address, keyspace: GROUP_KEY })
    const bucketFetch: GcsFetch = async () => new Response(new Uint8Array(1200))
    const h = await harness({ cids: [], budgetBytes: 4000, packTargetBytes: 1000 })
    try {
      h.db.addSources([{ url: 'gs://bk/a.bin', size: 1200, crc32c: 'a' }], GROUP_KEY)
      const source = gcsSource(h.db, bucketFetch, writeTarget(descriptor, kk))
      const summary = await runMigrate(h.db, { ...h.options, gateways: [], source }, h.deps)

      const needed = Number(/needs at least ([\d.]+) KiB/.exec(summary.failures[0]?.error ?? '')?.[1]) * 1024
      expect(needed).toBeGreaterThanOrEqual(2 * 1200)
    } finally {
      h.db.close()
      await rm(h.dir, { recursive: true, force: true })
    }
  }, 10_000)

  it('fails a member that cannot fit alongside its own solo CAR', async () => {
    // Over the pack target it ships solo: 2500 staged plus 2500 assembled exceeds the 4000 budget.
    const cids = [{ cid: await cidFor('big'), rawSize: 2500 }]
    const h = await harness({ cids, budgetBytes: 4000, packTargetBytes: 1000 })
    try {
      const summary = await runMigrate(h.db, h.options, h.deps)

      expect(summary.failures[0]?.error).toContain('raise --max-staged-bytes')
      expect(h.events.filter((e) => e.startsWith('build:'))).toHaveLength(0)
    } finally {
      h.db.close()
      await rm(h.dir, { recursive: true, force: true })
    }
  }, 10_000)

  it('holds a solo assembly reservation against concurrent downloads', async () => {
    // big passes alone (5000 + 4000 extra <= 9240 ceiling); small must not take the space big's solo CAR needs.
    const [big, small] = (await Promise.all([cidFor('big'), cidFor('small')])).sort()
    if (big == null || small == null) throw new Error('unreachable')
    const h = await harness({
      cids: [
        { cid: big, rawSize: 5000 },
        { cid: small, rawSize: 1000 },
      ],
      budgetBytes: 10_240,
      packTargetBytes: 1000,
    })
    let smallSettled: () => void = () => undefined
    const smallFirstTry = new Promise<void>((resolve) => {
      smallSettled = resolve
    })
    const stage = h.options.stageMemberFn ?? stageMember
    const build = h.options.buildBin
    try {
      const summary = await runMigrate(
        h.db,
        {
          ...h.options,
          stageMemberFn: async (c, gateways, dir, opts) => {
            try {
              return await stage(c, gateways, dir, opts)
            } finally {
              if (c === small) smallSettled()
            }
          },
          buildBin: async (bin, ...rest) => {
            if (build == null) throw new Error('unreachable')
            if (bin.memberCids.includes(big)) await smallFirstTry
            return build(bin, ...rest)
          },
        },
        h.deps
      )

      expect(summary.pieces).toEqual({ total: 2, succeeded: 2, failed: 0, pending: 0, oversized: 0 })
      expect(h.peakOnDisk()).toBeLessThanOrEqual(10_240)
    } finally {
      h.db.close()
      await rm(h.dir, { recursive: true, force: true })
    }
  }, 10_000)

  it('stops instead of hanging when the only free member is too small to pack', async () => {
    // b downloads first and is under the upload floor, so a non-final pack
    // builds nothing and frees nothing; a cannot fit until b is gone.
    const cids = [
      { cid: await cidFor('a'), rawSize: 1980 },
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

  it('imports bucket objects and skips them on the next daily run', async () => {
    const enc = new TextEncoder()
    const objects: Record<string, Uint8Array<ArrayBuffer>> = {
      'a.pdf': enc.encode('a'.repeat(700)),
      'b.tiff': enc.encode('b'.repeat(900)),
      'copy-of-a.pdf': enc.encode('a'.repeat(700)),
    }
    const reads: string[] = []
    const bucketFetch: GcsFetch = async (url) => {
      const name = decodeURIComponent(new URL(url).pathname.split('/o/')[1] ?? '')
      if (name === '') {
        return Response.json({ items: Object.keys(objects).map((n) => ({ name: n, size: '1', crc32c: `crc-${n}` })) })
      }
      reads.push(name)
      return new Response(objects[name] ?? null)
    }
    const h = await harness({ cids: [], budgetBytes: 100_000, packTargetBytes: 1000 })
    try {
      const run = async () => {
        h.db.addSources(await listGcsObjects({ bucket: 'bk', prefix: '' }, bucketFetch))
        return runMigrate(h.db, { ...h.options, gateways: [], source: gcsSource(h.db, bucketFetch) }, h.deps)
      }
      const first = await run()
      expect(first.pieces).toMatchObject({ total: 2, succeeded: 2, failed: 0, pending: 0 })
      expect(migrateIncomplete(first)).toBe(false)
      const manifest = h.db.sources()
      expect(manifest.map((s) => s.url)).toEqual(['gs://bk/a.pdf', 'gs://bk/b.tiff', 'gs://bk/copy-of-a.pdf'])
      // Same content, same CID: one piece row, both names in the manifest.
      expect(manifest[2]?.cid).toBe(manifest[0]?.cid)
      expect(await readdir(h.options.memberDir)).toEqual([])

      reads.length = 0
      h.events.length = 0
      await run()
      expect(reads).toEqual([])
      expect(h.events.filter((e) => e.startsWith('store:'))).toEqual([])
    } finally {
      h.db.close()
      await rm(h.dir, { recursive: true, force: true })
    }
  })

  it('keeps concurrent bucket imports inside the budget while they stream', async () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f']
    const bucketFetch: GcsFetch = async (url) => {
      const name = decodeURIComponent(new URL(url).pathname.split('/o/')[1] ?? '')
      let sent = 0
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await new Promise((resolve) => setTimeout(resolve, 1))
            if (sent === 9) return controller.close()
            sent++
            controller.enqueue(new Uint8Array(10_000).fill(name.charCodeAt(0) + sent))
          },
        })
      )
    }
    // Hard cap 200 KB; six 90 KB objects on four workers would stage 360 KB if counted after import.
    const h = await harness({ cids: [], budgetBytes: 300_000, packTargetBytes: 100_000 })
    const memberBytes = (): number =>
      readdirSync(h.options.memberDir).reduce(
        (n, f) => n + (statSync(join(h.options.memberDir, f), { throwIfNoEntry: false })?.size ?? 0),
        0
      )
    let peak = 0
    const source = gcsSource(h.db, bucketFetch)
    const recordSuccess: typeof source.recordSuccess = (url, member) => {
      peak = Math.max(peak, memberBytes())
      return h.db.recordSourceSuccess(url, member)
    }
    try {
      h.db.addSources(names.map((n) => ({ url: `gs://bk/${n}`, size: 90_000, crc32c: n })))
      const summary = await runMigrate(
        h.db,
        { ...h.options, gateways: [], source: { ...source, recordSuccess } },
        h.deps
      )
      expect(summary.pieces).toMatchObject({ total: 6, succeeded: 6 })
      expect(peak).toBeLessThanOrEqual(200_000)
    } finally {
      h.db.close()
      await rm(h.dir, { recursive: true, force: true })
    }
  }, 10_000)

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
