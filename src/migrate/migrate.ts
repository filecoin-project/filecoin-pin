/**
 * CLI-facing migrate runner: option normalization, Synapse initialization,
 * payment validation, and the state DB lifecycle around `runMigrate`.
 */

import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import pc from 'picocolors'
import pino from 'pino'
import { CliFatal, isCliFatal } from '../common/cli-errors.js'
import { validatePaymentSetup } from '../common/upload-flow.js'
import { getDataDirectory } from '../config.js'
import { DEFAULT_COPIES, IPFS_INDEXED_METADATA } from '../core/synapse/constants.js'
import { APPLICATION_SOURCE, initializeSynapse } from '../core/synapse/index.js'
import { getNetworkSlug } from '../core/upload/index.js'
import { parseCLIAuth, parseContextSelectionOptions } from '../utils/cli-auth.js'
import { cancel, createSpinner, intro, outro } from '../utils/cli-helpers.js'
import { log as cliLog } from '../utils/cli-logger.js'
import { chainSupportsFilbeam, printEgressNotice } from '../utils/cli-options-egress.js'
import { DEFAULT_GATEWAYS } from './car-url.js'
import { MigrationDB } from './db.js'
import { DEFAULT_ASSUMED_WINDOW_MS } from './gc-window.js'
import { DEFAULT_PACK_TARGET_BYTES, MAX_UPLOAD_BYTES } from './pack-cars.js'
import { type MigrateMode, type MigrateSummary, runMigrate } from './run-migrate.js'
import { parseCidList, parsePositiveInt, parseSize } from './util.js'

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

/** Migrate options after CLI-flag normalization and validation. */
export interface NormalizedMigrateOptions {
  mode: MigrateMode
  packTargetBytes: number
  concurrency: number
  assumedWindowMs: number
  copies: number
  gateways: string[]
  withCDN: boolean
  manifest: boolean
}

/**
 * Validate and normalize the migrate-specific Commander options. Pure, so the
 * flag defaults (streaming mode, egress none, manifest on) are unit-testable
 * without a network.
 */
export function normalizeMigrateOptions(options: Record<string, unknown>): NormalizedMigrateOptions {
  const mode = (options.mode ?? 'streaming') as string
  if (mode !== 'streaming' && mode !== 'staged') {
    throw new Error(`unknown --mode ${mode} (expected streaming|staged)`)
  }
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
  return {
    mode: mode as MigrateMode,
    packTargetBytes,
    concurrency,
    assumedWindowMs: assumedWindowMinutes * 60_000,
    copies,
    gateways,
    withCDN: egressProvider === 'beam',
    manifest: options.manifest !== false,
  }
}

/**
 * Resolve the migrate state paths under the platform data directory:
 * `<dataDir>/migrate/migrate.db` (unless `--db` overrides it) and
 * `<dataDir>/migrate/cars` for staged CAR files.
 */
export function resolveMigratePaths(
  dataDir: string,
  dbFlag?: string
): { migrateDir: string; dbPath: string; carStore: string } {
  const migrateDir = join(dataDir, 'migrate')
  return {
    migrateDir,
    dbPath: dbFlag ?? join(migrateDir, 'migrate.db'),
    carStore: join(migrateDir, 'cars'),
  }
}

/**
 * Normalize Commander options and run the migrate flow.
 *
 * Commander wiring calls this so option validation errors are displayed by the
 * command UI layer and command files only own exit-code handling.
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
    const { mode, packTargetBytes, concurrency, assumedWindowMs, copies, gateways, withCDN, manifest } = normalized

    const contextSelection = parseContextSelectionOptions(options)

    // Read the CID list before any network work so a bad path fails fast.
    const cids = parseCidList(await readFile(cidListFile, 'utf8'))
    if (cids.length === 0) {
      throw new Error(`no CIDs found in ${cidListFile} (one CID per line; # comments and blank lines are ignored)`)
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

    // The total upload size is unknown until the commP pass runs, so validate
    // the minimum payment setup here; per-batch capacity failures surface from
    // the commit path with the payments hints.
    spinner.start('Checking payment setup...')
    await validatePaymentSetup(synapse, 0, spinner)

    const { migrateDir, dbPath, carStore } = resolveMigratePaths(getDataDirectory(), options.db as string | undefined)
    await mkdir(migrateDir, { recursive: true })

    const db = new MigrationDB(dbPath, networkSlug)
    try {
      db.addCids(cids)
      cliLog.line(`Registered ${cids.length} CID(s) from ${cidListFile} (state: ${db.path})`)
      cliLog.flush()

      const summary = await runMigrate(db, {
        synapse,
        gateways,
        carStore,
        mode,
        packTargetBytes,
        concurrency,
        copies,
        providerIds: contextSelection.providerIds,
        dataSetIds: contextSelection.dataSetIds,
        assumedWindowMs,
        dataSetMetadata: contextSelection.dataSetIds == null ? { ...MIGRATE_DATA_SET_METADATA } : undefined,
        withCDN,
        manifest,
      })

      // stdout carries only the machine-readable summary; progress went to
      // stderr as it happened.
      console.log(JSON.stringify(summary, null, 2))

      if (summary.manifest != null) {
        cliLog.line(`Manifest root CID: ${pc.bold(summary.manifest.rootCid)}`)
        cliLog.flush()
      }

      if (migrateIncomplete(summary)) {
        outro('Migrate finished with unmigrated CIDs: re-run to retry')
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
    summary.overCap.length > 0 ||
    summary.providers.some((p) => p.failed > 0 || p.collected > 0)
  )
}
