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
  promptDataSetSelection,
  truncate,
} from '../../common/upload-flow.js'
import { createLogger } from '../../logger.js'

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
    { dataSetId: 1n, activePieceCount: 2n, metadata: { source: 'a' } },
    { dataSetId: 2n, activePieceCount: 3n, metadata: { source: 'b' } },
    { dataSetId: 3n, activePieceCount: 1n, metadata: { source: 'c' } },
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
      { dataSetId: 1n, activePieceCount: 0n, metadata: { env: 'prod', region: 'us-east' } },
      { dataSetId: 2n, activePieceCount: 0n, metadata: { env: 'prod', region: 'us-east' } },
    ] as any[]
    expect(differentiatingKeys(datasets)).toEqual(expect.arrayContaining(['env', 'region']))
  })

  it('returns only the keys whose values differ across datasets', () => {
    const datasets = [
      { dataSetId: 1n, activePieceCount: 0n, metadata: { source: 'alpha', env: 'prod' } },
      { dataSetId: 2n, activePieceCount: 0n, metadata: { source: 'beta', env: 'prod' } },
    ] as any[]
    expect(differentiatingKeys(datasets)).toEqual(['source'])
  })

  it('collects keys that appear on any dataset, not just all of them', () => {
    const datasets = [
      { dataSetId: 1n, activePieceCount: 0n, metadata: { source: 'a' } },
      { dataSetId: 2n, activePieceCount: 0n, metadata: { source: 'a', region: 'us' } },
    ] as any[]
    // 'region' only exists on one dataset — undefined vs 'us' differs, so it's included
    expect(differentiatingKeys(datasets)).toContain('region')
  })
})

describe('buildOptionLabel', () => {
  it('shows dataset ID and piece count with no metadata keys', () => {
    const ds = { dataSetId: 5n, activePieceCount: 0n, metadata: {} } as any
    expect(buildOptionLabel(ds, [])).toBe('#5  (0 pieces)')
  })

  it('uses singular "piece" when activePieceCount is 1', () => {
    const ds = { dataSetId: 5n, activePieceCount: 1n, metadata: {} } as any
    expect(buildOptionLabel(ds, [])).toBe('#5  (1 piece)')
  })

  it('shows key=value pairs for the provided keys', () => {
    const ds = { dataSetId: 1n, activePieceCount: 2n, metadata: { source: 'alpha' } } as any
    const label = buildOptionLabel(ds, ['source'])
    expect(label).toContain('source=alpha')
    expect(label).toContain('(2 pieces)')
  })

  it('shows just the key name when the metadata value is an empty string', () => {
    const ds = { dataSetId: 1n, activePieceCount: 0n, metadata: { source: '' } } as any
    const label = buildOptionLabel(ds, ['source'])
    expect(label).toContain('source')
    expect(label).not.toContain('source=')
  })

  it('caps visible pairs at 3 and appends an overflow suffix for the rest', () => {
    const ds = { dataSetId: 1n, activePieceCount: 0n, metadata: { a: '1', b: '2', c: '3', d: '4' } } as any
    const label = buildOptionLabel(ds, ['a', 'b', 'c', 'd'])
    expect(label).toContain('(+1 more)')
    expect(label).toContain('a=1')
    expect(label).not.toContain('d=4')
  })

  it('truncates metadata values longer than 20 characters', () => {
    const ds = { dataSetId: 1n, activePieceCount: 0n, metadata: { v: 'abcdefghijklmnopqrstuvwxyz' } } as any
    const label = buildOptionLabel(ds, ['v'])
    expect(label).toContain('v=abcdefghijklm…uvwxyz')
  })
})
