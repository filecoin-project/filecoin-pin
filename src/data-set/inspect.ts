import { METADATA_KEYS } from '@filoz/synapse-sdk'
import { ethers } from 'ethers'
import pc from 'picocolors'
import type { DataSetSummary, PieceInfo } from '../core/data-set/types.js'
import { formatFileSize } from '../utils/cli-helpers.js'
import { log } from '../utils/cli-logger.js'
import type { DataSetInspectionContext } from './types.js'

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

function providerLabel(provider: DataSetSummary['provider'], dataSet: DataSetSummary): string {
  if (provider != null && provider.name.trim() !== '') {
    return `${provider.name} (ID ${provider.id})`
  }

  return `${dataSet.serviceProvider} (ID ${dataSet.providerId})`
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

/**
 * Format payment token address for display
 */
function formatPaymentToken(tokenAddress: string): string {
  // Zero address typically means native token (FIL) or USDFC
  if (tokenAddress === '0x0000000000000000000000000000000000000000') {
    return `USDFC ${pc.gray('(native)')}`
  }

  // For other addresses, show a truncated version
  return `${tokenAddress.slice(0, 6)}...${tokenAddress.slice(-4)}`
}

/**
 * Format storage price in USDFC per TiB per month
 * Always shows TiB/month for consistency, with appropriate precision
 */
function formatStoragePrice(pricePerTiBPerDay: bigint): string {
  try {
    const priceInUSDFC = parseFloat(ethers.formatUnits(pricePerTiBPerDay, 18))

    // Handle very small prices that would show as 0.0000
    if (priceInUSDFC < 0.0001) {
      return '< 0.0001 USDFC/TiB/day'
    }

    // For prices >= 0.0001, show with appropriate precision
    if (priceInUSDFC >= 1) {
      return `${priceInUSDFC.toFixed(2)} USDFC/TiB/day`
    } else if (priceInUSDFC >= 0.01) {
      return `${priceInUSDFC.toFixed(4)} USDFC/TiB/day`
    } else {
      return `${priceInUSDFC.toFixed(6)} USDFC/TiB/day`
    }
  } catch {
    return pc.red('invalid price')
  }
}

/**
 * Render metadata key-value pairs with consistent indentation.
 */
function renderMetadata(metadata: Record<string, string>, indentLevel: number = 1): void {
  const entries = Object.entries(metadata)
  if (entries.length === 0) {
    log.indent(pc.gray('none'), indentLevel)
    return
  }

  for (const [key, value] of entries) {
    const displayValue = value === '' ? pc.gray('(empty)') : value
    log.indent(`${key}: ${displayValue}`, indentLevel)
  }
}

/**
 * Render a single piece entry including CommP, root CID, size, and extra metadata.
 */
function renderPiece(piece: PieceInfo, baseIndentLevel: number = 2): void {
  const rootDisplay = piece.rootIpfsCid ?? piece.metadata?.[METADATA_KEYS.IPFS_ROOT_CID] ?? pc.gray('unknown')
  const sizeDisplay = piece.size != null ? formatFileSize(piece.size) : pc.gray('unknown')

  log.indent(`#${piece.pieceId}`, baseIndentLevel)
  log.indent(`CommP: ${piece.pieceCid}`, baseIndentLevel + 1)
  log.indent(`Root CID: ${rootDisplay}`, baseIndentLevel + 1)
  log.indent(`Size: ${sizeDisplay}`, baseIndentLevel + 1)

  const extraMetadataEntries = Object.entries(piece.metadata ?? {}).filter(
    ([key]) => key !== METADATA_KEYS.IPFS_ROOT_CID
  )

  if (extraMetadataEntries.length > 0) {
    log.indent('Metadata:', baseIndentLevel + 1)
    for (const [key, value] of extraMetadataEntries) {
      const displayValue = value === '' ? pc.gray('(empty)') : value
      log.indent(`${key}: ${displayValue}`, baseIndentLevel + 2)
    }
  }
}

/**
 * Print the lightweight dataset list used for the default command output.
 */
export function displayDataSetList(ctx: DataSetInspectionContext): void {
  log.line(`Address: ${ctx.address}`)
  log.line(`Network: ${pc.bold(ctx.network)}`)
  log.line('')

  if (ctx.dataSets.length === 0) {
    log.line(pc.yellow('No data sets managed by filecoin-pin were found for this account.'))
    log.flush()
    return
  }

  const ordered = [...ctx.dataSets].sort((a, b) => a.dataSetId - b.dataSetId)

  for (const dataSet of ordered) {
    const annotations: string[] = []

    if (dataSet.isManaged) {
      annotations.push(pc.gray('managed'))
    } else {
      annotations.push(pc.yellow('external'))
    }

    if (dataSet.withCDN) {
      annotations.push(pc.cyan('cdn'))
    }

    log.line(
      `${pc.bold(`#${dataSet.dataSetId}`)} • ${statusLabel(dataSet)}${
        annotations.length > 0 ? ` • ${annotations.join(', ')}` : ''
      }`
    )
    log.indent(`Provider: ${providerLabel(dataSet.provider, dataSet)}`)
    log.indent(`Pieces stored: ${dataSet.currentPieceCount}`)
    log.indent(`Total size: ${formatBytes(dataSet.totalSizeBytes)}`)
    log.indent(`Client data set ID: ${dataSet.clientDataSetId}`)
    log.indent(`PDP rail ID: ${dataSet.pdpRailId}`)
    log.indent(`CDN rail ID: ${dataSet.cdnRailId > 0 ? dataSet.cdnRailId : 'none'}`)
    log.indent(`Cache-miss rail ID: ${dataSet.cacheMissRailId > 0 ? dataSet.cacheMissRailId : 'none'}`)
    log.indent(`Payer: ${dataSet.payer}`)
    log.indent(`Payee: ${dataSet.payee}`)
    log.line('')

    log.indent(pc.bold('Metadata'))
    renderMetadata(dataSet.metadata ?? {}, 2)
    log.line('')

    if (dataSet.warnings != null && dataSet.warnings.length > 0) {
      log.indent(pc.bold(pc.yellow('Warnings')))
      for (const warning of dataSet.warnings) {
        log.indent(pc.yellow(`- ${warning}`), 2)
      }
      log.line('')
    }

    log.indent(pc.bold('Pieces'))
    if (dataSet.pieces == null || dataSet.pieces.length === 0) {
      log.indent(pc.gray('No piece information available'), 2)
    } else {
      for (const piece of dataSet.pieces) {
        renderPiece(piece, 2)
      }
    }

    log.line('')
  }

  log.flush()
}

/**
 * Render detailed information for a single dataset.
 *
 * @returns true when the dataset exists; false otherwise.
 */
export function displayDataSetStatus(ctx: DataSetInspectionContext, dataSetId: number): boolean {
  const dataSet = ctx.dataSets.find((item) => item.dataSetId === dataSetId)
  if (dataSet == null) {
    log.line(pc.red(`No data set found with ID ${dataSetId}`))
    log.flush()
    return false
  }

  log.line(`${pc.bold(`Data Set #${dataSet.dataSetId}`)} • ${statusLabel(dataSet)}`)
  log.indent(`Managed by Warm Storage: ${dataSet.isManaged ? 'yes' : 'no'}`)
  log.indent(`CDN add-on: ${dataSet.withCDN ? 'enabled' : 'disabled'}`)
  log.indent(`Pieces stored: ${dataSet.currentPieceCount}`)
  log.indent(`Total size: ${formatBytes(dataSet.totalSizeBytes)}`)
  log.indent(`Client data set ID: ${dataSet.clientDataSetId}`)
  log.indent(`PDP rail ID: ${dataSet.pdpRailId}`)
  log.indent(`CDN rail ID: ${dataSet.cdnRailId > 0 ? dataSet.cdnRailId : 'none'}`)
  log.indent(`Cache-miss rail ID: ${dataSet.cacheMissRailId > 0 ? dataSet.cacheMissRailId : 'none'}`)
  log.indent(`Payer: ${dataSet.payer}`)
  log.indent(`Payee: ${dataSet.payee}`)
  log.indent(`Service provider: ${dataSet.serviceProvider}`)
  log.indent(`Provider: ${providerLabel(dataSet.provider, dataSet)}`)
  log.indent(`Commission: ${formatCommission(dataSet.commissionBps)}`)

  // Add provider service information
  if (dataSet.provider?.products?.PDP?.data) {
    const pdpData = dataSet.provider.products.PDP.data
    log.line('')
    log.line(pc.bold('Provider Service'))
    log.indent(`Service URL: ${pdpData.serviceURL}`)
    log.indent(`Min piece size: ${formatBytes(BigInt(pdpData.minPieceSizeInBytes))}`)
    log.indent(`Max piece size: ${formatBytes(BigInt(pdpData.maxPieceSizeInBytes))}`)
    log.indent(`Storage price: ${formatStoragePrice(pdpData.storagePricePerTibPerDay)}`)
    log.indent(`Min proving period: ${pdpData.minProvingPeriodInEpochs} epochs`)
    log.indent(`Location: ${pdpData.location}`)
    log.indent(`Payment token: ${formatPaymentToken(pdpData.paymentTokenAddress)}`)
  }

  if (dataSet.pdpEndEpoch > 0) {
    log.indent(pc.yellow(`PDP payments ended @ epoch ${dataSet.pdpEndEpoch}`))
  }

  log.line('')
  log.line(pc.bold('Metadata'))
  renderMetadata(dataSet.metadata ?? {}, 2)
  log.line('')

  if (dataSet.warnings != null && dataSet.warnings.length > 0) {
    log.line(pc.bold(pc.yellow('Warnings')))
    for (const warning of dataSet.warnings) {
      log.indent(pc.yellow(`- ${warning}`))
    }
    log.line('')
  }

  log.line('')
  log.line(pc.bold('Pieces'))
  if (dataSet.pieces == null || dataSet.pieces.length === 0) {
    log.indent(pc.gray('No piece information available'))
  } else {
    // Show piece summary
    const uniqueCommPs = new Set(dataSet.pieces.map((p) => p.pieceCid))
    const uniqueRootCids = new Set(
      dataSet.pieces.map((p) => p.rootIpfsCid ?? p.metadata?.[METADATA_KEYS.IPFS_ROOT_CID]).filter(Boolean)
    )

    log.indent(`Total pieces: ${dataSet.pieces.length}`)
    log.indent(`Unique CommPs: ${uniqueCommPs.size}`)
    log.indent(`Unique root CIDs: ${uniqueRootCids.size}`)
    log.line('')

    for (const piece of dataSet.pieces) {
      renderPiece(piece, 1)
    }
  }

  log.flush()
  return true
}
