import { Command, Option } from 'commander'
import { migrateIncomplete, runMigrateFromCli } from '../migrate/migrate.js'
import { addAuthOptions, addContextSelectionOptions } from '../utils/cli-options.js'
import { EGRESS_PROVIDERS } from '../utils/cli-options-egress.js'

export const migrateCommand = new Command('migrate')
  .description('Migrate IPFS content to Filecoin from a list of CIDs, packing them into batched pieces')
  .argument('<cid-list-file>', 'Path to a file with one CID per line (# comments and blank lines ignored)')
  .option('--gateway <url>', 'Trustless gateway to fetch CARs from; repeatable', collect)
  .option('--pack-target-size <size>', 'Target raw size for one packed piece, e.g. 1000MiB (default: 1000MiB)')
  .option('--concurrency <n>', 'CID download concurrency (default: 8)')
  .option(
    '--max-staged-bytes <size>',
    'Cap on staged bytes on disk, e.g. 8GiB (default: 80% of free space in the staging directory)'
  )
  .option(
    '--assumed-window-minutes <n>',
    'Starting guess for the provider GC window; commits flush before it expires (default: 60)'
  )
  .option('--copies <n>', 'Number of storage copies to create (default: 2)', Number.parseInt)
  .option('--db <file>', 'Migrate state database path (default: migrate.db in the filecoin-pin data directory)')
  .action(async (cidListFile: string, options) => {
    try {
      const summary = await runMigrateFromCli(cidListFile, options)
      if (migrateIncomplete(summary)) {
        process.exitCode = 1
      }
    } catch {
      process.exit(1)
    }
  })

function collect(value: string, previous: string[] = []): string[] {
  previous.push(value)
  return previous
}

addAuthOptions(migrateCommand)
addContextSelectionOptions(migrateCommand)
// Deliberately not addEgressOptions: that variant reads EGRESS_PROVIDER from
// the environment, and a variable exported for add/import would silently opt
// a bulk migration into CDN lockup. Migrate pays egress only on an explicit
// flag, and its help states its own `none` default.
migrateCommand.addOption(
  new Option(
    '--egress-provider <provider>',
    'Egress provider for piece retrieval: beam (FilBeam CDN; egress drawn from the owner lockup) or none (default).'
  ).choices(EGRESS_PROVIDERS as readonly string[])
)
