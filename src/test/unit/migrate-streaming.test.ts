import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Synapse } from '@filoz/synapse-sdk'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'
import { describe, expect, it } from 'vitest'
import { MigrationDB } from '../../migrate/db.js'
import type { DirectUploadDeps, UploadContextLike } from '../../migrate/direct-upload.js'
import type { BinBuilder } from '../../migrate/pack-cars.js'
import type { PieceFetcher } from '../../migrate/plan.js'
import { type MigrateRunOptions, runMigrate } from '../../migrate/run-migrate.js'

// Exercises the two feed modes into the commit batcher: staged packs (and
// uploads) only after every CID finished the commP pass; streaming packs and
// stores pieces while later CIDs are still downloading.

const fakeSynapse = { chain: { name: 'calibration' } } as unknown as Synapse

async function cidFor(text: string): Promise<string> {
  const digest = await sha256.digest(new TextEncoder().encode(text))
  return CID.createV1(raw.code, digest).toString()
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface Harness {
  db: MigrationDB
  dir: string
  events: string[]
  options: MigrateRunOptions
  deps: DirectUploadDeps
}

async function harness(mode: 'streaming' | 'staged', cids: Array<{ cid: string; delayMs: number }>): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'fp-migrate-stream-'))
  const db = new MigrationDB(join(dir, 'migrate.db'), 'calibration')
  db.addCids(cids.map((c) => c.cid))
  const events: string[] = []

  const fetchPiece: PieceFetcher = async (cid) => {
    const entry = cids.find((c) => c.cid === cid)
    if (entry == null) throw new Error(`unexpected cid ${cid}`)
    await sleep(entry.delayMs)
    events.push(`fetch:${cid}`)
    return {
      cid,
      pieceCid: await cidFor(`piece-${cid}`),
      rawSize: 600,
      gateway: 'fake',
      url: `fake://gw/${cid}`,
      memberSha256: 'sha',
    }
  }

  const buildBin: BinBuilder = async (bin, carStore) => {
    const pieceCid = await cidFor(`bin-${bin.memberCids.join('+')}`)
    events.push(`build:${bin.memberCids.length}`)
    return {
      pieceCid,
      assembledBytes: bin.totalRawSize,
      sha256: 'sha',
      filePath: join(carStore, `${pieceCid}.car`),
    }
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
    evictCar: async () => {
      // eviction is irrelevant to feed-order assertions
    },
    txLanded: async () => false,
    fetchAddPiecesEvent: async () => null,
  }

  const options: MigrateRunOptions = {
    synapse: fakeSynapse,
    gateways: ['fake://gw'],
    carStore: join(dir, 'cars'),
    mode,
    packTargetBytes: 1000,
    concurrency: 4,
    copies: 1,
    manifest: false,
    fetchPiece,
    buildBin,
  }

  return { db, dir, events, options, deps }
}

describe('runMigrate feed modes', () => {
  it('streaming: packs and stores pieces while later CIDs still download', async () => {
    const cids = [
      { cid: await cidFor('a'), delayMs: 0 },
      { cid: await cidFor('b'), delayMs: 0 },
      { cid: await cidFor('c'), delayMs: 400 },
    ]
    const h = await harness('streaming', cids)
    try {
      const summary = await runMigrate(h.db, h.options, h.deps)

      const firstStore = h.events.findIndex((e) => e.startsWith('store:'))
      const lastFetch = h.events.lastIndexOf(`fetch:${cids[2]?.cid}`)
      expect(firstStore).toBeGreaterThanOrEqual(0)
      // The slow third CID must still have been downloading when the first
      // packed piece hit the provider: the point of streaming mode.
      expect(firstStore).toBeLessThan(lastFetch)

      expect(summary.pieces).toEqual({ total: 3, succeeded: 3, failed: 0 })
      expect(h.db.uploadsByStatus('p1', 'committed').length).toBeGreaterThan(0)
      expect(h.db.subPiecesNeedingUpload('p1')).toHaveLength(0)
    } finally {
      h.db.close()
      await rm(h.dir, { recursive: true, force: true })
    }
  })

  it('staged: every CID finishes the commP pass before anything is packed or stored', async () => {
    const cids = [
      { cid: await cidFor('a'), delayMs: 0 },
      { cid: await cidFor('b'), delayMs: 0 },
      { cid: await cidFor('c'), delayMs: 100 },
    ]
    const h = await harness('staged', cids)
    try {
      const summary = await runMigrate(h.db, h.options, h.deps)

      const lastFetch = h.events.map((e) => e.startsWith('fetch:')).lastIndexOf(true)
      const firstBuild = h.events.findIndex((e) => e.startsWith('build:'))
      const firstStore = h.events.findIndex((e) => e.startsWith('store:'))
      expect(firstBuild).toBeGreaterThan(lastFetch)
      expect(firstStore).toBeGreaterThan(lastFetch)

      expect(summary.pieces).toEqual({ total: 3, succeeded: 3, failed: 0 })
      expect(h.db.subPiecesNeedingUpload('p1')).toHaveLength(0)
    } finally {
      h.db.close()
      await rm(h.dir, { recursive: true, force: true })
    }
  })
})
