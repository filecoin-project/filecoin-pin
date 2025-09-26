import { METADATA_KEYS } from '@filoz/synapse-sdk'
import pc from 'picocolors'
import { formatFileSize } from '../utils/cli-helpers.js'
import { log } from '../utils/cli-logger.js'
import type { DataSetDetail, DataSetInspectionContext, PieceDetail } from './types.js'

function statusLabel(dataSet: DataSetDetail['base']): string {
  if (dataSet.isLive) {
    return pc.green('live')
  }

  if (dataSet.pdpEndEpoch > 0) {
    return pc.red(`terminated @ epoch ${dataSet.pdpEndEpoch}`)
  }

  return pc.yellow('inactive')
}

function providerLabel(provider: DataSetDetail['provider'], dataSet: DataSetDetail['base']): string {
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

function renderPiece(piece: PieceDetail, baseIndentLevel: number = 2): void {
  const rootCid = piece.metadata[METADATA_KEYS.IPFS_ROOT_CID]
  const rootDisplay = rootCid ?? pc.gray('unknown')
  // const leafCountDisplay = piece.leafCount != null ? piece.leafCount.toString() : pc.gray('unknown')
  // const sizeDisplay = formatBytes(piece.sizeBytes)

  log.indent(`#${piece.pieceId}`, baseIndentLevel)
  log.indent(`CommP: ${piece.pieceCid}`, baseIndentLevel + 1)
  log.indent(`Root CID: ${rootDisplay}`, baseIndentLevel + 1)
  // log.indent(`Leaf count: ${leafCountDisplay}`, baseIndentLevel + 1)
  // log.indent(`Size: ${sizeDisplay}`, baseIndentLevel + 1)

  const extraMetadataEntries = Object.entries(piece.metadata).filter(([key]) => key !== METADATA_KEYS.IPFS_ROOT_CID)

  if (extraMetadataEntries.length > 0) {
    log.indent('Metadata:', baseIndentLevel + 1)
    for (const [key, value] of extraMetadataEntries) {
      const displayValue = value === '' ? pc.gray('(empty)') : value
      log.indent(`${key}: ${displayValue}`, baseIndentLevel + 2)
    }
  }
}

export function displayDataSetList(ctx: DataSetInspectionContext): void {
  log.line(`Address: ${ctx.address}`)
  log.line(`Network: ${pc.bold(ctx.network)}`)
  log.line('')

  if (ctx.dataSets.length === 0) {
    log.line(pc.yellow('No data sets managed by filecoin-pin were found for this account.'))
    log.flush()
    return
  }

  const ordered = [...ctx.dataSets].sort((a, b) => a.base.pdpVerifierDataSetId - b.base.pdpVerifierDataSetId)

  for (const dataSet of ordered) {
    const { base, provider } = dataSet
    const annotations: string[] = []

    if (base.isManaged) {
      annotations.push(pc.gray('managed'))
    } else {
      annotations.push(pc.yellow('external'))
    }

    if (base.withCDN) {
      annotations.push(pc.cyan('cdn'))
    }

    log.line(
      `${pc.bold(`#${base.pdpVerifierDataSetId}`)} • ${statusLabel(base)}${
        annotations.length > 0 ? ` • ${annotations.join(', ')}` : ''
      }`
    )
    log.indent(`Provider: ${providerLabel(provider, base)}`)
    log.indent(`Pieces stored: ${base.currentPieceCount}`)
    log.indent(`Leaf count: ${dataSet.leafCount != null ? dataSet.leafCount.toString() : pc.gray('unknown')}`)
    log.indent(`Total size: ${formatBytes(dataSet.totalSizeBytes)}`)
    log.indent(`Client data set ID: ${base.clientDataSetId}`)
    log.indent(`PDP rail ID: ${base.pdpRailId}`)
    log.indent(`CDN rail ID: ${base.cdnRailId > 0 ? base.cdnRailId : 'none'}`)
    log.indent(`Cache-miss rail ID: ${base.cacheMissRailId > 0 ? base.cacheMissRailId : 'none'}`)
    log.indent(`Payer: ${base.payer}`)
    log.indent(`Payee: ${base.payee}`)
    log.line('')

    log.indent(pc.bold('Metadata'))
    renderMetadata(dataSet.metadata, 2)
    log.line('')

    if (dataSet.warnings.length > 0) {
      log.indent(pc.bold(pc.yellow('Warnings')))
      for (const warning of dataSet.warnings) {
        log.indent(pc.yellow(`- ${warning}`), 2)
      }
      log.line('')
    }

    log.indent(pc.bold('Pieces'))
    if (dataSet.pieces.length === 0) {
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

export function displayDataSetStatus(ctx: DataSetInspectionContext, dataSetId: number): boolean {
  const dataSet = ctx.dataSets.find((item) => item.base.pdpVerifierDataSetId === dataSetId)
  if (dataSet == null) {
    log.line(pc.red(`No data set found with ID ${dataSetId}`))
    log.flush()
    return false
  }

  const { base, provider } = dataSet

  log.line(`${pc.bold(`Data Set #${base.pdpVerifierDataSetId}`)} • ${statusLabel(base)}`)
  log.indent(`Managed by Warm Storage: ${base.isManaged ? 'yes' : 'no'}`)
  log.indent(`CDN add-on: ${base.withCDN ? 'enabled' : 'disabled'}`)
  log.indent(`Pieces stored: ${base.currentPieceCount}`)
  log.indent(`Leaf count: ${dataSet.leafCount != null ? dataSet.leafCount.toString() : pc.gray('unknown')}`)
  log.indent(`Total size: ${formatBytes(dataSet.totalSizeBytes)}`)
  log.indent(`Client data set ID: ${base.clientDataSetId}`)
  log.indent(`PDP rail ID: ${base.pdpRailId}`)
  log.indent(`CDN rail ID: ${base.cdnRailId > 0 ? base.cdnRailId : 'none'}`)
  log.indent(`Cache-miss rail ID: ${base.cacheMissRailId > 0 ? base.cacheMissRailId : 'none'}`)
  log.indent(`Payer: ${base.payer}`)
  log.indent(`Payee: ${base.payee}`)
  log.indent(`Service provider: ${base.serviceProvider}`)
  log.indent(`Provider: ${providerLabel(provider, base)}`)
  log.indent(`Commission: ${formatCommission(base.commissionBps)}`)

  if (base.pdpEndEpoch > 0) {
    log.indent(pc.yellow(`PDP payments ended @ epoch ${base.pdpEndEpoch}`))
  }
  if (base.cdnEndEpoch > 0) {
    log.indent(pc.yellow(`CDN payments ended @ epoch ${base.cdnEndEpoch}`))
  }

  log.line('')
  log.line(pc.bold('Metadata'))
  renderMetadata(dataSet.metadata, 2)
  log.line('')

  if (dataSet.warnings.length > 0) {
    log.line(pc.bold(pc.yellow('Warnings')))
    for (const warning of dataSet.warnings) {
      log.indent(pc.yellow(`- ${warning}`))
    }
    log.line('')
  }

  log.line(pc.bold('Pieces'))
  if (dataSet.pieces.length === 0) {
    log.indent(pc.gray('No piece information available'))
  } else {
    for (const piece of dataSet.pieces) {
      renderPiece(piece, 1)
    }
  }

  log.flush()
  return true
}
