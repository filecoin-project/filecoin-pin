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

function formatCommission(commissionBps: number): string {
  const percent = commissionBps / 100
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

// /**
//  * Format payment token address for display
//  */
// function formatPaymentToken(tokenAddress: string): string {
//   // import { CONTRACT_ADDRESSES } from '@filoz/synapse-sdk'
//   if (tokenAddress === '0x0000000000000000000000000000000000000000' || tokenAddress === CONTRACT_ADDRESSES.USDFC['calibration']) {
//     return `USDFC ${pc.gray('(native)')}`
//   }

//   // For other addresses, show a truncated version
//   return `${tokenAddress.slice(0, 6)}...${tokenAddress.slice(-4)}`
// }

// /**
//  * Format storage price in USDFC per TiB per month
//  * Always shows TiB/month for consistency, with appropriate precision
//  */
// function formatStoragePrice(pricePerTiBPerDay: bigint): string {
//   // import { ethers } from 'ethers'
//   try {
//     const priceInUSDFC = parseFloat(ethers.formatUnits(pricePerTiBPerDay, 18))

//     // Handle very small prices that would show as 0.0000
//     if (priceInUSDFC < 0.0001) {
//       return '< 0.0001 USDFC/TiB/day'
//     }

//     // For prices >= 0.0001, show with appropriate precision
//     if (priceInUSDFC >= 1) {
//       return `${priceInUSDFC.toFixed(2)} USDFC/TiB/day`
//     } else if (priceInUSDFC >= 0.01) {
//       return `${priceInUSDFC.toFixed(4)} USDFC/TiB/day`
//     } else {
//       return `${priceInUSDFC.toFixed(6)} USDFC/TiB/day`
//     }
//   } catch {
//     return pc.red('invalid price')
//   }
// }

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
  log.indent(`Service URL: ${dataSet.provider.products.PDP?.data?.serviceURL ?? 'unknown'}`, indentLevel + 1)
  log.indent(`Active: ${dataSet.provider.active ? 'yes' : 'no'}`, indentLevel + 1)
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
  log.indent(`Location: ${dataSet.provider.products.PDP?.data?.location ?? 'unknown'}`, indentLevel + 1)
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
  log.indent(`Total pieces: ${dataSet.currentPieceCount}`, indentLevel + 1)
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
export function displayDataSets(dataSets: DataSetSummary[], network: string, address: string): void {
  if (dataSets.length === 0) {
    log.line(pc.yellow('No data sets managed by filecoin-pin were found for this account.'))
    log.flush()
    return
  }
  renderNetworkDetails(network, address)

  const ordered = [...dataSets].sort((a, b) => a.dataSetId - b.dataSetId)

  for (const dataSet of ordered) {
    renderDataSetHeader(dataSet)
    renderProviderDetails(dataSet, 1)
    renderMetadata(dataSet.metadata, 1)
    renderPaymentDetails(dataSet, 1)
    renderPieces(dataSet, 1)
  }

  log.flush()
}
