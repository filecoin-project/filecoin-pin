import { confirm, isCancel } from '@clack/prompts'
import type { EnhancedDataSetInfo, Synapse } from '@filoz/synapse-sdk'
import { WarmStorageService } from '@filoz/synapse-sdk'
import pc from 'picocolors'
import { type DataSetSummary, getDetailedDataSet, listDataSets } from '../core/data-set/index.js'
import { ADDRESS_ONLY_SIGNER_SYMBOL } from '../core/synapse/address-only-signer.js'
import { cleanupSynapseService, isViewOnlyMode } from '../core/synapse/index.js'
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
    if (Number.isNaN(dataSetId) || dataSetId <= 0) {
      spinner.stop(`${pc.red('✗')} Invalid data set ID`)
      log.line('')
      log.line(`${pc.red('Error:')} Provided data set ID is invalid or not a number`)
      log.flush()
      cancel('Termination failed')
      throw new Error('Invalid data set ID')
    }

    synapse = await getCliSynapse(options)
    const network = synapse.getNetwork()

    const signer = synapse.getSigner()
    if (isViewOnlyMode(synapse) || (signer as any)[ADDRESS_ONLY_SIGNER_SYMBOL]) {
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

    let address: string
    try {
      address = await signer.getAddress()
    } catch (error) {
      spinner.stop(`${pc.red('✗')} Could not retrieve wallet address`)
      log.line('')
      log.line(`${pc.red('Error:')} ${error instanceof Error ? error.message : String(error)}`)
      log.flush()
      cancel('Termination failed')
      throw error
    }

    spinner.message('Fetching data set details...')

    let dataSet: DataSetSummary
    try {
      dataSet = await getDetailedDataSet(synapse, dataSetId)
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

    spinner.start('Terminating data set...')

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
      spinner.stop()
      const proceed = await confirm({
        message: `Terminate data set #${dataSetId} and all associated payment rails? This action cannot be undone.`,
        initialValue: true,
      })
      if (isCancel(proceed)) {
        cancel('Termination cancelled')
        return
      }
      if (!proceed) {
        cancel('Termination cancelled by user')
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

      spinner.start('Terminating data set...')
      spinner.message('Terminating data set...')
    }

    let warmStorageService: WarmStorageService
    try {
      warmStorageService = await WarmStorageService.create(synapse.getProvider(), synapse.getWarmStorageAddress())
    } catch (serviceError) {
      spinner.stop(`${pc.red('✗')} Failed to initialize storage service`)
      log.line('')
      log.line(`${pc.red('Error:')} ${serviceError instanceof Error ? serviceError.message : String(serviceError)}`)
      log.flush()
      cancel('Termination failed')
      throw serviceError
    }

    let txHash: string
    let txResponse: any
    try {
      const signer = synapse.getSigner()
      const provider = synapse.getProvider()
      spinner.message('Submitting termination transaction...')
      txResponse = await warmStorageService.terminateDataSet(signer, dataSetId)
      txHash = txResponse.hash

      if (shouldWait) {
        spinner.message(`Waiting for confirmation: ${txHash}...`)
        const receipt = await provider.waitForTransaction(txHash)
        if (receipt == null) {
          throw new Error(`Termination transaction was not confirmed: ${txHash}`)
        }
        if (receipt.status == null || Number(receipt.status) !== 1) {
          throw new Error(`Termination transaction reverted: ${txHash}`)
        }
        spinner.message('Transaction confirmed, fetching final status...')
        try {
          const finalDataSet = await getDetailedDataSet(synapse, dataSetId)
          dataSet = {
            ...finalDataSet,
            isLive: finalDataSet.pdpEndEpoch === 0,
            pdpEndEpoch: finalDataSet.pdpEndEpoch,
          }
        } catch (_) {
          dataSet = {
            ...dataSet,
            isLive: false,
            pdpEndEpoch: receipt.blockNumber != null ? Math.ceil(receipt.blockNumber / 32) : 0,
          }
        }
      } else {
        dataSet = {
          ...dataSet,
          isLive: false,
          pdpEndEpoch: txResponse.blockNumber != null ? Math.ceil(txResponse.blockNumber / 32) : 0,
        }
      }
    } catch (error) {
      spinner.stop(`${pc.red('✗')} Failed to submit termination transaction`)
      log.line('')
      log.line(`${pc.red('Error:')} ${error instanceof Error ? error.message : String(error)}`)
      log.flush()
      cancel('Termination failed')
      throw error
    }

    if (shouldWait) {
      spinner.stop(`${pc.green('✓')} Data set termination confirmed: ${txHash}`)
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

    spinner.stop(shouldWait ? 'Data set termination complete' : 'Termination transaction submitted')
  } catch (error) {
    spinner.stop(`${pc.red('✗')} Failed to terminate data set`)

    log.line('')
    log.line(`${pc.red('Error:')} ${error instanceof Error ? error.message : String(error)}`)
    log.flush()

    cancel('Termination failed')
  } finally {
    await cleanupSynapseService()
  }
}
