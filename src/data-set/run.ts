import type { EnhancedDataSetInfo, ProviderInfo } from '@filoz/synapse-sdk'
import { PDPServer, PDPVerifier, RPC_URLS, Synapse, WarmStorageService } from '@filoz/synapse-sdk'
import pc from 'picocolors'
import { cleanupProvider } from '../core/synapse/index.js'
import { cancel, createSpinner, intro, outro } from '../utils/cli-helpers.js'
import { log } from '../utils/cli-logger.js'
import { displayDataSetList, displayDataSetStatus } from './inspect.js'
import type { DataSetCommandOptions, DataSetDetail, DataSetInspectionContext, PieceDetail } from './types.js'

/**
 * Fetch piece-level metadata for a dataset without triggering PDP lookups.
 *
 * @param params - Context required to inspect the piece
 */
async function collectPieceDetail(params: {
  dataSetId: number
  pieceId: number
  pieceCid: string
  warmStorage: WarmStorageService
}): Promise<PieceDetail> {
  const { dataSetId, pieceId, pieceCid, warmStorage } = params
  const metadata = await warmStorage.getPieceMetadata(dataSetId, pieceId).catch(() => ({}) as Record<string, string>)
  const pieceDetail: PieceDetail = {
    pieceId,
    pieceCid,
    metadata: { ...metadata },
  }

  return pieceDetail
}

/**
 * Build the lightweight inspection context used when no dataset ID is provided.
 * Only metadata cached in Synapse responses is included so the command returns quickly.
 */
function buildSummaryContext(params: {
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

  const managedDataSets = params.dataSets.filter((dataSet) => dataSet.metadata?.source === 'filecoin-pin')

  const dataSetDetails: DataSetDetail[] = managedDataSets.map((dataSet) => {
    const detail: DataSetDetail = {
      base: dataSet,
      metadata: { ...(dataSet.metadata ?? {}) },
      pieces: [],
      warnings: [],
    }

    const provider = providerMap.get(dataSet.providerId)
    if (provider != null) {
      detail.provider = provider
    }

    return detail
  })

  return {
    address: params.address,
    network: params.network,
    dataSets: dataSetDetails,
  }
}

/**
 * Enrich a summary dataset entry with live information from WarmStorage and PDP.
 *
 * Populates leaf counts, total size estimates, piece metadata, and warning messages.
 */
async function loadDetailedDataSet(detail: DataSetDetail, synapse: Synapse): Promise<DataSetDetail> {
  const result: DataSetDetail = {
    base: detail.base,
    metadata: { ...detail.metadata },
    pieces: detail.pieces.map((piece) => ({
      ...piece,
      metadata: { ...piece.metadata },
    })),
    warnings: [...detail.warnings],
  }

  if (detail.provider != null) {
    result.provider = detail.provider
  }
  if (detail.leafCount != null) {
    result.leafCount = detail.leafCount
  }
  if (detail.totalSizeBytes != null) {
    result.totalSizeBytes = detail.totalSizeBytes
  }

  let warmStorage: WarmStorageService
  try {
    warmStorage = await WarmStorageService.create(synapse.getProvider(), synapse.getWarmStorageAddress())
  } catch (error) {
    result.warnings.push(
      `Unable to initialize Warm Storage service: ${error instanceof Error ? error.message : String(error)}`
    )
    return result
  }

  const pdpVerifier = new PDPVerifier(synapse.getProvider(), warmStorage.getPDPVerifierAddress())

  try {
    const rawLeafCount = await pdpVerifier.getDataSetLeafCount(result.base.pdpVerifierDataSetId)
    const leafCount = BigInt(rawLeafCount)
    result.leafCount = leafCount
    result.totalSizeBytes = leafCount * 32n
  } catch (error) {
    result.warnings.push(`Unable to fetch leaf count: ${error instanceof Error ? error.message : String(error)}`)
  }

  const serviceURL = result.provider?.products?.PDP?.data?.serviceURL
  if (serviceURL == null || serviceURL.trim() === '') {
    result.warnings.push('Provider does not expose a PDP service URL; piece details unavailable')
    return result
  }

  try {
    const pdpServer = new PDPServer(null, serviceURL)
    const dataSetData = await pdpServer.getDataSet(result.base.pdpVerifierDataSetId)
    const pieces = await Promise.all(
      dataSetData.pieces.map(async (piece) => {
        try {
          return await collectPieceDetail({
            dataSetId: result.base.pdpVerifierDataSetId,
            pieceId: piece.pieceId,
            pieceCid: piece.pieceCid.toString(),
            warmStorage,
          })
        } catch (error) {
          result.warnings.push(
            `Failed to inspect piece #${piece.pieceId}: ${error instanceof Error ? error.message : String(error)}`
          )
          return {
            pieceId: piece.pieceId,
            pieceCid: piece.pieceCid.toString(),
            metadata: {},
          }
        }
      })
    )

    pieces.sort((a, b) => a.pieceId - b.pieceId)
    result.pieces = pieces
  } catch (error) {
    result.warnings.push(`Failed to fetch piece list: ${error instanceof Error ? error.message : String(error)}`)
  }

  return result
}

/**
 * Resolve the private key from CLI options or environment variables.
 *
 * @throws Never returns when the key cannot be resolved; exits the process instead.
 */
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

/**
 * Resolve the RPC endpoint, preferring CLI options over environment defaults.
 */
function resolveRpcUrl(options: DataSetCommandOptions): string {
  return options.rpcUrl ?? process.env.RPC_URL ?? RPC_URLS.calibration.websocket
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

    const context = buildSummaryContext({
      address,
      network,
      dataSets,
      providers: storageInfo?.providers ?? null,
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

      const targetIndex = context.dataSets.findIndex((item) => item.base.pdpVerifierDataSetId === dataSetId)

      if (targetIndex === -1) {
        spinner.stop('━━━ Data Sets ━━━')
        cancel('Data set not found')
        process.exitCode = 1
        return
      }

      spinner.message('Collecting data set details...')

      const baseDetail = context.dataSets[targetIndex]
      if (baseDetail == null) {
        spinner.stop('━━━ Data Sets ━━━')
        cancel('Data set not found')
        process.exitCode = 1
        return
      }
      const detailed = await loadDetailedDataSet(baseDetail, synapse)
      context.dataSets[targetIndex] = detailed

      spinner.stop('━━━ Data Sets ━━━')

      if (shouldList) {
        const filteredContext: DataSetInspectionContext = {
          ...context,
          dataSets: context.dataSets.filter((entry, index) => {
            if (entry.base.pdpVerifierDataSetId === dataSetId) {
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
    await cleanupProvider(provider)
  }
}
