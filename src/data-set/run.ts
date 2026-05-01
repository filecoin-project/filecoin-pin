import { confirm, isCancel } from '@clack/prompts'
import type { EnhancedDataSetInfo, Synapse } from '@filoz/synapse-sdk'
import pc from 'picocolors'
import { type DataSetSummary, getDetailedDataSet, listDataSets } from '../core/data-set/index.js'
import { getClientAddress } from '../core/synapse/index.js'
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

  try {
    const synapse = await getCliSynapse(options)
    const network = synapse.chain.name
    const address = getClientAddress(synapse)

    spinner.message('Fetching data set details...')

    const dataSet: DataSetSummary = await getDetailedDataSet(synapse, BigInt(dataSetId))

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
  }
}

export async function runDataSetListCommand(options: DataSetListCommandOptions): Promise<void> {
  intro(pc.bold('Filecoin Onchain Cloud Data Sets'))
  const spinner = createSpinner()
  spinner.start('Connecting to Synapse...')

  let synapse: Synapse | null = null

  try {
    // Parse and validate provider ID
    const providerIdRaw = options.providerId != null ? Number(options.providerId) : undefined
    if (providerIdRaw != null && Number.isNaN(providerIdRaw)) {
      throw new Error('Invalid provider ID')
    }
    const providerId = providerIdRaw != null ? BigInt(providerIdRaw) : undefined
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

    const network = synapse.chain.name
    const address = getClientAddress(synapse)

    spinner.message('Fetching data sets...')

    const allDataSets = await listDataSets(synapse, {
      withProviderDetails: false,
      filter,
    })
    const explicitFilter = filter != null
    const dataSets: DataSetSummary[] =
      options.all || explicitFilter ? allDataSets : allDataSets.filter((dataSet) => dataSet.createdWithFilecoinPin)

    spinner.stop('━━━ Data Sets ━━━')

    let emptyMessage: string | undefined
    if (dataSets.length === 0) {
      if (explicitFilter) {
        emptyMessage = 'No data sets matched the requested filter for this account.'
      } else if (options.all) {
        emptyMessage = 'No data sets were found for this account.'
      } else if (allDataSets.length > 0) {
        emptyMessage =
          'No data sets managed by filecoin-pin were found for this account. Pass --all to include data sets created by other tools.'
      }
    }

    displayDataSets(dataSets, network, address, emptyMessage)

    outro('Data set list complete')
  } catch (error) {
    spinner.stop(`${pc.red('✗')} Failed to list data sets`)
    log.line('')
    log.line(`${pc.red('Error:')} ${error instanceof Error ? error.message : String(error)}`)
    log.flush()
    cancel('Listing failed')
    throw error
  }
}

export async function runTerminateDataSetCommand(dataSetId: number, options: DataSetCommandOptions): Promise<void> {
  intro(pc.bold(`Terminate Filecoin Onchain Cloud Data Set #${dataSetId}`))
  const spinner = createSpinner()
  spinner.start('Connecting to Synapse...')

  try {
    if (Number.isNaN(dataSetId) || dataSetId <= 0) {
      spinner.stop(`${pc.red('✗')} Invalid data set ID`)
      log.line('')
      log.line(`${pc.red('Error:')} Provided data set ID is invalid or not a number`)
      log.flush()
      cancel('Termination failed')
      throw new Error('Invalid data set ID')
    }

    const synapse = await getCliSynapse(options)
    const network = synapse.chain.name
    const address = getClientAddress(synapse)

    // Read-only mode (bare address, no session key) cannot sign transactions
    if (typeof synapse.client.account === 'string' && synapse.sessionClient == null) {
      spinner.stop(`${pc.red('✗')} Signing required`)
      log.line('')
      log.line(
        `${pc.red('Error:')} Dataset termination requires a signing-capable wallet. ` +
          'View-only or address-only authentication cannot be used.'
      )
      log.flush()
      cancel('Termination failed')
      throw new Error('Signing required for termination')
    }

    spinner.message('Fetching data set details...')

    let dataSet: DataSetSummary
    try {
      dataSet = await getDetailedDataSet(synapse, BigInt(dataSetId))
    } catch (error) {
      spinner.stop(`${pc.red('✗')} Data set not found`)
      log.line('')
      log.line(`${pc.red('Error:')} Could not find data set with ID ${dataSetId}`)
      log.flush()
      cancel('Termination failed')
      throw error
    }

    if (dataSet.payer?.toLowerCase() !== address?.toLowerCase()) {
      const errorMsg = `Data set ${dataSetId} is not owned by address ${address}`
      spinner.stop(`${pc.red('✗')} Permission denied`)
      log.line('')
      log.line(`${pc.red('Error:')} ${errorMsg}`)
      log.line(`  Owner: ${dataSet.payer}`)
      log.flush()
      cancel('Termination failed')
      throw new Error(errorMsg)
    }

    if (dataSet.pdpEndEpoch > 0) {
      spinner.stop(`${pc.yellow('! Data set already terminated')}`)
      log.line('')
      log.line(`Data set ${dataSetId} was terminated at epoch ${dataSet.pdpEndEpoch}`)
      if (dataSet.isLive) {
        log.line(pc.gray('Note: Dataset shows as live but payment rail is terminated'))
      }
      log.flush()
      outro('Data set is already terminated')
      return
    }

    spinner.stop('--- Data Set to Terminate ---')
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

    let shouldWait = options.wait
    if (isInteractive()) {
      const proceed = await confirm({
        message: `Terminate data set #${dataSetId} and all associated payment rails? This action cannot be undone.`,
        initialValue: true,
      })
      if (isCancel(proceed) || !proceed) {
        cancel('Termination cancelled')
        return
      }

      if (shouldWait === undefined) {
        const waitConfirm = await confirm({
          message: 'Wait for the termination transaction to be fully confirmed?',
          initialValue: true,
        })
        if (!isCancel(waitConfirm)) {
          shouldWait = waitConfirm
        }
      }
    }

    spinner.start('Submitting termination transaction...')

    const txHash = await synapse.storage.terminateDataSet({ dataSetId: BigInt(dataSetId) })

    if (shouldWait) {
      spinner.message(`Waiting for confirmation: ${txHash}...`)
      const receipt = await synapse.client.waitForTransactionReceipt({ hash: txHash })
      if (receipt.status !== 'success') {
        throw new Error(`Termination transaction reverted: ${txHash}`)
      }
      spinner.message('Transaction confirmed, fetching final status...')
      try {
        dataSet = await getDetailedDataSet(synapse, BigInt(dataSetId))
      } catch {
        dataSet = {
          ...dataSet,
          isLive: false,
        }
      }
    }

    if (shouldWait) {
      spinner.stop(`${pc.green('*')} Data set termination confirmed: ${txHash}`)
    } else {
      spinner.stop(`Transaction submitted: ${txHash}`)
      log.line('')
      log.line(
        pc.yellow('Note: The transaction is pending. It may take a few moments for the status to update on-chain.')
      )
    }

    log.line('')
    const resultsContent = [
      pc.gray(`Transaction Hash: ${txHash}`),
      pc.gray(`Network: ${network}`),
      pc.gray(`Data Set ID: ${dataSetId}`),
      pc.gray(`PDP Rail ID: ${dataSet.pdpRailId}`),
    ]
    if (dataSet.withCDN && dataSet.cdnRailId > 0) {
      resultsContent.push(pc.gray(`FilBeam Rail ID: ${dataSet.cdnRailId}`))
    }
    if (dataSet.withCDN && dataSet.cacheMissRailId > 0) {
      resultsContent.push(pc.gray(`FilBeam Cache-Miss Rail ID: ${dataSet.cacheMissRailId}`))
    }
    log.spinnerSection('Termination Results', resultsContent)

    log.line('')
    log.line(pc.bold(shouldWait ? 'Final Data Set Status:' : 'Updated Data Set Status (Pending):'))
    displayDataSets([dataSet], network, address)

    outro(shouldWait ? 'Data set termination complete' : 'Termination transaction submitted')
  } catch (error) {
    spinner.stop(`${pc.red('✗')} Failed to terminate data set`)

    log.line('')
    log.line(`${pc.red('Error:')} ${error instanceof Error ? error.message : String(error)}`)
    log.flush()

    cancel('Termination failed')
    throw error
  }
}
