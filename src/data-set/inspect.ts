import type { EnhancedDataSetInfo } from '@filoz/synapse-sdk'
import type { ProviderInfo } from '@filoz/synapse-sdk'
import pc from 'picocolors'
import { log } from '../utils/cli-logger.js'

export interface DataSetInspectionContext {
  address: string
  network: string
  dataSets: EnhancedDataSetInfo[]
  providers: Map<number, ProviderInfo>
}

function statusLabel(dataSet: EnhancedDataSetInfo): string {
  if (dataSet.isLive) {
    return pc.green('live')
  }

  if (dataSet.pdpEndEpoch > 0) {
    return pc.red(`terminated @ epoch ${dataSet.pdpEndEpoch}`)
  }

  return pc.yellow('inactive')
}

function providerLabel(
  provider: ProviderInfo | undefined,
  dataSet: EnhancedDataSetInfo
): string {
  if (provider != null && provider.name.trim() !== '') {
    return `${provider.name} (ID ${provider.id})`
  }

  return `${dataSet.serviceProvider} (ID ${dataSet.providerId})`
}

function formatCommission(commissionBps: number): string {
  const percent = commissionBps / 100
  return `${percent.toFixed(2)}%`
}

function renderMetadata(metadata: Record<string, string>): void {
  const entries = Object.entries(metadata)
  if (entries.length === 0) {
    log.indent(pc.gray('none'))
    return
  }

  for (const [key, value] of entries) {
    const displayValue = value === '' ? pc.gray('(empty)') : value
    log.indent(`${key}: ${displayValue}`)
  }
}

export function displayDataSetList(ctx: DataSetInspectionContext): void {
  log.line(`Address: ${ctx.address}`)
  log.line(`Network: ${pc.bold(ctx.network)}`)
  log.line('')

  if (ctx.dataSets.length === 0) {
    log.line(pc.yellow('No data sets found for this account.'))
    log.flush()
    return
  }

  const ordered = [...ctx.dataSets].sort(
    (a, b) => a.pdpVerifierDataSetId - b.pdpVerifierDataSetId
  )

  for (const dataSet of ordered) {
    const provider = ctx.providers.get(dataSet.providerId)
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
      `${pc.bold(`#${dataSet.pdpVerifierDataSetId}`)} • ${statusLabel(dataSet)}${
        annotations.length > 0 ? ` • ${annotations.join(', ')}` : ''
      }`
    )
    log.indent(`Provider: ${providerLabel(provider, dataSet)}`)
    log.indent(`Pieces stored: ${dataSet.currentPieceCount}`)
    log.indent(`Next piece ID: ${dataSet.nextPieceId}`)
    log.line('')
  }

  log.flush()
}

export function displayDataSetStatus(
  ctx: DataSetInspectionContext,
  dataSetId: number
): boolean {
  const dataSet = ctx.dataSets.find((item) => item.pdpVerifierDataSetId === dataSetId)
  if (dataSet == null) {
    log.line(pc.red(`No data set found with ID ${dataSetId}`))
    log.flush()
    return false
  }

  const provider = ctx.providers.get(dataSet.providerId)

  log.line(
    `${pc.bold(`Data Set #${dataSet.pdpVerifierDataSetId}`)} • ${statusLabel(dataSet)}`
  )
  log.indent(`Managed by Warm Storage: ${dataSet.isManaged ? 'yes' : 'no'}`)
  log.indent(`CDN add-on: ${dataSet.withCDN ? 'enabled' : 'disabled'}`)
  log.indent(`Pieces stored: ${dataSet.currentPieceCount}`)
  log.indent(`Next piece ID: ${dataSet.nextPieceId}`)
  log.indent(`Client data set ID: ${dataSet.clientDataSetId}`)
  log.indent(`PDP rail ID: ${dataSet.pdpRailId}`)
  log.indent(`CDN rail ID: ${dataSet.cdnRailId > 0 ? dataSet.cdnRailId : 'none'}`)
  log.indent(`Cache-miss rail ID: ${
    dataSet.cacheMissRailId > 0 ? dataSet.cacheMissRailId : 'none'
  }`)
  log.indent(`Payer: ${dataSet.payer}`)
  log.indent(`Payee: ${dataSet.payee}`)
  log.indent(`Service provider: ${dataSet.serviceProvider}`)
  log.indent(`Provider: ${providerLabel(provider, dataSet)}`)
  log.indent(`Commission: ${formatCommission(dataSet.commissionBps)}`)

  if (dataSet.pdpEndEpoch > 0) {
    log.indent(pc.yellow(`PDP payments ended @ epoch ${dataSet.pdpEndEpoch}`))
  }
  if (dataSet.cdnEndEpoch > 0) {
    log.indent(pc.yellow(`CDN payments ended @ epoch ${dataSet.cdnEndEpoch}`))
  }

  log.line('')
  log.line(pc.bold('Metadata'))
  renderMetadata(dataSet.metadata ?? {})

  log.flush()
  return true
}
