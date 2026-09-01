import { CID } from 'multiformats/cid'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../utils/cli-logger.js', () => ({
  log: {
    line: vi.fn(),
    indent: vi.fn(),
    flush: vi.fn(),
  },
}))

vi.mock('../../utils/cli-helpers.js', async () => {
  const actual = await vi.importActual('../../utils/cli-helpers.js')
  return {
    ...actual,
    isInteractive: vi.fn().mockReturnValue(false),
    cancel: vi.fn(),
  }
})

const mocks = vi.hoisted(() => ({
  executeUpload: vi.fn(),
  multiselect: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
}))

vi.mock('@clack/prompts', () => ({
  multiselect: mocks.multiselect,
  isCancel: mocks.isCancel,
}))

vi.mock('../../core/upload/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../core/upload/index.js')>('../../core/upload/index.js')
  return {
    ...actual,
    executeUpload: mocks.executeUpload,
  }
})

import {
  buildOptionLabel,
  differentiatingKeys,
  displayUploadResults,
  performUpload,
  pickDataSetsForReuse,
  promptDataSetSelection,
  resolveDefaultDataSetReuse,
  resolveUploadTargets,
} from '../../common/upload-flow.js'
import { createLogger } from '../../logger.js'
import { truncate } from '../../utils/format.js'

const TEST_CID = CID.parse('bafkreia5fn4rmshmb7cl7fufkpcw733b5anhuhydtqstnglpkzosqln5kq')

const sampleResult = {
  filePath: '/tmp/foo.txt',
  fileSize: 100,
  rootCid: 'bafyrootcid',
  pieceCid: 'bafkpiececid',
  size: 100,
  copies: [
    {
      providerId: 1n,
      dataSetId: 100n,
      pieceId: 1n,
      role: 'primary' as const,
      retrievalUrl: 'https://sp1.test/piece/bafkpiececid',
      isNewDataSet: false,
    },
  ],
  failedAttempts: [],
}

describe('promptDataSetSelection', () => {
  const spinner = { start: vi.fn(), stop: vi.fn(), message: vi.fn(), clear: vi.fn() }

  beforeEach(() => {
    mocks.multiselect.mockReset()
    mocks.isCancel.mockReturnValue(false)
  })

  const dataSets = [
    { dataSetId: 1n, hasActivePieces: true, metadata: { source: 'a' } },
    { dataSetId: 2n, hasActivePieces: true, metadata: { source: 'b' } },
    { dataSetId: 3n, hasActivePieces: true, metadata: { source: 'c' } },
  ] as any[]

  it('throws with the hard error message when not in a TTY', async () => {
    const { isInteractive } = await import('../../utils/cli-helpers.js')
    vi.mocked(isInteractive).mockReturnValue(false)

    await expect(promptDataSetSelection(dataSets, 1, spinner)).rejects.toThrow(/matched 3 data sets.*expected 1/)
  })

  it('returns the chosen data set ids when the user selects the correct count', async () => {
    const { isInteractive } = await import('../../utils/cli-helpers.js')
    vi.mocked(isInteractive).mockReturnValue(true)
    mocks.multiselect.mockResolvedValueOnce([1n, 2n])

    const result = await promptDataSetSelection(dataSets, 2, spinner)

    expect(result).toEqual([1n, 2n])
    expect(mocks.multiselect).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('2'),
        options: expect.arrayContaining([
          expect.objectContaining({ value: 1n }),
          expect.objectContaining({ value: 2n }),
          expect.objectContaining({ value: 3n }),
        ]),
      })
    )
  })

  it('re-prompts when the user selects the wrong count, then returns on correct selection', async () => {
    const { isInteractive } = await import('../../utils/cli-helpers.js')
    vi.mocked(isInteractive).mockReturnValue(true)
    mocks.multiselect
      .mockResolvedValueOnce([1n]) // wrong: only 1 selected
      .mockResolvedValueOnce([1n, 2n]) // correct

    const result = await promptDataSetSelection(dataSets, 2, spinner)

    expect(result).toEqual([1n, 2n])
    expect(mocks.multiselect).toHaveBeenCalledTimes(2)
    expect(mocks.multiselect.mock.calls[1]?.[0].message).toMatch(/Please select exactly 2/)
  })
})

describe('displayUploadResults egress block', () => {
  beforeEach(async () => {
    const { log } = await import('../../utils/cli-logger.js')
    vi.mocked(log.line).mockClear()
    vi.mocked(log.indent).mockClear()
  })

  it('does not print FilBeam block when egress is undefined', async () => {
    displayUploadResults(sampleResult, 'Add', 'Calibration', 'calibration')
    const { log } = await import('../../utils/cli-logger.js')
    const lines = vi.mocked(log.line).mock.calls.map(([m]) => m as string)
    expect(lines.some((l) => l.includes('FilBeam Egress'))).toBe(false)
  })

  it('does not print FilBeam block when egress.filbeamUrl is missing', async () => {
    displayUploadResults(sampleResult, 'Add', 'Calibration', 'calibration', {})
    const { log } = await import('../../utils/cli-logger.js')
    const lines = vi.mocked(log.line).mock.calls.map(([m]) => m as string)
    expect(lines.some((l) => l.includes('FilBeam Egress'))).toBe(false)
  })

  it('prints FilBeam block with URL, note, and disable hint when filbeamUrl is provided', async () => {
    displayUploadResults(sampleResult, 'Add', 'Calibration', 'calibration', {
      filbeamUrl: 'https://0xabc.calibration.filbeam.io/bafkpiececid',
    })
    const { log } = await import('../../utils/cli-logger.js')
    const lines = vi.mocked(log.line).mock.calls.map(([m]) => m as string)
    const indents = vi.mocked(log.indent).mock.calls.map(([m]) => m as string)
    expect(lines).toEqual(expect.arrayContaining([expect.stringContaining('FilBeam Egress')]))
    expect(indents).toEqual(
      expect.arrayContaining([
        expect.stringContaining('URL: '),
        expect.stringContaining('https://0xabc.calibration.filbeam.io/bafkpiececid'),
        expect.stringContaining('serves CAR/piece data, not the original file'),
        expect.stringContaining('Disable on next upload: --egress-provider none'),
      ])
    )
  })
})

describe('performUpload', () => {
  it('updates the spinner with byte-level upload progress', async () => {
    const spinner = {
      start: vi.fn(),
      message: vi.fn(),
      stop: vi.fn(),
      clear: vi.fn(),
    }

    mocks.executeUpload.mockImplementation(async (_synapse, _data, _rootCid, options) => {
      options.onProgress?.({ type: 'uploadProgress', data: { bytesUploaded: 2 } })
      options.onProgress?.({
        type: 'stored',
        data: {
          providerId: 1n,
          pieceCid: 'bafkzcibtest123',
        },
      })

      return {
        pieceCid: 'bafkzcibtest123',
        size: 4,
        requestedCopies: 1,
        complete: true,
        copies: [
          {
            providerId: 1n,
            dataSetId: 123n,
            pieceId: 456n,
            role: 'primary',
            retrievalUrl: 'https://provider.example/piece/test',
            isNewDataSet: false,
          },
        ],
        failedAttempts: [],
        network: 'calibration',
      }
    })

    await performUpload({ chain: { id: 314159, name: 'calibration' } } as any, new Uint8Array([1, 2, 3, 4]), TEST_CID, {
      contextType: 'add',
      fileSize: 4,
      logger: createLogger({ logLevel: 'info' }),
      spinner,
      skipIpniVerification: true,
    })

    expect(spinner.start).toHaveBeenCalledWith('Uploading to Filecoin...')
    expect(spinner.message).toHaveBeenCalledWith('Uploading to Filecoin... 2.0 B/4.0 B (50%)')
    expect(spinner.stop).toHaveBeenCalledWith(expect.stringContaining('Stored on provider 1'))
  })

  it('deduplicates spinner updates for unchanged and clamped upload percentages', async () => {
    const spinner = {
      start: vi.fn(),
      message: vi.fn(),
      stop: vi.fn(),
      clear: vi.fn(),
    }

    mocks.executeUpload.mockImplementation(async (_synapse, _data, _rootCid, options) => {
      options.onProgress?.({ type: 'uploadProgress', data: { bytesUploaded: 1 } })
      options.onProgress?.({ type: 'uploadProgress', data: { bytesUploaded: 1 } })
      options.onProgress?.({ type: 'uploadProgress', data: { bytesUploaded: 2 } })
      options.onProgress?.({ type: 'uploadProgress', data: { bytesUploaded: 4 } })
      options.onProgress?.({ type: 'uploadProgress', data: { bytesUploaded: 8 } })
      options.onProgress?.({
        type: 'stored',
        data: {
          providerId: 1n,
          pieceCid: 'bafkzcibtest123',
        },
      })

      return {
        pieceCid: 'bafkzcibtest123',
        size: 4,
        requestedCopies: 1,
        complete: true,
        copies: [
          {
            providerId: 1n,
            dataSetId: 123n,
            pieceId: 456n,
            role: 'primary',
            retrievalUrl: 'https://provider.example/piece/test',
            isNewDataSet: false,
          },
        ],
        failedAttempts: [],
        network: 'calibration',
      }
    })

    await performUpload({ chain: { id: 314159, name: 'calibration' } } as any, new Uint8Array([1, 2, 3, 4]), TEST_CID, {
      contextType: 'add',
      fileSize: 4,
      logger: createLogger({ logLevel: 'info' }),
      spinner,
      skipIpniVerification: true,
    })

    expect(spinner.message).toHaveBeenCalledTimes(3)
    expect(spinner.message).toHaveBeenNthCalledWith(1, 'Uploading to Filecoin... 1.0 B/4.0 B (25%)')
    expect(spinner.message).toHaveBeenNthCalledWith(2, 'Uploading to Filecoin... 2.0 B/4.0 B (50%)')
    expect(spinner.message).toHaveBeenNthCalledWith(3, 'Uploading to Filecoin... 4.0 B/4.0 B (100%)')
  })

  it('reports each provider on its own line when piece-sync polls multiple providers concurrently', async () => {
    const spinner = { start: vi.fn(), message: vi.fn(), stop: vi.fn(), clear: vi.fn() }

    mocks.executeUpload.mockImplementation(async (_synapse, _data, _rootCid, options) => {
      options.onProgress?.({ type: 'stored', data: { providerId: 1n, pieceCid: 'bafkzcibtest123' } })
      options.onProgress?.({
        type: 'pieceSyncStatus:retryUpdate',
        data: {
          serviceURL: 'https://a.example.com',
          providerIndex: 1,
          providerCount: 2,
          providerAttempt: 1,
          providerMaxAttempts: 20,
        },
      })
      options.onProgress?.({
        type: 'pieceSyncStatus:retryUpdate',
        data: {
          serviceURL: 'https://b.example.com',
          providerIndex: 2,
          providerCount: 2,
          providerAttempt: 1,
          providerMaxAttempts: 20,
        },
      })
      options.onProgress?.({
        type: 'pieceSyncStatus:providerSynced',
        data: { serviceURL: 'https://a.example.com', providerIndex: 1, providerCount: 2 },
      })
      options.onProgress?.({
        type: 'pieceSyncStatus:providerSynced',
        data: { serviceURL: 'https://b.example.com', providerIndex: 2, providerCount: 2 },
      })
      options.onProgress?.({ type: 'pieceSyncStatus:complete', data: { providerCount: 2 } })

      return { ...sampleResult, requestedCopies: 2, network: 'calibration' }
    })

    await performUpload({ chain: { id: 314159, name: 'calibration' } } as any, new Uint8Array([1, 2, 3, 4]), TEST_CID, {
      contextType: 'add',
      fileSize: 4,
      logger: createLogger({ logLevel: 'info' }),
      spinner,
    })

    expect(spinner.stop).toHaveBeenCalledWith(
      expect.stringContaining('[1/2] Advertisement confirmed indexed on https://a.example.com')
    )
    expect(spinner.stop).toHaveBeenCalledWith(
      expect.stringContaining('[2/2] Advertisement confirmed indexed on https://b.example.com')
    )

    const { log } = await import('../../utils/cli-logger.js')
    const lines = vi.mocked(log.line).mock.calls.map(([m]) => m as string)
    expect(lines.some((l) => l.includes('confirmed indexed on all 2 providers'))).toBe(true)
  })

  it('does not leave a stuck spinner entry for a still-polling sibling when piece-sync fails overall', async () => {
    const spinner = { start: vi.fn(), message: vi.fn(), stop: vi.fn(), clear: vi.fn() }

    mocks.executeUpload.mockImplementation(async (_synapse, _data, _rootCid, options) => {
      options.onProgress?.({ type: 'stored', data: { providerId: 1n, pieceCid: 'bafkzcibtest123' } })
      options.onProgress?.({
        type: 'pieceSyncStatus:retryUpdate',
        data: {
          serviceURL: 'https://a.example.com',
          providerIndex: 1,
          providerCount: 2,
          providerAttempt: 1,
          providerMaxAttempts: 20,
        },
      })
      options.onProgress?.({
        type: 'pieceSyncStatus:retryUpdate',
        data: {
          serviceURL: 'https://b.example.com',
          providerIndex: 2,
          providerCount: 2,
          providerAttempt: 1,
          providerMaxAttempts: 20,
        },
      })
      // Provider 1 syncs; provider 2 never does, so the group fails overall.
      options.onProgress?.({
        type: 'pieceSyncStatus:providerSynced',
        data: { serviceURL: 'https://a.example.com', providerIndex: 1, providerCount: 2 },
      })
      options.onProgress?.({
        type: 'pieceSyncStatus:failed',
        data: {
          error: new Error('Piece "x" not synced on "https://b.example.com" after 20 attempts'),
          providerCount: 2,
        },
      })

      // Mirrors real executeUpload: an indexing-confirmation failure is caught internally
      // and surfaces as ipniValidated: false, not a rejection.
      return { ...sampleResult, requestedCopies: 1, network: 'calibration', ipniValidated: false }
    })

    await performUpload({ chain: { id: 314159, name: 'calibration' } } as any, new Uint8Array([1, 2, 3, 4]), TEST_CID, {
      contextType: 'add',
      fileSize: 4,
      logger: createLogger({ logLevel: 'info' }),
      spinner,
    })

    expect(spinner.stop).toHaveBeenCalledWith(
      expect.stringContaining('[1/2] Advertisement confirmed indexed on https://a.example.com')
    )
    expect(spinner.stop).toHaveBeenCalledWith(expect.stringContaining('Advertisement not confirmed indexed in time.'))
    // No leftover "piece-sync-2" completion — it was discarded, not individually reported as done.
    expect(spinner.stop).not.toHaveBeenCalledWith(expect.stringContaining('[2/2] Advertisement confirmed indexed'))
  })
})

describe('truncate', () => {
  it('returns the string unchanged when it fits within the limit', () => {
    expect(truncate('hello', 10)).toBe('hello')
    expect(truncate('exactly20chars123456', 20)).toBe('exactly20chars123456')
  })

  it('returns an empty string when max is 0 or negative', () => {
    expect(truncate('hello', 0)).toBe('')
    expect(truncate('hello', -1)).toBe('')
  })

  it('truncates at the end with an ellipsis when max is 7 or less', () => {
    expect(truncate('abcdefgh', 5)).toBe('abcd…')
    expect(truncate('abcdefgh', 7)).toBe('abcdef…')
  })

  it('middle-truncates when max is greater than 7, preserving the last 6 characters', () => {
    // 26-char input, max=20: slice(0,13)='abcdefghijklm', slice(-6)='uvwxyz'
    expect(truncate('abcdefghijklmnopqrstuvwxyz', 20)).toBe('abcdefghijklm…uvwxyz')
  })

  it('result never exceeds max characters', () => {
    const result = truncate('abcdefghijklmnopqrstuvwxyz', 20)
    expect([...result].length).toBeLessThanOrEqual(20)
  })
})

describe('differentiatingKeys', () => {
  it('returns an empty array for an empty dataset list', () => {
    expect(differentiatingKeys([])).toEqual([])
  })

  it('falls back to all keys when all datasets have uniform metadata values', () => {
    const datasets = [
      { dataSetId: 1n, hasActivePieces: false, metadata: { env: 'prod', region: 'us-east' } },
      { dataSetId: 2n, hasActivePieces: false, metadata: { env: 'prod', region: 'us-east' } },
    ] as any[]
    expect(differentiatingKeys(datasets)).toEqual(expect.arrayContaining(['env', 'region']))
  })

  it('returns only the keys whose values differ across datasets', () => {
    const datasets = [
      { dataSetId: 1n, hasActivePieces: false, metadata: { source: 'alpha', env: 'prod' } },
      { dataSetId: 2n, hasActivePieces: false, metadata: { source: 'beta', env: 'prod' } },
    ] as any[]
    expect(differentiatingKeys(datasets)).toEqual(['source'])
  })

  it('collects keys that appear on any dataset, not just all of them', () => {
    const datasets = [
      { dataSetId: 1n, hasActivePieces: false, metadata: { source: 'a' } },
      { dataSetId: 2n, hasActivePieces: false, metadata: { source: 'a', region: 'us' } },
    ] as any[]
    // 'region' only exists on one dataset — undefined vs 'us' differs, so it's included
    expect(differentiatingKeys(datasets)).toContain('region')
  })
})

describe('buildOptionLabel', () => {
  it('shows an empty dataset label with no metadata keys', () => {
    const ds = { dataSetId: 5n, hasActivePieces: false, metadata: {} } as any
    expect(buildOptionLabel(ds, [])).toBe('#5  (empty)')
  })

  it('shows when a dataset has active pieces', () => {
    const ds = { dataSetId: 5n, hasActivePieces: true, metadata: {} } as any
    expect(buildOptionLabel(ds, [])).toBe('#5  (has pieces)')
  })

  it('shows key=value pairs for the provided keys', () => {
    const ds = { dataSetId: 1n, hasActivePieces: true, metadata: { source: 'alpha' } } as any
    const label = buildOptionLabel(ds, ['source'])
    expect(label).toContain('source=alpha')
    expect(label).toContain('(has pieces)')
  })

  it('shows just the key name when the metadata value is an empty string', () => {
    const ds = { dataSetId: 1n, hasActivePieces: false, metadata: { source: '' } } as any
    const label = buildOptionLabel(ds, ['source'])
    expect(label).toContain('source')
    expect(label).not.toContain('source=')
  })

  it('caps visible pairs at 3 and appends an overflow suffix for the rest', () => {
    const ds = { dataSetId: 1n, hasActivePieces: false, metadata: { a: '1', b: '2', c: '3', d: '4' } } as any
    const label = buildOptionLabel(ds, ['a', 'b', 'c', 'd'])
    expect(label).toContain('(+1 more)')
    expect(label).toContain('a=1')
    expect(label).not.toContain('d=4')
  })

  it('truncates metadata values longer than 20 characters', () => {
    const ds = { dataSetId: 1n, hasActivePieces: false, metadata: { v: 'abcdefghijklmnopqrstuvwxyz' } } as any
    const label = buildOptionLabel(ds, ['v'])
    expect(label).toContain('v=abcdefghijklm…uvwxyz')
  })
})

describe('pickDataSetsForReuse', () => {
  const ds = (o: { dataSetId: bigint; providerId: bigint; pieces: bigint }) =>
    ({ dataSetId: o.dataSetId, providerId: o.providerId, activePieceCount: o.pieces }) as any

  it('picks the data sets storing the most pieces', () => {
    const picked = pickDataSetsForReuse(
      [
        ds({ dataSetId: 101n, providerId: 1n, pieces: 0n }),
        ds({ dataSetId: 102n, providerId: 2n, pieces: 5n }),
        ds({ dataSetId: 103n, providerId: 3n, pieces: 9n }),
      ],
      2
    )
    expect(picked).toEqual([103n, 102n])
  })

  it('breaks piece-count ties by lowest data set ID', () => {
    const picked = pickDataSetsForReuse(
      [
        ds({ dataSetId: 109n, providerId: 1n, pieces: 3n }),
        ds({ dataSetId: 104n, providerId: 2n, pieces: 3n }),
        ds({ dataSetId: 107n, providerId: 3n, pieces: 3n }),
      ],
      2
    )
    expect(picked).toEqual([104n, 107n])
  })

  it('picks at most one data set per provider', () => {
    const picked = pickDataSetsForReuse(
      [
        ds({ dataSetId: 101n, providerId: 1n, pieces: 9n }),
        ds({ dataSetId: 102n, providerId: 1n, pieces: 8n }),
        ds({ dataSetId: 103n, providerId: 2n, pieces: 1n }),
      ],
      2
    )
    expect(picked).toEqual([101n, 103n])
  })

  it('returns fewer than requested when the candidates share providers', () => {
    const picked = pickDataSetsForReuse(
      [ds({ dataSetId: 101n, providerId: 1n, pieces: 9n }), ds({ dataSetId: 102n, providerId: 1n, pieces: 8n })],
      2
    )
    expect(picked).toEqual([101n])
  })
})

const spinner = { start: vi.fn(), stop: vi.fn(), message: vi.fn(), clear: vi.fn() } as any
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any

const makeSynapse = (dataSets: any[]) =>
  ({
    client: { account: { address: '0x1234567890123456789012345678901234567890' } },
    storage: { findDataSets: vi.fn().mockResolvedValue(dataSets) },
  }) as any

const pinSet = (over: Record<string, unknown>) => ({
  isLive: true,
  pdpEndEpoch: 0n,
  activePieceCount: 0n,
  metadata: { withIPFSIndexing: '', source: 'filecoin-pin' },
  ...over,
})

describe('resolveDefaultDataSetReuse', () => {
  it('reuses live filecoin-pin data sets, including ones with extra metadata keys', async () => {
    const synapse = makeSynapse([
      pinSet({
        pdpVerifierDataSetId: 1n,
        providerId: 1n,
        metadata: { withIPFSIndexing: '', source: 'filecoin-pin', withCDN: '' },
      }),
      pinSet({ pdpVerifierDataSetId: 2n, providerId: 2n }),
    ])
    const ids = await resolveDefaultDataSetReuse(synapse, { expectedCopies: 2, withCDN: false, spinner, logger })
    expect(ids).toEqual([1n, 2n])
  })

  it('ignores data sets from other sources, dead ones, and terminating ones', async () => {
    const synapse = makeSynapse([
      pinSet({ pdpVerifierDataSetId: 1n, providerId: 1n, metadata: { withIPFSIndexing: '', source: 'other-tool' } }),
      pinSet({ pdpVerifierDataSetId: 2n, providerId: 2n, isLive: false }),
      pinSet({ pdpVerifierDataSetId: 3n, providerId: 3n, pdpEndEpoch: 100n }),
    ])
    const ids = await resolveDefaultDataSetReuse(synapse, { expectedCopies: 2, withCDN: false, spinner, logger })
    expect(ids).toBeUndefined()
  })

  it('picks the sets storing the most pieces when more match than requested', async () => {
    const synapse = makeSynapse([
      pinSet({ pdpVerifierDataSetId: 1n, providerId: 1n, activePieceCount: 1n }),
      pinSet({ pdpVerifierDataSetId: 2n, providerId: 2n, activePieceCount: 9n }),
      pinSet({ pdpVerifierDataSetId: 3n, providerId: 3n, activePieceCount: 5n }),
    ])
    const ids = await resolveDefaultDataSetReuse(synapse, { expectedCopies: 2, withCDN: false, spinner, logger })
    expect(ids).toEqual([2n, 3n])
  })

  it('returns undefined when fewer sets match than requested copies', async () => {
    const synapse = makeSynapse([pinSet({ pdpVerifierDataSetId: 1n, providerId: 1n })])
    const ids = await resolveDefaultDataSetReuse(synapse, { expectedCopies: 2, withCDN: false, spinner, logger })
    expect(ids).toBeUndefined()
  })

  it('returns undefined when more sets match than requested but they share providers', async () => {
    const synapse = makeSynapse([
      pinSet({ pdpVerifierDataSetId: 1n, providerId: 1n, activePieceCount: 9n }),
      pinSet({ pdpVerifierDataSetId: 2n, providerId: 1n, activePieceCount: 5n }),
      pinSet({ pdpVerifierDataSetId: 3n, providerId: 2n, activePieceCount: 3n }),
      pinSet({ pdpVerifierDataSetId: 4n, providerId: 2n, activePieceCount: 1n }),
    ])
    const ids = await resolveDefaultDataSetReuse(synapse, { expectedCopies: 3, withCDN: false, spinner, logger })
    expect(ids).toBeUndefined()
  })

  it('returns undefined when an exact-count match shares a provider', async () => {
    const synapse = makeSynapse([
      pinSet({ pdpVerifierDataSetId: 1n, providerId: 1n, activePieceCount: 9n }),
      pinSet({ pdpVerifierDataSetId: 2n, providerId: 1n, activePieceCount: 5n }),
    ])
    const ids = await resolveDefaultDataSetReuse(synapse, { expectedCopies: 2, withCDN: false, spinner, logger })
    expect(ids).toBeUndefined()
  })

  it('only reuses CDN-enabled data sets when FilBeam egress is requested', async () => {
    const synapse = makeSynapse([
      pinSet({ pdpVerifierDataSetId: 1n, providerId: 1n }),
      pinSet({
        pdpVerifierDataSetId: 2n,
        providerId: 2n,
        metadata: { withIPFSIndexing: '', source: 'filecoin-pin', withCDN: 'true' },
      }),
    ])
    const ids = await resolveDefaultDataSetReuse(synapse, { expectedCopies: 1, withCDN: true, spinner, logger })
    expect(ids).toEqual([2n])
  })
})

describe('resolveUploadTargets', () => {
  const migrationSet = (id: bigint, providerId: bigint) => ({
    isLive: true,
    pdpEndEpoch: 0n,
    activePieceCount: 0n,
    pdpVerifierDataSetId: id,
    providerId,
    metadata: { source: 'storacha-migration', 'space-did': 'did:key:abc' },
  })

  const base = { withCDN: false, spinner, logger }

  it('leaves explicit targeting alone and carries the metadata through', async () => {
    const synapse = makeSynapse([])
    const targets = await resolveUploadTargets(
      synapse,
      { dataSetIds: [5n] },
      { ...base, dataSetMetadata: { purpose: 'erc8004' } }
    )
    expect(targets).toEqual({ dataSetMetadata: { purpose: 'erc8004' } })
    expect(synapse.storage.findDataSets).not.toHaveBeenCalled()
  })

  it('falls back to default reuse when no metadata filter is given', async () => {
    const synapse = makeSynapse([
      pinSet({ pdpVerifierDataSetId: 1n, providerId: 1n }),
      pinSet({ pdpVerifierDataSetId: 2n, providerId: 2n }),
    ])
    const targets = await resolveUploadTargets(synapse, {}, { ...base, copies: 2 })
    expect(targets).toEqual({ dataSetIds: [1n, 2n] })
  })

  it('resolves --data-set-metadata to data set IDs and drops the filter', async () => {
    const synapse = makeSynapse([migrationSet(13260n, 2n), migrationSet(13261n, 4n)])
    const targets = await resolveUploadTargets(
      synapse,
      {},
      {
        ...base,
        copies: 2,
        dataSetMetadata: { source: 'storacha-migration', 'space-did': 'did:key:abc' },
      }
    )
    expect(targets).toEqual({ dataSetIds: [13260n, 13261n] })
  })

  it('prompts when --data-set-metadata matches more data sets than copies requested', async () => {
    const synapse = makeSynapse([migrationSet(1n, 1n), migrationSet(2n, 2n), migrationSet(3n, 3n)])
    const { isInteractive } = await import('../../utils/cli-helpers.js')
    vi.mocked(isInteractive).mockReturnValueOnce(true)
    mocks.multiselect.mockResolvedValueOnce([2n, 3n])

    const targets = await resolveUploadTargets(
      synapse,
      {},
      {
        ...base,
        copies: 2,
        dataSetMetadata: { source: 'storacha-migration' },
      }
    )
    expect(targets).toEqual({ dataSetIds: [2n, 3n] })
  })

  it('throws when --data-set-metadata matches fewer data sets than copies requested', async () => {
    const synapse = makeSynapse([migrationSet(1n, 1n)])
    await expect(
      resolveUploadTargets(synapse, {}, { ...base, copies: 2, dataSetMetadata: { source: 'storacha-migration' } })
    ).rejects.toThrow(/matched only 1 data set.*expected 2/)
  })

  it('keeps the metadata filter when nothing matches, so a new data set carries it', async () => {
    const synapse = makeSynapse([])
    const targets = await resolveUploadTargets(
      synapse,
      {},
      {
        ...base,
        copies: 2,
        dataSetMetadata: { source: 'brand-new' },
      }
    )
    expect(targets).toEqual({ dataSetMetadata: { source: 'brand-new' } })
  })
})
