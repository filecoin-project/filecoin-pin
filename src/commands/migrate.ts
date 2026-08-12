import { Command, Option } from 'commander'
import { migrateIncomplete, runMigrateFromCli } from '../migrate/migrate.js'
import { addAuthOptions, addContextSelectionOptions } from '../utils/cli-options.js'
import { addEgressOptions } from '../utils/cli-options-egress.js'

export const migrateCommand = new Command('migrate')
  .description('Migrate IPFS content to Filecoin from a list of CIDs, packing them into batched pieces')
  .argument('<cid-list-file>', 'Path to a file with one CID per line (# comments and blank lines ignored)')
  .option('--gateway <url>', 'Trustless gateway to fetch CARs from; repeatable', collect)
  .option('--pack-target-size <size>', 'Target raw size for one packed piece, e.g. 1000MiB (default: 1000MiB)')
  .option('--concurrency <n>', 'CID download concurrency for the commP pass (default: 8)')
  .option(
    '--fetch-concurrency <n>',
    'Reserved: member re-fetch fan-out during packing (members currently stream sequentially)'
  )
  .option(
    '--assumed-window-minutes <n>',
    'Starting guess for the provider GC window; commits flush before it expires (default: 60)'
  )
  .option('--copies <n>', 'Number of storage copies to create (default: 2)', Number.parseInt)
  .option('--db <file>', 'Migrate state database path (default: migrate.db in the filecoin-pin data directory)')
  .addOption(
    new Option(
      '--mode <mode>',
      'streaming uploads pieces while later CIDs still download; staged packs everything first'
    )
      .choices(['streaming', 'staged'])
      .default('streaming')
  )
  .option('--no-manifest', 'Skip writing and uploading the migration manifest piece')
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
addEgressOptions(migrateCommand)
