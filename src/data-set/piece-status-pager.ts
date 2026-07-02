/**
 * Interactive piece-status pager
 *
 * Drives the generic `runPager` from `utils/cli-pager.ts` over pieces pulled
 * lazily from `iterateDataSetPieces`, enriching each page with WarmStorage
 * metadata before it is shown.
 *
 * @module data-set/piece-status-pager
 */

import { METADATA_KEYS, type Synapse } from '@filoz/synapse-sdk'
import PQueue from 'p-queue'
import pc from 'picocolors'
import {
  type DataSetSummary,
  enrichPieceMetadata,
  type IterateDataSetPiecesResult,
  iterateDataSetPieces,
  type PieceInfo,
  PieceStatus,
} from '../core/data-set/index.js'
import { formatFileSize, type Spinner } from '../utils/cli-helpers.js'
import { log } from '../utils/cli-logger.js'
import { type PagerPageResult, runPager } from '../utils/cli-pager.js'
import { truncate } from '../utils/format.js'

const MAX_PAGE_SIZE = 20
const MIN_PAGE_SIZE = 1
/** Concurrency cap for background metadata prefetch, so paging ahead doesn't burst dozens of concurrent RPCs */
const PREFETCH_CONCURRENCY = 10
/** Approximate terminal rows consumed by each piece block (row + ipfsRootCID line + blank line) */
const LINES_PER_PIECE = 3
/** Approximate terminal rows consumed by header/footer chrome around the piece list (network line, title, total-pieces line, page label, navigation footer, blank line, tip line, and spacing) */
const RESERVED_CHROME_LINES = 11
const PIECE_CID_DISPLAY_LENGTH = 70
const ROOT_CID_DISPLAY_LENGTH = 16
const PIECE_DETAIL_INDENT = ' '.repeat(11)

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
  // Keyed by pieceId -> the in-flight/resolved enrichment request, so a page
  // is never rendered before its own pieces' enrichment has actually
  // resolved, regardless of whether it was started by this page's own load
  // or by a previous page's background prefetch.
  const metadataRequests = new Map<string, Promise<void>>()
  // Bounds background enrichment so a single buffered on-chain batch doesn't
  // fire dozens of concurrent getAllPieceMetadata calls at once.
  const prefetchQueue = new PQueue({ concurrency: PREFETCH_CONCURRENCY })

  // Fetches metadata for `piece` and evicts its cache entry on failure so a
  // future visit can retry. Shared by the immediate (foreground) and queued
  // (background prefetch) paths.
  const runEnrich = (piece: PieceInfo): Promise<void> => {
    const cacheKey = piece.pieceId.toString()
    return enrichPieceMetadata(synapse, dataSet.dataSetId, piece).then((warning) => {
      if (warning) {
        metadataRequests.delete(cacheKey)
      }
    })
  }

  const enrichOne = (piece: PieceInfo): Promise<void> => {
    const cacheKey = piece.pieceId.toString()
    let pending = metadataRequests.get(cacheKey)
    if (!pending) {
      pending = runEnrich(piece)
      metadataRequests.set(cacheKey, pending)
    }
    return pending
  }

  const ensureEnriched = (pieces: PieceInfo[]) => Promise.all(pieces.map(enrichOne))

  const prefetchRest = (pieces: PieceInfo[]): void => {
    for (const piece of pieces) {
      const cacheKey = piece.pieceId.toString()
      if (metadataRequests.has(cacheKey)) {
        continue
      }
      // Reserve the slot now, at enqueue time, so a later prefetchRest sweep
      // for the same piece sees it's already scheduled and skips adding a
      // duplicate queue job - even before this one has run.
      metadataRequests.set(
        cacheKey,
        prefetchQueue.add(() => runEnrich(piece))
      )
    }
  }

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
    await ensureEnriched(pagePieces)

    // Kick off background enrichment for the rest of what's already buffered
    // but not yet shown, so navigating forward later finds it in flight or done.
    prefetchRest(buffer.slice(start + pageSize))

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

  try {
    await runPager({ firstPage, loadPage, renderPage, input, output })
  } finally {
    prefetchQueue.clear()
  }

  log.section('Summary', [
    `Network: ${network}`,
    `Data set: #${dataSet.dataSetId}`,
    `Total active pieces: ${dataSet.activePieceCount}`,
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
    pc.gray(`Total active pieces: ${dataSet.activePieceCount}`),
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
      pc.dim(`  Tip: Run "filecoin-pin data-set piece-status ${dataSet.dataSetId} <pieceCid>" for full details`)
    )
  }

  return `${lines.join('\n')}\n`
}

function formatPieceBlock(piece: PieceInfo): string {
  const id = `#${piece.pieceId}`.padEnd(8)
  const pieceCid = truncate(piece.pieceCid, PIECE_CID_DISPLAY_LENGTH).padEnd(PIECE_CID_DISPLAY_LENGTH + 2)
  const size = formatPieceSize(piece).padEnd(10)
  const row = `  ${pc.bold(id)} ${pieceCid} ${size} ${formatPieceStatus(piece.status)}`
  return [row, `${PIECE_DETAIL_INDENT}${pc.gray('ipfsRootCID:')} ${formatRootCid(piece)}`].join('\n')
}

function formatPieceSize(piece: PieceInfo): string {
  return piece.size == null ? pc.gray('unknown') : formatFileSize(piece.size)
}

function formatRootCid(piece: PieceInfo): string {
  // enrichPieceMetadata always sets piece.metadata on success (even to {} when
  // the piece has no metadata entries) and only leaves it unset when the fetch
  // itself threw. So metadata == null means the fetch failed - distinct from a
  // successful fetch that simply found no IPFS root CID for this piece.
  if (piece.metadata == null) {
    return pc.yellow('metadata fetch failed')
  }
  const rootCid = piece.rootIpfsCid ?? piece.metadata[METADATA_KEYS.IPFS_ROOT_CID]
  return rootCid == null || rootCid === '' ? pc.gray('-') : truncate(rootCid, ROOT_CID_DISPLAY_LENGTH)
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
