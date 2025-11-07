import type { EnhancedDataSetInfo, Synapse } from '@filoz/synapse-sdk'
import pc from 'picocolors'
import { type DataSetSummary, getDetailedDataSet, listDataSets } from '../core/data-set/index.js'
import { cleanupSynapseService } from '../core/synapse/index.js'
import { getCliSynapse } from '../utils/cli-auth.js'
import { cancel, createSpinner, intro, outro } from '../utils/cli-helpers.js'
import { log } from '../utils/cli-logger.js'
import { displayDataSets } from './display.js'
import type { DataSetCommandOptions, DataSetListCommandOptions } from './types.js'

/**
 * Entry point invoked by the Commander command.
 *
 * @param dataSetIdArg - Optional dataset identifier provided on the command line
 * @param options - Normalised CLI options
 */
export async function runDataSetDetailsCommand(dataSetId: number, options: DataSetCommandOptions): Promise<void> {
  intro(pc.bold(`Filecoin Onchain Cloud Data Set Details for #${dataSetId}`))
  const spinner = createSpinner()
  spinner.start('Connecting to Synapse...')

  let synapse: Synapse | null = null

  try {
    synapse = await getCliSynapse(options)
    const network = synapse.getNetwork()
    const client = synapse.getClient()
    const address = await client.getAddress()

    spinner.message('Fetching data set details...')

    const dataSet: DataSetSummary = await getDetailedDataSet(synapse, dataSetId)

    spinner.stop('━━━ Data Set ━━━')
    displayDataSets([dataSet], network, address)

    outro('Data set inspection complete')
  } catch (error) {
    spinner.stop(`${pc.red('✗')} Failed to inspect data set`)

    log.line('')
    log.line(`${pc.red('Error:')} ${error instanceof Error ? error.message : String(error)}`)
    log.flush()

    cancel('Inspection failed')
    process.exitCode = 1
  } finally {
    await cleanupSynapseService()
  }
}

export async function runDataSetListCommand(options: DataSetListCommandOptions): Promise<void> {
  intro(pc.bold('Filecoin Onchain Cloud Data Sets'))
  const spinner = createSpinner()
  spinner.start('Connecting to Synapse...')

  let synapse: Synapse | null = null

  try {
    // Parse and validate provider ID
    const providerId: number | undefined = options.providerId != null ? Number(options.providerId) : undefined
    if (providerId != null && Number.isNaN(providerId)) {
      throw new Error('Invalid provider ID')
    }
    const filter: ((dataSet: EnhancedDataSetInfo) => boolean) | undefined =
      providerId != null ? (dataSet) => dataSet.providerId === providerId : undefined

    synapse = await getCliSynapse(options)

    const network = synapse.getNetwork()
    const client = synapse.getClient()
    const address = await client.getAddress()

    spinner.message('Fetching data sets...')

    const allDataSets = await listDataSets(synapse, {
      withProviderDetails: false,
      filter,
    })
    const dataSets: DataSetSummary[] = options.all
      ? allDataSets
      : allDataSets.filter((dataSet) => dataSet.createdWithFilecoinPin)

    spinner.stop('━━━ Data Sets ━━━')

    displayDataSets(dataSets, network, address)

    outro('Data set list complete')
  } catch (error) {
    spinner.stop(`${pc.red('✗')} Failed to list data sets`)
    log.line('')
    log.line(`${pc.red('Error:')} ${error instanceof Error ? error.message : String(error)}`)
    log.flush()
    cancel('Listing failed')
    process.exitCode = 1
  } finally {
    await cleanupSynapseService()
  }
}
