import { join } from 'node:path'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { describe, expect, it } from 'vitest'
import { DEFAULT_GATEWAYS } from '../../migrate/car-url.js'
import {
  dedupeCids,
  MIGRATE_DATA_SET_METADATA,
  normalizeMigrateOptions,
  resolveMigratePaths,
} from '../../migrate/migrate.js'
import { DEFAULT_PACK_TARGET_BYTES, MAX_UPLOAD_BYTES } from '../../migrate/pack-cars.js'

describe('normalizeMigrateOptions', () => {
  it('defaults: egress none, 1000MiB target, no explicit staging cap', () => {
    const normalized = normalizeMigrateOptions({})
    // Egress defaults to none for migrate: bulk archival should not pay CDN
    // lockup by default (the add/import default is the inverse).
    expect(normalized.withCDN).toBe(false)
    expect(normalized.packTargetBytes).toBe(Number(DEFAULT_PACK_TARGET_BYTES))
    expect(normalized.gateways).toEqual(DEFAULT_GATEWAYS)
    expect(normalized.assumedWindowMs).toBe(60 * 60_000)
    expect(normalized.copies).toBe(2)
    expect(normalized.maxStagedBytes).toBeNull()
  })

  it('opts into FilBeam egress only with --egress-provider beam', () => {
    expect(normalizeMigrateOptions({ egressProvider: 'beam' }).withCDN).toBe(true)
    expect(normalizeMigrateOptions({ egressProvider: 'none' }).withCDN).toBe(false)
  })

  it('parses human-readable sizes for the pack target and staging cap', () => {
    const normalized = normalizeMigrateOptions({ packTargetSize: '512MiB', maxStagedBytes: '8GiB' })
    expect(normalized.packTargetBytes).toBe(512 * 1024 * 1024)
    expect(normalized.maxStagedBytes).toBe(8 * 1024 * 1024 * 1024)
  })

  it('rejects a pack target above the per-piece upload cap', () => {
    expect(() => normalizeMigrateOptions({ packTargetSize: String(MAX_UPLOAD_BYTES + 1) })).toThrow(
      /exceeds the per-piece upload cap/
    )
  })

  it('rejects a staging cap too small to assemble one piece', () => {
    expect(() => normalizeMigrateOptions({ packTargetSize: '100MiB', maxStagedBytes: '150MiB' })).toThrow(/too small/)
  })
})

describe('resolveMigratePaths', () => {
  it('defaults the DB, member, and piece staging under <dataDir>/migrate', () => {
    const paths = resolveMigratePaths('/data/filecoin-pin')
    expect(paths.migrateDir).toBe(join('/data/filecoin-pin', 'migrate'))
    expect(paths.dbPath).toBe(join('/data/filecoin-pin', 'migrate', 'migrate.db'))
    expect(paths.memberDir).toBe(join('/data/filecoin-pin', 'migrate', 'members'))
    expect(paths.carStore).toBe(join('/data/filecoin-pin', 'migrate', 'cars'))
  })

  it('lets --db override the database path but keeps the staging dirs', () => {
    const paths = resolveMigratePaths('/data/filecoin-pin', '/elsewhere/migrate.db')
    expect(paths.dbPath).toBe('/elsewhere/migrate.db')
    expect(paths.carStore).toBe(join('/data/filecoin-pin', 'migrate', 'cars'))
  })
})

describe('dedupeCids', () => {
  it('collapses CIDv0 and CIDv1 encodings of the same content', async () => {
    const digest = await sha256.digest(new TextEncoder().encode('same dag'))
    const v0Cid = CID.createV0(digest)
    const v0 = v0Cid.toString()
    const v1 = v0Cid.toV1().toString()
    const { unique, duplicates } = dedupeCids([v0, v1])
    expect(unique).toEqual([v0])
    expect(duplicates).toEqual([v1])
  })

  it('keeps unparseable lines so the download stage reports them', () => {
    const { unique, duplicates } = dedupeCids(['not-a-cid', 'not-a-cid'])
    expect(unique).toEqual(['not-a-cid'])
    expect(duplicates).toEqual(['not-a-cid'])
  })
})

describe('MIGRATE_DATA_SET_METADATA', () => {
  it('carries the exact keys that keep migrate data sets disjoint from add/import', () => {
    expect(MIGRATE_DATA_SET_METADATA).toEqual({
      withIPFSIndexing: '',
      source: 'filecoin-pin',
      migrate: 'true',
    })
  })
})
