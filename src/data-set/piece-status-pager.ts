/**
 * Interactive piece-status pager
 *
 * Drives the generic `runPager` from `utils/cli-pager.ts` over pieces pulled
 * lazily from `iterateDataSetPieces`.
 *
 * @module data-set/piece-status-pager
 */

import type { Synapse } from '@filoz/synapse-sdk'
import pc from 'picocolors'
import {
  type DataSetSummary,
  type IterateDataSetPiecesResult,
  iterateDataSetPieces,
  type PieceInfo,
  PieceStatus,
} from '../core/data-set/index.js'
import { formatFileSize, type Spinner } from '../utils/cli-helpers.js'
import { log } from '../utils/cli-logger.js'
import { type PagerPageResult, runPager } from '../utils/cli-pager.js'

const MAX_PAGE_SIZE = 20
const MIN_PAGE_SIZE = 1
/** Approximate terminal rows consumed by each piece block (row + blank line) */
const LINES_PER_PIECE = 2
/** Approximate terminal rows consumed by header/footer chrome around the piece list (network line, title, piece-presence line, page label, navigation footer, blank line, tip line, and spacing) */
const RESERVED_CHROME_LINES = 11

interface PiecePage {
  pieces: PieceInfo[]
  iteratorDone: boolean
  totalLoaded: number
}

interface PieceStatusPagerOptions {
  spinner?: Spinner
  input?: NodeJS.ReadStream
  output?: NodeJS.WriteStream
}

/**
 * Run the interactive, paginated piece-status viewer for a data set.
 */
export async function runPieceStatusPager(
  synapse: Synapse,
  dataSet: DataSetSummary,
  options: PieceStatusPagerOptions = {}
): Promise<void> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const spinner = options.spinner
  const pageSize = getPageSize(output.rows)
  const network = synapse.chain.name

  const serviceURL = dataSet.provider?.pdp?.serviceURL ?? ''
  const iterator = iterateDataSetPieces(synapse, dataSet.dataSetId, serviceURL)
  // Pieces already pulled from the on-chain iterator but not yet returned as part of a page.
  const buffer: PieceInfo[] = []
  let iteratorDone = false
  let totalLoaded = 0

  const fillBufferTo = async (targetLength: number): Promise<void> => {
    while (buffer.length < targetLength && !iteratorDone) {
      const next = await iterator.next()
      if (next.done === true) {
        iteratorDone = true
        break
      }
      const batch: IterateDataSetPiecesResult = next.value
      buffer.push(...batch.pieces)
      iteratorDone = !batch.hasMore
    }
  }

  const loadPage = async (pageIndex: number): Promise<PagerPageResult<PiecePage>> => {
    await fillBufferTo((pageIndex + 1) * pageSize)

    const start = pageIndex * pageSize
    const pagePieces = buffer.slice(start, start + pageSize)

    totalLoaded = buffer.length
    const hasNext = buffer.length > start + pageSize || !iteratorDone

    return {
      page: { pieces: pagePieces, iteratorDone, totalLoaded },
      hasNext,
    }
  }

  spinner?.message('Fetching piece status...')
  const firstPage = await loadPage(0)
  spinner?.stop('━━━ Piece Status ━━━')

  const renderPage = (
    page: PiecePage,
    pageIndex: number,
    renderOptions: { loading: boolean; loadingPageIndex?: number }
  ): string =>
    renderPiecePage(network, dataSet, page, pageIndex, pageSize, renderOptions.loading, renderOptions.loadingPageIndex)

  await runPager({ firstPage, loadPage, renderPage, input, output })

  log.section('Summary', [
    `Network: ${network}`,
    `Data set: #${dataSet.dataSetId}`,
    `Has active pieces: ${dataSet.hasActivePieces ? 'yes' : 'no'}`,
  ])
}

function getPageSize(rows: number | undefined): number {
  if (rows == null || rows <= RESERVED_CHROME_LINES) {
    return MIN_PAGE_SIZE
  }
  const rowsForPieces = rows - RESERVED_CHROME_LINES
  return Math.max(MIN_PAGE_SIZE, Math.min(MAX_PAGE_SIZE, Math.floor(rowsForPieces / LINES_PER_PIECE)))
}

function renderPiecePage(
  network: string,
  dataSet: DataSetSummary,
  page: PiecePage,
  pageIndex: number,
  pageSize: number,
  loading: boolean,
  loadingPageIndex?: number
): string {
  const currentPage = pageIndex + 1
  const pageLabel = page.iteratorDone
    ? `Page ${currentPage} of ${Math.max(1, Math.ceil(page.totalLoaded / pageSize))}`
    : `Page ${currentPage}`

  const lines = [
    pc.gray(`Network: ${network}`),
    '',
    pc.bold(`Pieces for Data Set #${dataSet.dataSetId}`),
    pc.gray(`Has active pieces: ${dataSet.hasActivePieces ? 'yes' : 'no'}`),
    '',
    pageLabel,
    '',
  ]

  if (page.pieces.length === 0) {
    lines.push(pc.yellow('No pieces found.'))
  } else {
    for (const piece of page.pieces) {
      lines.push(formatPieceBlock(piece), '')
    }
  }

  const hasPrevious = pageIndex > 0
  const hasNext = page.totalLoaded > currentPage * pageSize || !page.iteratorDone
  if (loading) {
    const loadingPage = (loadingPageIndex ?? pageIndex) + 1
    lines.push(pc.gray(`Loading page ${loadingPage}...`))
  } else {
    lines.push(pc.gray(formatNavigationHelp(hasPrevious, hasNext)))
    lines.push('')
    lines.push(
      pc.dim(`  Tip: Run "filecoin-pin data-set piece-status ${dataSet.dataSetId} <pieceCid>" to filter to one piece`)
    )
  }

  return `${lines.join('\n')}\n`
}

function formatPieceBlock(piece: PieceInfo): string {
  const id = `#${piece.pieceId}`.padEnd(6)
  const pieceCid = piece.pieceCid.padEnd(piece.pieceCid.length + 10)
  return `  ${pc.bold(id)} ${pieceCid} ${formatPieceSize(piece)} ${formatPieceStatus(piece.status)}`
}

function formatPieceSize(piece: PieceInfo): string {
  if (piece.size == null) return pc.gray('unknown'.padEnd(10))
  return formatFileSize(piece.size).padEnd(10)
}

function formatPieceStatus(status: PieceStatus): string {
  switch (status) {
    case PieceStatus.ACTIVE:
      return pc.green('active')
    case PieceStatus.PENDING_REMOVAL:
      return pc.yellow('pending removal')
    case PieceStatus.ONCHAIN_ORPHANED:
      return pc.red('onchain orphaned')
    case PieceStatus.OFFCHAIN_ORPHANED:
      return pc.red('offchain orphaned')
  }
}

function formatNavigationHelp(hasPrevious: boolean, hasNext: boolean): string {
  const previous = hasPrevious ? '← previous' : ''
  const next = hasNext ? '→ next' : ''
  const separator = previous !== '' && next !== '' ? ' │ ' : ''
  return `Navigate: ${previous}${separator}${next} │ q quit`
}
