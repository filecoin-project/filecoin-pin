import type { Synapse } from '@filoz/synapse-sdk'
import pc from 'picocolors'
import { TELEMETRY_CLI_APP_NAME } from '../common/constants.js'
import { getDataSetPieces, listDataSets } from '../core/data-set/index.js'
import { cleanupSynapseService, initializeSynapse } from '../core/synapse/index.js'
import { getCLILogger, parseCLIAuth } from '../utils/cli-auth.js'
import { cancel, createSpinner, intro, outro } from '../utils/cli-helpers.js'
import { log } from '../utils/cli-logger.js'
import { displayDataSetList, displayDataSetStatus } from './inspect.js'
import type { DataSetCommandOptions, DataSetInspectionContext, DataSetSummaryForCLI } from './types.js'

/**
 * Build the lightweight inspection context used when no dataset ID is provided.
 * Only metadata cached in Synapse responses is included so the command returns quickly.
 */
async function buildSummaryContext(params: {
  address: string
  network: string
  synapse: Synapse
}): Promise<DataSetInspectionContext> {
  // Use core listDataSets function which handles provider enrichment
  const allDataSets = await listDataSets(params.synapse, {
    address: params.address,
    logger: getCLILogger(),
  })

  // Filter to only filecoin-pin managed datasets and add required warnings field
  const managedDataSets: DataSetSummaryForCLI[] = allDataSets
    .filter((dataSet) => dataSet.metadata?.source === 'filecoin-pin')
    .map((dataSet) => ({
      ...dataSet,
      warnings: [],
    }))

  return {
    address: params.address,
    network: params.network,
    dataSets: managedDataSets,
  }
}

/**
 * Enrich a summary dataset entry with live information from pieces.
 *
 * Populates pieces, metadata, total size, and warning messages.
 */
async function loadDetailedDataSet(summary: DataSetSummaryForCLI, synapse: Synapse): Promise<DataSetSummaryForCLI> {
  const result: DataSetSummaryForCLI = {
    ...summary,
    metadata: { ...summary.metadata },
    pieces: summary.pieces?.map((piece) => ({ ...piece })) ?? [],
    warnings: [...summary.warnings],
  }

  // Fetch pieces using core function
  try {
    const storageContext = await synapse.storage.createContext({
      dataSetId: result.dataSetId,
    })
    const piecesResult = await getDataSetPieces(synapse, storageContext, {
      includeMetadata: true,
      logger: getCLILogger(),
    })

    result.pieces = piecesResult.pieces
    if (piecesResult.totalSizeBytes != null) {
      result.totalSizeBytes = piecesResult.totalSizeBytes
    }

    // Add any warnings from piece fetching
    if (piecesResult.warnings != null && piecesResult.warnings.length > 0) {
      result.warnings.push(...piecesResult.warnings.map((w) => w.message))
    }
  } catch (error) {
    result.warnings.push(`Failed to fetch pieces: ${error instanceof Error ? error.message : String(error)}`)
  }

  return result
}

/**
 * Entry point invoked by the Commander command.
 *
 * @param dataSetIdArg - Optional dataset identifier provided on the command line
 * @param options - Normalised CLI options
 */
export async function runDataSetCommand(
  dataSetIdArg: string | undefined,
  options: DataSetCommandOptions
): Promise<void> {
  const dataSetIdInput = dataSetIdArg ?? null
  const hasDataSetId = dataSetIdInput != null
  const shouldList = options.ls === true || !hasDataSetId

  intro(pc.bold('Filecoin Onchain Cloud Data Sets'))
  const spinner = createSpinner()
  spinner.start('Connecting to Synapse...')

  let synapse: Synapse | null = null

  try {
    // Parse and validate authentication
    const authConfig = parseCLIAuth({
      privateKey: options.privateKey,
      walletAddress: options.walletAddress,
      sessionKey: options.sessionKey,
      rpcUrl: options.rpcUrl,
    })

    const logger = getCLILogger()
    synapse = await initializeSynapse(
      { ...authConfig, telemetry: { sentrySetTags: { appName: TELEMETRY_CLI_APP_NAME } } },
      logger
    )
    const network = synapse.getNetwork()
    const client = synapse.getClient()
    const address = await client.getAddress()

    spinner.message('Fetching data set information...')

    const context = await buildSummaryContext({
      address,
      network,
      synapse,
    })

    if (hasDataSetId) {
      const dataSetId = Number.parseInt(dataSetIdInput, 10)
      if (Number.isNaN(dataSetId)) {
        spinner.stop('━━━ Data Sets ━━━')
        log.line(pc.red(`Invalid data set ID: ${dataSetIdInput}`))
        log.flush()
        cancel('Invalid arguments')
        process.exitCode = 1
        return
      }

      const targetIndex = context.dataSets.findIndex((item) => item.dataSetId === dataSetId)

      if (targetIndex === -1) {
        spinner.stop('━━━ Data Sets ━━━')
        cancel('Data set not found')
        process.exitCode = 1
        return
      }

      spinner.message('Collecting data set details...')

      const baseSummary = context.dataSets[targetIndex]
      if (baseSummary == null) {
        spinner.stop('━━━ Data Sets ━━━')
        cancel('Data set not found')
        process.exitCode = 1
        return
      }
      const detailed = await loadDetailedDataSet(baseSummary, synapse)
      context.dataSets[targetIndex] = detailed

      spinner.stop('━━━ Data Sets ━━━')

      if (shouldList) {
        const filteredContext: DataSetInspectionContext = {
          ...context,
          dataSets: context.dataSets.filter((entry, index) => {
            if (entry.dataSetId === dataSetId) {
              return false
            }
            if (index === targetIndex) {
              return false
            }
            return true
          }),
        }

        if (filteredContext.dataSets.length > 0) {
          displayDataSetList(filteredContext)
          log.line('')
          log.flush()
        }
        log.line('')
        log.flush()
      }

      const found = displayDataSetStatus(context, dataSetId)
      if (!found) {
        cancel('Data set not found')
        process.exitCode = 1
        return
      }
    } else {
      spinner.stop('━━━ Data Sets ━━━')

      if (shouldList) {
        displayDataSetList(context)
      }
    }

    outro('Data set inspection complete')
  } catch (error) {
    spinner.stop(`${pc.red('✗')} Failed to inspect data sets`)

    log.line('')
    log.line(`${pc.red('Error:')} ${error instanceof Error ? error.message : String(error)}`)
    log.flush()

    cancel('Inspection failed')
    process.exitCode = 1
  } finally {
    await cleanupSynapseService()
  }
}
