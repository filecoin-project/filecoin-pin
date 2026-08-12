import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_GATEWAYS } from '../../migrate/car-url.js'
import { MIGRATE_DATA_SET_METADATA, normalizeMigrateOptions, resolveMigratePaths } from '../../migrate/migrate.js'
import { DEFAULT_PACK_TARGET_BYTES, MAX_UPLOAD_BYTES } from '../../migrate/pack-cars.js'

describe('normalizeMigrateOptions', () => {
  it('defaults: streaming mode, egress none, manifest on, 1000MiB target', () => {
    const normalized = normalizeMigrateOptions({ mode: 'streaming' })
    expect(normalized.mode).toBe('streaming')
    // Egress defaults to none for migrate: bulk archival should not pay CDN
    // lockup by default (the add/import default is the inverse).
    expect(normalized.withCDN).toBe(false)
    expect(normalized.manifest).toBe(true)
    expect(normalized.packTargetBytes).toBe(Number(DEFAULT_PACK_TARGET_BYTES))
    expect(normalized.gateways).toEqual(DEFAULT_GATEWAYS)
    expect(normalized.assumedWindowMs).toBe(60 * 60_000)
    expect(normalized.copies).toBe(2)
  })

  it('opts into FilBeam egress only with --egress-provider beam', () => {
    expect(normalizeMigrateOptions({ egressProvider: 'beam' }).withCDN).toBe(true)
    expect(normalizeMigrateOptions({ egressProvider: 'none' }).withCDN).toBe(false)
  })

  it('honors --no-manifest and --mode staged', () => {
    const normalized = normalizeMigrateOptions({ mode: 'staged', manifest: false })
    expect(normalized.mode).toBe('staged')
    expect(normalized.manifest).toBe(false)
  })

  it('rejects a pack target above the per-piece upload cap', () => {
    expect(() => normalizeMigrateOptions({ packTargetSize: String(MAX_UPLOAD_BYTES + 1) })).toThrow(
      /exceeds the per-piece upload cap/
    )
  })

  it('parses human-readable pack target sizes', () => {
    expect(normalizeMigrateOptions({ packTargetSize: '512MiB' }).packTargetBytes).toBe(512 * 1024 * 1024)
  })

  it('rejects an unknown mode', () => {
    expect(() => normalizeMigrateOptions({ mode: 'parallel' })).toThrow(/unknown --mode/)
  })
})

describe('resolveMigratePaths', () => {
  it('defaults the DB and CAR staging under <dataDir>/migrate', () => {
    const paths = resolveMigratePaths('/data/filecoin-pin')
    expect(paths.migrateDir).toBe(join('/data/filecoin-pin', 'migrate'))
    expect(paths.dbPath).toBe(join('/data/filecoin-pin', 'migrate', 'migrate.db'))
    expect(paths.carStore).toBe(join('/data/filecoin-pin', 'migrate', 'cars'))
  })

  it('lets --db override the database path but keeps the staging dir', () => {
    const paths = resolveMigratePaths('/data/filecoin-pin', '/elsewhere/migrate.db')
    expect(paths.dbPath).toBe('/elsewhere/migrate.db')
    expect(paths.carStore).toBe(join('/data/filecoin-pin', 'migrate', 'cars'))
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
