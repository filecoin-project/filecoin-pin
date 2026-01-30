import { Command } from 'commander'
import { runProviderList, runProviderPing, runProviderShow } from '../provider/index.js'
import type { ProviderListOptions, ProviderPingOptions, ProviderShowOptions } from '../provider/types.js'
import { addAuthOptions } from '../utils/cli-options.js'

export const providerCommand = new Command('provider')
  .description('Inspect and interact with storage providers')

const listCommand = new Command('list')
  .alias('ls')
  .description('List providers')
  .option('--all', 'List all active providers (ignoring approval status)')
  .action(async (options) => {
    try {
      const listOptions: ProviderListOptions = {
        ...options
      }
      await runProviderList(listOptions)
    } catch {
      process.exit(1)
    }
  })

addAuthOptions(listCommand)

const showCommand = new Command('show')
  .description('Show details for a specific provider')
  .argument('<provider>', 'Provider ID')
  .action(async (providerId, options) => {
    try {
      const showOptions: ProviderShowOptions = {
        ...options
      }
      await runProviderShow(providerId, showOptions)
    } catch {
      process.exit(1)
    }
  })

addAuthOptions(showCommand)

const pingCommand = new Command('ping')
  .description('Ping provider PDP service. Pings all approved providers if no ID specified.')
  .argument('[provider]', 'Provider ID')
  .option('--all', 'Ping all active providers (ignoring approval status)')
  .action(async (providerId, options) => {
    try {
      const pingOptions: ProviderPingOptions = {
        ...options
      }
      await runProviderPing(providerId, pingOptions)
    } catch {
      process.exit(1)
    }
  })

addAuthOptions(pingCommand)

providerCommand.addCommand(listCommand)
providerCommand.addCommand(showCommand)
providerCommand.addCommand(pingCommand)
