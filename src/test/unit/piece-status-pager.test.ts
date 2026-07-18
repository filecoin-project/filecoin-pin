/**
 * Unit tests for the piece-status interactive pager
 *
 * `runPager` (the generic alt-screen navigation engine) is mocked here so
 * these tests focus on this module's own logic: buffering pieces across
 * on-chain batches, the metadata enrichment/prefetch dedup and retry
 * behavior, page sizing, and rendering. Generic pager navigation mechanics
 * (arrow keys, q, Ctrl+C, cleanup) are covered in cli-pager.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PieceStatus } from '../../core/data-set/types.js'
import { runPieceStatusPager } from '../../data-set/piece-status-pager.js'

const { mockIterateDataSetPieces, mockEnrichPieceMetadata, mockRunPager, mockLogSection, state } = vi.hoisted(() => {
  const state = {
    batches: [] as Array<{ pieces: any[]; hasMore: boolean }>,
    capturedOptions: undefined as any,
    pagerResolve: undefined as (() => void) | undefined,
    pagerReject: undefined as ((error: unknown) => void) | undefined,
  }

  const mockIterateDataSetPieces = vi.fn((..._args: any[]) => {
    async function* gen() {
      for (const batch of state.batches) {
        yield batch
      }
    }
    return gen()
  })

  const mockEnrichPieceMetadata = vi.fn(async (_synapse: any, _dataSetId: any, piece: any): Promise<any> => {
    piece.metadata = {}
    return undefined
  })

  const mockRunPager = vi.fn(async (options: any) => {
    state.capturedOptions = options
    return new Promise<void>((resolve, reject) => {
      state.pagerResolve = resolve
      state.pagerReject = reject
    })
  })

  const mockLogSection = vi.fn()

  return { mockIterateDataSetPieces, mockEnrichPieceMetadata, mockRunPager, mockLogSection, state }
})

vi.mock('../../core/data-set/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../core/data-set/index.js')>('../../core/data-set/index.js')
  return {
    ...actual,
    iterateDataSetPieces: mockIterateDataSetPieces,
    enrichPieceMetadata: mockEnrichPieceMetadata,
  }
})

vi.mock('../../utils/cli-pager.js', () => ({
  runPager: mockRunPager,
}))

vi.mock('../../utils/cli-logger.js', async () => {
  const actual = await vi.importActual<typeof import('../../utils/cli-logger.js')>('../../utils/cli-logger.js')
  return {
    ...actual,
    log: { ...actual.log, section: mockLogSection },
  }
})

const fakeSynapse = { chain: { name: 'calibration' }, client: {} } as any

function makeDataSet(overrides: Partial<{ dataSetId: bigint; activePieceCount: number }> = {}): any {
  return {
    dataSetId: 158n,
    activePieceCount: 3,
    provider: { pdp: { serviceURL: 'https://pdp.local' } },
    ...overrides,
  }
}

function makePiece(pieceId: bigint, pieceCid: string): any {
  return { pieceId, pieceCid, status: PieceStatus.ACTIVE }
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

describe('runPieceStatusPager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.batches = []
    state.capturedOptions = undefined
    state.pagerResolve = undefined
    state.pagerReject = undefined
    mockEnrichPieceMetadata.mockImplementation(async (_synapse: any, _dataSetId: any, piece: any) => {
      piece.metadata = {}
      return undefined
    })
  })

  afterEach(() => {
    state.pagerResolve?.()
  })

  it('loads pieces from a single on-chain batch and forwards dataSetId/serviceURL', async () => {
    state.batches = [{ pieces: [makePiece(0n, 'bafkpiece0'), makePiece(1n, 'bafkpiece1')], hasMore: false }]

    const resultPromise = runPieceStatusPager(fakeSynapse, makeDataSet(), { output: { rows: 24 } as any })
    await vi.waitFor(() => expect(state.capturedOptions).toBeDefined())

    expect(mockIterateDataSetPieces).toHaveBeenCalledWith(fakeSynapse, 158n, 'https://pdp.local')
    expect(state.capturedOptions.firstPage.page.pieces.map((p: any) => p.pieceCid)).toEqual([
      'bafkpiece0',
      'bafkpiece1',
    ])
    expect(state.capturedOptions.firstPage.hasNext).toBe(false)

    state.pagerResolve?.()
    await resultPromise
  })

  it('slices a page across two on-chain batches when pageSize is larger than one batch', async () => {
    // rows=17 -> pageSize=2 (RESERVED_CHROME_LINES=11, LINES_PER_PIECE=3)
    state.batches = [
      { pieces: [makePiece(0n, 'bafkpiece0')], hasMore: true },
      { pieces: [makePiece(1n, 'bafkpiece1')], hasMore: false },
    ]

    const resultPromise = runPieceStatusPager(fakeSynapse, makeDataSet(), { output: { rows: 17 } as any })
    await vi.waitFor(() => expect(state.capturedOptions).toBeDefined())

    expect(state.capturedOptions.firstPage.page.pieces.map((p: any) => p.pieceCid)).toEqual([
      'bafkpiece0',
      'bafkpiece1',
    ])

    state.pagerResolve?.()
    await resultPromise
  })

  it('prefetches the rest of a buffered batch in the background and reuses it on a later page without re-fetching', async () => {
    // rows=12 -> pageSize=1
    state.batches = [
      {
        pieces: [makePiece(0n, 'bafkpiece0'), makePiece(1n, 'bafkpiece1'), makePiece(2n, 'bafkpiece2')],
        hasMore: false,
      },
    ]

    const resultPromise = runPieceStatusPager(fakeSynapse, makeDataSet(), { output: { rows: 12 } as any })
    await vi.waitFor(() => expect(state.capturedOptions).toBeDefined())
    expect(state.capturedOptions.firstPage.page.pieces.map((p: any) => p.pieceCid)).toEqual(['bafkpiece0'])

    // Background prefetch for pieces 1 and 2 should complete without being asked.
    await vi.waitFor(() => expect(mockEnrichPieceMetadata).toHaveBeenCalledTimes(3))

    const secondPage = await state.capturedOptions.loadPage(1)
    expect(secondPage.page.pieces.map((p: any) => p.pieceCid)).toEqual(['bafkpiece1'])
    // Still 3: the second page's piece was already enriched by the background prefetch.
    expect(mockEnrichPieceMetadata).toHaveBeenCalledTimes(3)

    state.pagerResolve?.()
    await resultPromise
  })

  it('does not resolve a page until its own piece metadata fetch resolves', async () => {
    state.batches = [{ pieces: [makePiece(0n, 'bafkpiece0')], hasMore: false }]
    const deferred = createDeferred<undefined>()
    mockEnrichPieceMetadata.mockImplementationOnce(async () => deferred.promise)

    const resultPromise = runPieceStatusPager(fakeSynapse, makeDataSet(), { output: { rows: 12 } as any })

    await flush()
    expect(state.capturedOptions).toBeUndefined()

    deferred.resolve(undefined)
    await vi.waitFor(() => expect(state.capturedOptions).toBeDefined())

    state.pagerResolve?.()
    await resultPromise
  })

  it('evicts a failed metadata fetch so revisiting the same page retries it', async () => {
    state.batches = [{ pieces: [makePiece(0n, 'bafkpiece0')], hasMore: false }]
    mockEnrichPieceMetadata.mockImplementationOnce(async () => ({
      code: 'METADATA_FETCH_FAILED',
      message: 'boom',
      context: {},
    }))

    const resultPromise = runPieceStatusPager(fakeSynapse, makeDataSet(), { output: { rows: 12 } as any })
    await vi.waitFor(() => expect(state.capturedOptions).toBeDefined())
    expect(state.capturedOptions.firstPage.page.pieces[0].metadata).toBeUndefined()

    const retried = await state.capturedOptions.loadPage(0)
    expect(retried.page.pieces[0].metadata).toBeDefined()
    expect(mockEnrichPieceMetadata).toHaveBeenCalledTimes(2)

    state.pagerResolve?.()
    await resultPromise
  })

  it.each([
    { rows: 24, expectedPageSize: 4 },
    { rows: undefined, expectedPageSize: 1 },
    { rows: 1000, expectedPageSize: 20 },
  ])('derives page size $expectedPageSize from output.rows=$rows', async ({ rows, expectedPageSize }) => {
    state.batches = [
      { pieces: Array.from({ length: 25 }, (_, i) => makePiece(BigInt(i), `bafkpiece${i}`)), hasMore: false },
    ]

    const resultPromise = runPieceStatusPager(fakeSynapse, makeDataSet(), { output: { rows } as any })
    await vi.waitFor(() => expect(state.capturedOptions).toBeDefined())

    expect(state.capturedOptions.firstPage.page.pieces).toHaveLength(expectedPageSize)

    state.pagerResolve?.()
    await resultPromise
  })

  it('shows "Page N" before the iterator is drained and "Page N of M" once it is', async () => {
    state.batches = [{ pieces: [makePiece(0n, 'bafkpiece0')], hasMore: false }]
    const resultPromise = runPieceStatusPager(fakeSynapse, makeDataSet(), { output: { rows: 12 } as any })
    await vi.waitFor(() => expect(state.capturedOptions).toBeDefined())

    const notDone = state.capturedOptions.renderPage({ pieces: [], iteratorDone: false, totalLoaded: 0 }, 0, {
      loading: false,
    })
    expect(notDone).toContain('Page 1')
    expect(notDone).not.toContain('Page 1 of')

    // pageSize is 1 here (rows=12), so 5 loaded pieces means 5 pages.
    const done = state.capturedOptions.renderPage({ pieces: [], iteratorDone: true, totalLoaded: 5 }, 0, {
      loading: false,
    })
    expect(done).toContain('Page 1 of 5')

    state.pagerResolve?.()
    await resultPromise
  })

  it('distinguishes a metadata fetch failure from a successful fetch with no root CID', async () => {
    state.batches = [{ pieces: [makePiece(0n, 'bafkpiece0')], hasMore: false }]
    const resultPromise = runPieceStatusPager(fakeSynapse, makeDataSet(), { output: { rows: 12 } as any })
    await vi.waitFor(() => expect(state.capturedOptions).toBeDefined())

    const failedPiece = { ...makePiece(0n, 'bafkpiece0'), metadata: undefined }
    const failedRender = state.capturedOptions.renderPage(
      { pieces: [failedPiece], iteratorDone: true, totalLoaded: 1 },
      0,
      { loading: false }
    )
    expect(failedRender).toContain('metadata fetch failed')

    const noCidPiece = { ...makePiece(1n, 'bafkpiece1'), metadata: {} }
    const noCidRender = state.capturedOptions.renderPage(
      { pieces: [noCidPiece], iteratorDone: true, totalLoaded: 1 },
      0,
      { loading: false }
    )
    expect(noCidRender).not.toContain('metadata fetch failed')
    expect(noCidRender).toContain('-')

    const withRootCidPiece = { ...makePiece(2n, 'bafkpiece2'), metadata: {}, rootIpfsCid: 'bafyroot2' }
    const withRootCidRender = state.capturedOptions.renderPage(
      { pieces: [withRootCidPiece], iteratorDone: true, totalLoaded: 1 },
      0,
      { loading: false }
    )
    expect(withRootCidRender).toContain('bafyroot2')

    state.pagerResolve?.()
    await resultPromise
  })

  it('shows the loading footer for the target page being navigated to, not the displayed one', async () => {
    state.batches = [{ pieces: [makePiece(0n, 'bafkpiece0')], hasMore: false }]
    const resultPromise = runPieceStatusPager(fakeSynapse, makeDataSet(), { output: { rows: 12 } as any })
    await vi.waitFor(() => expect(state.capturedOptions).toBeDefined())

    const rendered = state.capturedOptions.renderPage({ pieces: [], iteratorDone: false, totalLoaded: 0 }, 2, {
      loading: true,
      loadingPageIndex: 1,
    })
    expect(rendered).toContain('Loading page 2...')
    expect(rendered).not.toContain('Loading page 3...')

    state.pagerResolve?.()
    await resultPromise
  })

  it('shows the navigation footer and a tip referencing the real data set id when not loading', async () => {
    state.batches = [{ pieces: [makePiece(0n, 'bafkpiece0')], hasMore: false }]
    const resultPromise = runPieceStatusPager(fakeSynapse, makeDataSet({ dataSetId: 999n }), {
      output: { rows: 12 } as any,
    })
    await vi.waitFor(() => expect(state.capturedOptions).toBeDefined())

    const rendered = state.capturedOptions.renderPage({ pieces: [], iteratorDone: true, totalLoaded: 1 }, 0, {
      loading: false,
    })
    expect(rendered).toContain('Navigate:')
    expect(rendered).toContain('q quit')
    expect(rendered).toContain('data-set piece-status 999 <pieceCid>')

    state.pagerResolve?.()
    await resultPromise
  })

  it('cleans up and propagates the error when the pager rejects', async () => {
    state.batches = [{ pieces: [makePiece(0n, 'bafkpiece0')], hasMore: false }]
    const resultPromise = runPieceStatusPager(fakeSynapse, makeDataSet(), { output: { rows: 12 } as any })
    await vi.waitFor(() => expect(state.capturedOptions).toBeDefined())

    state.pagerReject?.(new Error('boom'))

    await expect(resultPromise).rejects.toThrow('boom')
    expect(mockLogSection).not.toHaveBeenCalled()
  })

  it('logs a summary with network, data set id, and active piece count after the pager exits', async () => {
    state.batches = [{ pieces: [makePiece(0n, 'bafkpiece0')], hasMore: false }]
    const resultPromise = runPieceStatusPager(fakeSynapse, makeDataSet({ dataSetId: 158n, activePieceCount: 42 }), {
      output: { rows: 12 } as any,
    })
    await vi.waitFor(() => expect(state.capturedOptions).toBeDefined())

    state.pagerResolve?.()
    await resultPromise

    expect(mockLogSection).toHaveBeenCalledWith(
      'Summary',
      expect.arrayContaining([
        expect.stringContaining('calibration'),
        expect.stringContaining('158'),
        expect.stringContaining('42'),
      ])
    )
  })
})
