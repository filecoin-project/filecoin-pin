import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../utils/cli-logger.js', () => ({
  log: {
    line: vi.fn(),
    indent: vi.fn(),
    flush: vi.fn(),
  },
}))

import { displayUploadResults } from '../../common/upload-flow.js'

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
