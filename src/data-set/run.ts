import { confirm, isCancel } from '@clack/prompts'
import type { EnhancedDataSetInfo, Synapse } from '@filoz/synapse-sdk'
import { WarmStorageService } from '@filoz/synapse-sdk'
import pc from 'picocolors'
import { type DataSetSummary, getDetailedDataSet, listDataSets } from '../core/data-set/index.js'
import { cleanupSynapseService } from '../core/synapse/index.js'
import { getCliSynapse } from '../utils/cli-auth.js'
import { cancel, createSpinner, intro, isInteractive, outro } from '../utils/cli-helpers.js'
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
    throw error
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
    const metadataEntries = options.dataSetMetadata ? Object.entries(options.dataSetMetadata) : []
    let filter: ((dataSet: EnhancedDataSetInfo) => boolean) | undefined

    if (providerId != null || metadataEntries.length > 0) {
      // TODO: synapse is supposed to be able to filter on dataset metadata, but synapse.storage.findDataSets doesn't accept metadata? How do we filter..
      filter = (dataSet) => {
        if (providerId != null && dataSet.providerId !== providerId) {
          return false
        }
        if (
          metadataEntries.length > 0 &&
          !metadataEntries.every(([key, value]) => (dataSet.metadata?.[key] ?? '') === value)
        ) {
          return false
        }
        return true
      }
    }

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
    throw error
  } finally {
    await cleanupSynapseService()
  }
}

/**
 * Terminate a dataset and associated payment rails
 *
 * @param dataSetId - Dataset identifier to terminate
 * @param options - CLI options including confirmation and wait settings
 */
export async function runTerminateDataSetCommand(dataSetId: number, options: DataSetCommandOptions): Promise<void> {
  intro(pc.bold(`Terminate Filecoin Onchain Cloud Data Set #${dataSetId}`))
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

    if (dataSet.payer.toLowerCase() !== address.toLowerCase()) {
      spinner.stop(`${pc.red('✗')} Permission denied`)
      log.line('')
      log.line(`${pc.red('Error:')} Data set ${dataSetId} is not owned by ${address}`)
      log.line(`  Owner: ${dataSet.payer}`)
      log.flush()
      cancel('Termination failed')
      process.exitCode = 1
      return
    }

    if (dataSet.pdpEndEpoch > 0) {
      spinner.stop(`${pc.yellow('⚠ Data set already terminated')}`)
      log.line('')
      log.line(`Data set ${dataSetId} was terminated at epoch ${dataSet.pdpEndEpoch}`)
      if (dataSet.isLive) {
        log.line(pc.gray('Note: Dataset shows as live but payment rail is terminated'))
      }
      log.flush()
      outro('Data set is already terminated')
      return
    }

    spinner.stop('━━━ Data Set to Terminate ━━━')
    displayDataSets([dataSet], network, address)

    log.line('')
    log.line(pc.bold('Payment Rails to Terminate:'))
    log.indent(`Dataset ID: ${dataSetId}`, 1)
    log.indent(`PDP Rail ID: ${dataSet.pdpRailId}`, 1)
    if (dataSet.withCDN) {
      if (dataSet.cdnRailId > 0) {
        log.indent(`FilBeam Rail ID: ${dataSet.cdnRailId}`, 1)
      }
      if (dataSet.cacheMissRailId > 0) {
        log.indent(`FilBeam Cache-Miss Rail ID: ${dataSet.cacheMissRailId}`, 1)
      }
    }
    log.flush()

    if (isInteractive()) {
      spinner.stop()
      const proceed = await confirm({
        message: `Terminate data set #${dataSetId} and all associated payment rails? This action cannot be undone.`,
        initialValue: true,
      })
      if (isCancel(proceed)) {
        cancel('Termination cancelled')
        process.exit(1)
      }
      if (!proceed) {
        cancel('Termination cancelled by user')
        return
      }
      spinner.start('Terminating data set...')
    } else {
      spinner.message('Terminating data set...')
    }

    const warmStorageService = await WarmStorageService.create(synapse.getProvider(), synapse.getWarmStorageAddress())
    const signer = synapse.getSigner()

    spinner.message('Submitting termination transaction...')
    const txResponse = await warmStorageService.terminateDataSet(signer, dataSetId)
    const txHash = txResponse.hash

    const updatedDataSet = {
      ...dataSet,
      isLive: false,
      pdpEndEpoch: txResponse.blockNumber != null ? Math.ceil(txResponse.blockNumber / 32) : 0,
    }

    spinner.stop(`Transaction submitted: ${txHash}`)

    log.line('')
    const resultsContent = [
      pc.gray(`Transaction Hash: ${txHash}`),
      pc.gray(`Network: ${network}`),
      pc.gray(`Data Set ID: ${dataSetId}`),
      pc.gray(`PDP Rail ID: ${updatedDataSet.pdpRailId}`),
    ]
    if (dataSet.withCDN && dataSet.cdnRailId > 0) {
      resultsContent.push(pc.gray(`FilBeam Rail ID: ${dataSet.cdnRailId}`))
    }
    if (dataSet.withCDN && dataSet.cacheMissRailId > 0) {
      resultsContent.push(pc.gray(`FilBeam Cache-Miss Rail ID: ${dataSet.cacheMissRailId}`))
    }
    log.spinnerSection('Termination Results', resultsContent)

    log.line('')
    log.line(pc.bold('Updated Data Set Status:'))
    displayDataSets([updatedDataSet], network, address)

    spinner.stop('Data set termination complete')
  } catch (error) {
    spinner.stop(`${pc.red('✗')} Failed to terminate data set`)

    log.line('')
    log.line(`${pc.red('Error:')} ${error instanceof Error ? error.message : String(error)}`)
    log.flush()

    cancel('Termination failed')
    process.exitCode = 1
  } finally {
    await cleanupSynapseService()
  }
}
