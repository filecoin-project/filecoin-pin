import { METADATA_KEYS } from '@filoz/synapse-sdk'
import pc from 'picocolors'
import type { DataSetSummary, PieceInfo } from '../core/data-set/types.js'
import { PieceStatus } from '../core/data-set/types.js'
import { formatFileSize } from '../utils/cli-helpers.js'
import { log } from '../utils/cli-logger.js'

/**
 * Convert dataset lifecycle information into a coloured status label.
 */
function statusLabel(dataSet: DataSetSummary): string {
  if (dataSet.isLive) {
    return pc.green('live')
  }

  if (dataSet.pdpEndEpoch > 0) {
    return pc.red(`terminated @ epoch ${dataSet.pdpEndEpoch}`)
  }

  return pc.yellow('inactive')
}

function formatCommission(commissionBps: bigint): string {
  const percent = Number(commissionBps) / 100
  return `${percent.toFixed(2)}%`
}

function formatBytes(value?: bigint): string {
  if (value == null) {
    return pc.gray('unknown')
  }

  if (value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return formatFileSize(Number(value))
  }

  return `${value.toString()} B`
}

function renderNetworkDetails(network: string, address: string): void {
  log.line(`Network: ${pc.bold(network)}`)
  log.line(`Client address: ${address}`)
  log.line('')
}

function renderDataSetHeader(dataSet: DataSetSummary): void {
  log.line(`${pc.bold(`#${dataSet.dataSetId}`)}`)
  log.indent(`Status: ${statusLabel(dataSet)}`)
  log.indent(`CDN add-on: ${dataSet.withCDN ? 'enabled' : 'disabled'}`)
  log.line('')
}

function renderProviderDetails(dataSet: DataSetSummary, indentLevel: number = 0): void {
  log.indent(pc.bold('Provider'), indentLevel)
  log.indent(`ID: ${dataSet.providerId}`, indentLevel + 1)
  log.indent(`Address: ${dataSet.serviceProvider}`, indentLevel + 1)
  if (dataSet.provider == null) {
    log.line('')
    return
  }
  log.indent(`Name: ${dataSet.provider.name}`, indentLevel + 1)
  log.indent(`Description: ${dataSet.provider.description}`, indentLevel + 1)
  log.indent(`Service URL: ${dataSet.provider.pdp?.serviceURL ?? 'unknown'}`, indentLevel + 1)
  log.indent(`Active: ${dataSet.provider.isActive ? 'yes' : 'no'}`, indentLevel + 1)
  /**
   * We purposefully do not show these fields because they are either not currently relevant to the user, or not fully/accurately representative of FOC and FWSS details.
   */
  // log.indent(
  //   `Min piece size: ${formatBytes(BigInt(dataSet.provider.products.PDP?.data?.minPieceSizeInBytes ?? 0))}`,
  //   indentLevel + 1
  // )
  // log.indent(
  //   `Max piece size: ${formatBytes(BigInt(dataSet.provider.products.PDP?.data?.maxPieceSizeInBytes ?? 0))}`,
  //   indentLevel + 1
  // )
  // log.indent(
  //   `Storage price: ${formatStoragePrice(dataSet.provider.products.PDP?.data?.storagePricePerTibPerDay ?? 0n)}`,
  //   indentLevel + 1
  // )
  // log.indent(
  //   `Min proving period: ${dataSet.provider.products.PDP?.data?.minProvingPeriodInEpochs ?? 0} epochs`,
  //   indentLevel + 1
  // )
  log.indent(`Location: ${dataSet.provider.pdp?.location ?? 'unknown'}`, indentLevel + 1)
  // log.indent(
  //   `Payment token: ${formatPaymentToken(dataSet.provider.products.PDP?.data?.paymentTokenAddress ?? 'unknown')}`,
  //   indentLevel + 1
  // )
  if (dataSet.commissionBps > 0) {
    log.indent(`Commission: ${formatCommission(dataSet.commissionBps)}`, indentLevel + 1)
  }
  log.line('')
}

function renderPaymentDetails(dataSet: DataSetSummary, indentLevel: number = 0): void {
  log.indent(pc.bold('Payment'), indentLevel)
  log.indent(`PDP rail ID: ${dataSet.pdpRailId}`, indentLevel + 1)
  if (dataSet.withCDN) {
    log.indent(`FilBeam rail ID: ${dataSet.cdnRailId > 0 ? dataSet.cdnRailId : 'none'}`, indentLevel + 1)
    log.indent(
      `FilBeam cache-miss rail ID: ${dataSet.cacheMissRailId > 0 ? dataSet.cacheMissRailId : 'none'}`,
      indentLevel + 1
    )
  }
  log.indent(`Payer: ${dataSet.payer}`, indentLevel + 1)
  log.indent(`Payee: ${dataSet.payee}`, indentLevel + 1)
  if (dataSet.pdpEndEpoch > 0) {
    log.indent(pc.yellow(`PDP payments ended @ epoch ${dataSet.pdpEndEpoch}`), indentLevel + 1)
  }
  log.line('')
}

/**
 * Render metadata key-value pairs with consistent indentation.
 */
function renderMetadata(metadata: Record<string, string>, indentLevel: number = 1, title: string = 'Metadata'): void {
  log.indent(pc.bold(title), indentLevel)
  const entries = Object.entries(metadata)
  if (entries.length === 0) {
    log.indent(pc.gray('none'), indentLevel + 1)
    log.line('')
    return
  }

  for (const [key, value] of entries) {
    log.indent(`${key}: "${value}"`, indentLevel + 1)
  }
  log.line('')
}

/**
 * Render a single piece entry including CommP, root CID, size, and extra metadata.
 */
function renderPiece(piece: PieceInfo, baseIndentLevel: number = 2): void {
  const sizeDisplay = piece.size != null ? formatFileSize(piece.size) : pc.gray('unknown')

  let pieceStatusDisplay: string
  switch (piece.status) {
    case PieceStatus.ACTIVE:
      pieceStatusDisplay = pc.green('active')
      break
    case PieceStatus.PENDING_REMOVAL:
      pieceStatusDisplay = pc.yellow('pending removal')
      break
    case PieceStatus.ONCHAIN_ORPHANED:
      pieceStatusDisplay = pc.red('onchain orphaned')
      break
    case PieceStatus.OFFCHAIN_ORPHANED:
      pieceStatusDisplay = pc.red('offchain orphaned')
      break
    default:
      pieceStatusDisplay = pc.gray('unknown')
      break
  }
  log.indent(pc.bold(`#${piece.pieceId} (${pieceStatusDisplay})`), baseIndentLevel)
  log.indent(`PieceCID: ${piece.pieceCid}`, baseIndentLevel + 1)
  log.indent(`Size: ${sizeDisplay}`, baseIndentLevel + 1)
  const extraMetadataEntries = Object.entries(piece.metadata ?? {})
  renderMetadata(Object.fromEntries(extraMetadataEntries), baseIndentLevel + 1)
}

function renderPieces(dataSet: DataSetSummary, indentLevel: number = 0): void {
  log.indent(pc.bold('Pieces'), indentLevel)
  log.indent(`Total pieces: ${dataSet.activePieceCount}`, indentLevel + 1)
  if (dataSet.pieces == null || dataSet.pieces.length === 0) {
    log.line('')
    return
  }
  const uniqueCommPs = new Set(dataSet.pieces.map((p) => p.pieceCid))
  const uniqueRootCids = new Set(
    dataSet.pieces.map((p) => p.rootIpfsCid ?? p.metadata?.[METADATA_KEYS.IPFS_ROOT_CID]).filter(Boolean)
  )
  log.indent(`Total size: ${formatBytes(dataSet.totalSizeBytes)}`, indentLevel + 1)
  log.indent(`Unique PieceCIDs: ${uniqueCommPs.size}`, indentLevel + 1)
  log.indent(`Unique IPFS Root CIDs: ${uniqueRootCids.size}`, indentLevel + 1)
  log.line('')

  for (const piece of dataSet.pieces) {
    renderPiece(piece, indentLevel + 1)
  }
}

/**
 * Print the lightweight dataset list used for the default command output.
 */
export function displayDataSets(
  dataSets: DataSetSummary[],
  network: string,
  address: string,
  emptyMessage?: string
): void {
  if (dataSets.length === 0) {
    log.line(pc.yellow(emptyMessage ?? 'No data sets managed by filecoin-pin were found for this account.'))
    log.flush()
    return
  }
  renderNetworkDetails(network, address)

  const ordered = [...dataSets].sort((a, b) => (a.dataSetId < b.dataSetId ? -1 : a.dataSetId > b.dataSetId ? 1 : 0))

  for (const dataSet of ordered) {
    renderDataSetHeader(dataSet)
    renderProviderDetails(dataSet, 1)
    renderMetadata(dataSet.metadata, 1)
    renderPaymentDetails(dataSet, 1)
    renderPieces(dataSet, 1)
  }

  log.flush()
}
