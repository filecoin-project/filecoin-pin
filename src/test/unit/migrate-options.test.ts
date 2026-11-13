import { join } from 'node:path'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { describe, expect, it } from 'vitest'
import {
  dedupeCids,
  MIGRATE_DATA_SET_METADATA,
  normalizeMigrateOptions,
  resolveMigratePaths,
} from '../../migrate/migrate.js'
import { DEFAULT_PACK_TARGET_BYTES, MAX_UPLOAD_BYTES } from '../../migrate/pack-cars.js'

describe('normalizeMigrateOptions', () => {
  it('defaults: egress none, 1000MiB target, no explicit staging cap', () => {
    const normalized = normalizeMigrateOptions({ gateway: ['https://gw.example'] })
    // Egress defaults to none for migrate: bulk archival should not pay CDN
    // lockup by default (the add/import default is the inverse).
    expect(normalized.withCDN).toBe(false)
    expect(normalized.packTargetBytes).toBe(Number(DEFAULT_PACK_TARGET_BYTES))
    expect(normalized.gateways).toEqual(['https://gw.example'])
    expect(normalized.assumedWindowMs).toBe(60 * 60_000)
    expect(normalized.copies).toBe(2)
    expect(normalized.maxStagedBytes).toBeNull()
  })

  it('requires at least one --gateway', () => {
    expect(() => normalizeMigrateOptions({})).toThrow(/--gateway/)
  })

  it('needs no --gateway for a gs:// source, and refuses one', () => {
    expect(normalizeMigrateOptions({}, true).gateways).toEqual([])
    expect(() => normalizeMigrateOptions({ gateway: ['https://gw.example'] }, true)).toThrow(/--gateway/)
  })

  it('refuses --encrypt for a CID list: that content is already public on IPFS', () => {
    expect(() => normalizeMigrateOptions({ gateway: ['https://gw.example'], encrypt: true })).toThrow(
      /--encrypt applies only to a gs:\/\/ source/
    )
    expect(normalizeMigrateOptions({ encrypt: true }, true).encrypt).toBe(true)
  })

  it('takes --data-set-id with --encrypt, like add --encrypt', () => {
    expect(normalizeMigrateOptions({ encrypt: true, dataSetIds: ['7'] }, true).encrypt).toBe(true)
  })

  it('rejects a --gateway that is not an http(s) URL', () => {
    expect(() => normalizeMigrateOptions({ gateway: ['trustless-gateway.link'] })).toThrow(/--gateway/)
    expect(() => normalizeMigrateOptions({ gateway: ['localhost:8080'] })).toThrow(/--gateway/)
  })

  it('opts into FilBeam egress only with --egress-provider beam', () => {
    expect(normalizeMigrateOptions({ gateway: ['https://gw.example'], egressProvider: 'beam' }).withCDN).toBe(true)
    expect(normalizeMigrateOptions({ gateway: ['https://gw.example'], egressProvider: 'none' }).withCDN).toBe(false)
  })

  it('parses human-readable sizes for the pack target and staging cap', () => {
    const normalized = normalizeMigrateOptions({
      gateway: ['https://gw.example'],
      packTargetSize: '512MiB',
      maxStagedBytes: '8GiB',
    })
    expect(normalized.packTargetBytes).toBe(512 * 1024 * 1024)
    expect(normalized.maxStagedBytes).toBe(8 * 1024 * 1024 * 1024)
  })

  it('rejects a pack target above the per-piece upload cap', () => {
    expect(() =>
      normalizeMigrateOptions({ gateway: ['https://gw.example'], packTargetSize: String(MAX_UPLOAD_BYTES + 1) })
    ).toThrow(/exceeds the per-piece upload cap/)
  })

  it('rejects a staging cap under 3x the pack target', () => {
    expect(() =>
      normalizeMigrateOptions({ gateway: ['https://gw.example'], packTargetSize: '100MiB', maxStagedBytes: '250MiB' })
    ).toThrow(/under 3x the pack target/)
  })
})

describe('resolveMigratePaths', () => {
  const scope = { network: 'calibration', owner: '0xABC' }

  it('keeps one DB per data dir and stages files per network and owner', () => {
    const paths = resolveMigratePaths('/data/filecoin-pin', scope)
    expect(paths.dbPath).toBe(join('/data/filecoin-pin', 'migrate', 'migrate.db'))
    expect(paths.stagingDir).toBe(join('/data/filecoin-pin', 'migrate', 'calibration', '0xabc'))
    expect(paths.memberDir).toBe(join(paths.stagingDir, 'members'))
    expect(paths.carStore).toBe(join(paths.stagingDir, 'cars'))
  })

  it('gives two owners on one network disjoint staging dirs', () => {
    const a = resolveMigratePaths('/data', scope)
    const b = resolveMigratePaths('/data', { ...scope, owner: '0xDEF' })
    expect(a.dbPath).toBe(b.dbPath)
    expect(a.stagingDir).not.toBe(b.stagingDir)
  })

  it('gives a gs:// source its own default DB and staging dirs', () => {
    const cids = resolveMigratePaths('/data', scope)
    const gcs = resolveMigratePaths('/data', scope, undefined, true)
    expect(gcs.dbPath).toBe(join('/data', 'migrate', 'migrate-gcs.db'))
    expect(gcs.memberDir.startsWith(cids.memberDir)).toBe(false)
    expect(gcs.carStore.startsWith(cids.carStore)).toBe(false)
    expect(resolveMigratePaths('/data', scope, '/elsewhere/x.db', true).dbPath).toBe('/elsewhere/x.db')
  })

  it('lets --db override the database path but keeps the staging dirs', () => {
    const paths = resolveMigratePaths('/data/filecoin-pin', scope, '/elsewhere/migrate.db')
    expect(paths.dbPath).toBe('/elsewhere/migrate.db')
    expect(paths.carStore).toBe(join('/data/filecoin-pin', 'migrate', 'calibration', '0xabc', 'cars'))
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
