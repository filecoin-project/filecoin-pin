import type { EnhancedDataSetInfo, ProviderInfo } from '@filoz/synapse-sdk'
import { RPC_URLS, Synapse } from '@filoz/synapse-sdk'
import { Command } from 'commander'
import pc from 'picocolors'
import { type DataSetInspectionContext, displayDataSetList, displayDataSetStatus } from '../data-set/inspect.js'
import { cleanupProvider } from '../synapse/service.js'
import { cancel, createSpinner, intro, outro } from '../utils/cli-helpers.js'
import { log } from '../utils/cli-logger.js'

interface DataSetCommandOptions {
  ls?: boolean
  privateKey?: string
  rpcUrl?: string
}

function buildContext(params: {
  address: string
  network: string
  dataSets: EnhancedDataSetInfo[]
  providers: ProviderInfo[] | null
}): DataSetInspectionContext {
  const providerMap = new Map<number, ProviderInfo>()
  if (params.providers != null) {
    for (const provider of params.providers) {
      providerMap.set(provider.id, provider)
    }
  }

  return {
    address: params.address,
    network: params.network,
    dataSets: params.dataSets.filter((dataSet) => dataSet.metadata?.source === 'filecoin-pin'),
    providers: providerMap,
  }
}

async function ensurePrivateKey(options: DataSetCommandOptions): Promise<string> {
  const privateKey = options.privateKey ?? process.env.PRIVATE_KEY
  if (!privateKey) {
    log.line(pc.red('Error: Private key required via --private-key or PRIVATE_KEY env'))
    log.flush()
    cancel('Data set inspection cancelled')
    process.exit(1)
  }
  return privateKey
}

function resolveRpcUrl(options: DataSetCommandOptions): string {
  return options.rpcUrl ?? process.env.RPC_URL ?? RPC_URLS.calibration.websocket
}

export const dataSetCommand = new Command('data-set')
  .description('Inspect data sets managed through Filecoin Onchain Cloud')
  .argument('[dataSetId]', 'Optional data set ID to inspect')
  .option('--ls', 'List all data sets for the configured account')
  .option('--private-key <key>', 'Private key (or PRIVATE_KEY env)')
  .option('--rpc-url <url>', 'RPC endpoint (or RPC_URL env)')
  .action(async (dataSetIdArg: string | undefined, options: DataSetCommandOptions) => {
    const dataSetIdInput = dataSetIdArg ?? null
    const hasDataSetId = dataSetIdInput != null
    // we list if --ls is provided or no dataSetId is given (default to listing all data sets)
    const shouldList = options.ls === true || !hasDataSetId

    const privateKey = await ensurePrivateKey(options)
    const rpcUrl = resolveRpcUrl(options)

    intro(pc.bold('Filecoin Onchain Cloud Data Sets'))
    const spinner = createSpinner()
    spinner.start('Connecting to Synapse...')

    let synapse: Synapse | null = null
    let provider: any = null

    try {
      synapse = await Synapse.create({ privateKey, rpcURL: rpcUrl })
      const network = synapse.getNetwork()
      const signer = synapse.getSigner()
      const address = await signer.getAddress()

      if (/^wss?:\/\//i.test(rpcUrl)) {
        provider = synapse.getProvider()
      }

      spinner.message('Fetching data set information...')

      const [dataSets, storageInfo] = await Promise.all([
        synapse.storage.findDataSets(address),
        synapse.storage.getStorageInfo().catch(() => null),
      ])

      spinner.stop('━━━ Data Sets ━━━')

      const context = buildContext({
        address,
        network,
        dataSets,
        providers: storageInfo?.providers ?? null,
      })

      if (shouldList) {
        displayDataSetList(context)
      }

      if (hasDataSetId) {
        const dataSetId = Number.parseInt(dataSetIdInput, 10)
        if (Number.isNaN(dataSetId)) {
          log.line(pc.red(`Invalid data set ID: ${dataSetIdInput}`))
          log.flush()
          cancel('Invalid arguments')
        }

        if (shouldList) {
          log.line('')
          log.flush()
        }

        // Future operations like --terminate/--remove will be handled here
        const found = displayDataSetStatus(context, dataSetId)
        if (!found) {
          cancel('Data set not found')
          process.exitCode = 1
          return
        }
      }

      await cleanupProvider(provider)
      outro('Data set inspection complete')
    } catch (error) {
      spinner.stop(`${pc.red('✗')} Failed to inspect data sets`)
      await cleanupProvider(provider)

      log.line('')
      log.line(`${pc.red('Error:')} ${error instanceof Error ? error.message : String(error)}`)
      log.flush()

      cancel('Inspection failed')
      process.exitCode = 1
    } finally {
      await cleanupProvider(provider)
    }
  })
