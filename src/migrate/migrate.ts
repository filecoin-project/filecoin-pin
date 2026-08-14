/**
 * CLI-facing migrate runner: option normalization, Synapse initialization,
 * payment validation, staging-budget setup, and the state DB lifecycle
 * around `runMigrate`.
 */

import { mkdir, readFile, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { CID } from 'multiformats/cid'
import pc from 'picocolors'
import pino from 'pino'
import { CliFatal, isCliFatal } from '../common/cli-errors.js'
import { validatePaymentSetup } from '../common/upload-flow.js'
import { getDataDirectory } from '../config.js'
import { DEFAULT_COPIES, IPFS_INDEXED_METADATA } from '../core/synapse/constants.js'
import { APPLICATION_SOURCE, getClientAddress, initializeSynapse } from '../core/synapse/index.js'
import { getNetworkSlug } from '../core/upload/index.js'
import { parseCLIAuth, parseContextSelectionOptions } from '../utils/cli-auth.js'
import { cancel, createSpinner, intro, outro } from '../utils/cli-helpers.js'
import { log as cliLog } from '../utils/cli-logger.js'
import { chainSupportsFilbeam, printEgressNotice } from '../utils/cli-options-egress.js'
import { DEFAULT_GATEWAYS } from './car-url.js'
import { MigrationDB } from './db.js'
import { DEFAULT_ASSUMED_WINDOW_MS } from './gc-window.js'
import { formatBytes } from './metrics.js'
import { DEFAULT_PACK_TARGET_BYTES, MAX_UPLOAD_BYTES } from './pack-cars.js'
import { type MigrateSummary, runMigrate } from './run-migrate.js'
import { log, parseCidList, parsePositiveInt, parseSize } from './util.js'

/**
 * Data-set metadata for migrate runs. Exact key-count matching makes migrate
 * data sets disjoint from add/import data sets by default (intended);
 * `--data-set-id` targets an existing set regardless of its metadata.
 */
export const MIGRATE_DATA_SET_METADATA = {
  ...IPFS_INDEXED_METADATA,
  source: APPLICATION_SOURCE,
  migrate: 'true',
} as const

/** Fraction of the staging filesystem's free space the budget may claim. */
const BUDGET_FREE_SPACE_FRACTION = 0.8

/** Migrate options after CLI-flag normalization and validation. */
export interface NormalizedMigrateOptions {
  packTargetBytes: number
  concurrency: number
  assumedWindowMs: number
  copies: number
  gateways: string[]
  withCDN: boolean
  /** Explicit staging cap; null means derive from free disk space. */
  maxStagedBytes: number | null
}

/**
 * Validate and normalize the migrate-specific Commander options. Pure, so
 * the flag defaults (egress none, gateway list, pack target) are
 * unit-testable without a network.
 */
export function normalizeMigrateOptions(options: Record<string, unknown>): NormalizedMigrateOptions {
  const packTargetBytes = Number(parseSize(String(options.packTargetSize ?? DEFAULT_PACK_TARGET_BYTES.toString())))
  if (packTargetBytes > MAX_UPLOAD_BYTES) {
    throw new Error(`--pack-target-size ${packTargetBytes} exceeds the per-piece upload cap ${MAX_UPLOAD_BYTES}`)
  }
  const concurrency = parsePositiveInt(String(options.concurrency ?? '8'), '--concurrency')
  const assumedWindowMinutes =
    options.assumedWindowMinutes == null
      ? DEFAULT_ASSUMED_WINDOW_MS / 60_000
      : parsePositiveInt(String(options.assumedWindowMinutes), '--assumed-window-minutes')
  const copies = options.copies == null ? DEFAULT_COPIES : Number(options.copies)
  const gateways =
    Array.isArray(options.gateway) && options.gateway.length > 0 ? (options.gateway as string[]) : DEFAULT_GATEWAYS
  // Bulk archival should not pay CDN lockup by default; `--egress-provider
  // beam` opts in (the add/import default is the inverse).
  const egressProvider = (options.egressProvider as string | undefined) ?? 'none'
  const maxStagedBytes = options.maxStagedBytes == null ? null : Number(parseSize(String(options.maxStagedBytes)))
  if (maxStagedBytes != null && maxStagedBytes < 2 * packTargetBytes) {
    throw new Error(
      `--max-staged-bytes ${formatBytes(maxStagedBytes)} is too small: assembling one piece needs at least ` +
        `2x the pack target (${formatBytes(2 * packTargetBytes)})`
    )
  }
  return {
    packTargetBytes,
    concurrency,
    assumedWindowMs: assumedWindowMinutes * 60_000,
    copies,
    gateways,
    withCDN: egressProvider === 'beam',
    maxStagedBytes,
  }
}

/**
 * Resolve the migrate state paths under the platform data directory:
 * `<dataDir>/migrate/migrate.db` (unless `--db` overrides it),
 * `<dataDir>/migrate/members` for verified member CARs, and
 * `<dataDir>/migrate/cars` for assembled pieces.
 */
export function resolveMigratePaths(
  dataDir: string,
  dbFlag?: string
): { migrateDir: string; dbPath: string; memberDir: string; carStore: string } {
  const migrateDir = join(dataDir, 'migrate')
  return {
    migrateDir,
    dbPath: dbFlag ?? join(migrateDir, 'migrate.db'),
    memberDir: join(migrateDir, 'members'),
    carStore: join(migrateDir, 'cars'),
  }
}

/**
 * Deduplicate a CID list by parsed bytes: CIDv0 and CIDv1 encodings of the
 * same content are one migration item, and letting both through would stage
 * the same bytes twice and collide inside a packed piece.
 */
export function dedupeCids(cids: string[]): { unique: string[]; duplicates: string[] } {
  const seen = new Set<string>()
  const unique: string[] = []
  const duplicates: string[] = []
  for (const cid of cids) {
    let key: string
    try {
      key = CID.parse(cid).toV1().toString()
    } catch {
      // Not parseable as a CID; keep it so the download stage reports it
      // as a per-CID failure instead of silently dropping the line.
      key = cid
    }
    if (seen.has(key)) {
      duplicates.push(cid)
      continue
    }
    seen.add(key)
    unique.push(cid)
  }
  return { unique, duplicates }
}

/** Staging budget from free disk space, capped by `--max-staged-bytes`. */
export async function resolveStagingBudget(stagingDir: string, maxStagedBytes: number | null): Promise<number> {
  const fs = await statfs(stagingDir)
  const free = Number(fs.bavail) * Number(fs.bsize)
  const fromDisk = Math.floor(free * BUDGET_FREE_SPACE_FRACTION)
  return maxStagedBytes == null ? fromDisk : Math.min(fromDisk, maxStagedBytes)
}

/**
 * Normalize Commander options and run the migrate flow.
 *
 * Commander wiring calls this so option validation errors are displayed by
 * the command UI layer and command files only own exit-code handling.
 */
export async function runMigrateFromCli(
  cidListFile: string,
  options: Record<string, unknown>
): Promise<MigrateSummary> {
  intro(pc.bold('Filecoin Pin Migrate'))
  const spinner = createSpinner()

  const logger = pino({ level: process.env.LOG_LEVEL || 'silent' })

  try {
    const normalized = normalizeMigrateOptions(options)
    const { packTargetBytes, concurrency, assumedWindowMs, copies, gateways, withCDN, maxStagedBytes } = normalized

    const contextSelection = parseContextSelectionOptions(options)

    // Read the CID list before any network work so a bad path fails fast.
    const { unique: cids, duplicates } = dedupeCids(parseCidList(await readFile(cidListFile, 'utf8')))
    if (cids.length === 0) {
      throw new Error(`no CIDs found in ${cidListFile} (one CID per line; # comments and blank lines are ignored)`)
    }
    if (duplicates.length > 0) {
      log(`ignoring ${duplicates.length} duplicate CID(s) in ${cidListFile}: ${duplicates.join(', ')}`)
    }

    spinner.start('Initializing Synapse SDK...')
    const config = parseCLIAuth(options)
    config.dataSetMetadata = { ...MIGRATE_DATA_SET_METADATA }
    if (withCDN) config.withCDN = true
    const synapse = await initializeSynapse(config, logger)
    const networkSlug = getNetworkSlug(synapse.chain)
    spinner.stop(`${pc.green('✓')} Connected to ${pc.bold(synapse.chain.name)}`)

    if (withCDN && chainSupportsFilbeam(synapse)) {
      printEgressNotice('beam')
    }

    // The total upload size is unknown until CIDs download, so validate the
    // minimum payment setup here; per-batch capacity failures surface from
    // the commit path with the payments hints.
    spinner.start('Checking payment setup...')
    await validatePaymentSetup(synapse, 0, spinner)

    const { migrateDir, dbPath, memberDir, carStore } = resolveMigratePaths(
      getDataDirectory(),
      options.db as string | undefined
    )
    await mkdir(memberDir, { recursive: true })
    await mkdir(carStore, { recursive: true })
    const budgetBytes = await resolveStagingBudget(migrateDir, maxStagedBytes)

    // Scope state per network AND owner: two wallets on one machine must not
    // resume each other's rows.
    const scope = `${networkSlug}:${getClientAddress(synapse).toLowerCase()}`
    const db = new MigrationDB(dbPath, scope)
    try {
      db.addCids(cids)
      cliLog.line(`Registered ${cids.length} CID(s) from ${cidListFile} (state: ${db.path})`)
      cliLog.flush()

      const summary = await runMigrate(db, {
        synapse,
        gateways,
        memberDir,
        carStore,
        packTargetBytes,
        concurrency,
        budgetBytes,
        copies,
        providerIds: contextSelection.providerIds,
        dataSetIds: contextSelection.dataSetIds,
        assumedWindowMs,
        dataSetMetadata: contextSelection.dataSetIds == null ? { ...MIGRATE_DATA_SET_METADATA } : undefined,
        withCDN,
      })

      // stdout carries only the machine-readable summary; progress went to
      // stderr as it happened.
      console.log(JSON.stringify(summary, null, 2))

      if (migrateIncomplete(summary)) {
        outro('Migrate finished with unmigrated CIDs; re-run to retry')
      } else {
        outro('Migrate completed successfully')
      }
      return summary
    } finally {
      db.close()
    }
  } catch (error) {
    if (isCliFatal(error)) {
      spinner.stop()
      logger.error({ event: 'migrate.failed', error }, 'Migrate failed')
      throw error
    }
    const msg = error instanceof Error ? error.message : 'Unknown error'
    spinner.stop(`${pc.red('✗')} Migrate failed: ${msg}`)
    logger.error({ event: 'migrate.failed', error }, 'Migrate failed')
    cancel('Migrate failed')
    throw new CliFatal(msg, { cause: error instanceof Error ? error : undefined })
  }
}

/** Whether a completed migrate run left anything unmigrated (exit-code input). */
export function migrateIncomplete(summary: MigrateSummary): boolean {
  return (
    summary.pieces.failed > 0 ||
    summary.pieces.pending > 0 ||
    summary.pieces.oversized > 0 ||
    summary.overCap.length > 0 ||
    summary.providers.some((p) => p.failed > 0 || p.collected > 0 || p.addUnconfirmed > 0)
  )
}
