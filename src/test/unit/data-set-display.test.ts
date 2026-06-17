import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataSetListRow } from '../../core/data-set/enrich-list-sizes.js'
import { displayDataSetList } from '../../data-set/display.js'

const { logMock } = vi.hoisted(() => ({
  logMock: {
    line: vi.fn(),
    indent: vi.fn(),
    flush: vi.fn(),
  },
}))

vi.mock('../../utils/cli-logger.js', () => ({
  log: logMock,
}))

function row(fields: Partial<DataSetListRow> = {}): DataSetListRow {
  return {
    dataSetId: 1n,
    pdpVerifierDataSetId: 1n,
    providerId: 10n,
    activePieceCount: 1n,
    isLive: true,
    isManaged: true,
    withCDN: false,
    metadata: {},
    provider: undefined,
    createdWithFilecoinPin: true,
    totalSizeBytes: 1048576n,
    sizeKnown: true,
    ...fields,
  } as unknown as DataSetListRow
}

function lines(): string[] {
  return logMock.line.mock.calls.map(([line]) => line as string)
}

describe('displayDataSetList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders compact table rows sorted by data set ID', () => {
    displayDataSetList(
      [
        row({ dataSetId: 3n, pdpVerifierDataSetId: 3n, providerId: 30n }),
        row({ dataSetId: 1n, pdpVerifierDataSetId: 1n, providerId: 10n }),
      ],
      'calibration',
      '0xtest'
    )

    const output = lines()
    expect(output).toContain('Network: calibration')
    expect(output).toContain('Client address: 0xtest')
    expect(output.some((line) => /^ID\s+Status\s+Provider ID\s+Pieces\s+Size\s+CDN$/.test(line))).toBe(true)
    expect(output.findIndex((line) => /^1\s+live\s+10\s+1\s+1\.0 MiB\s+disabled$/.test(line))).toBeLessThan(
      output.findIndex((line) => /^3\s+live\s+30\s+1\s+1\.0 MiB\s+disabled$/.test(line))
    )
  })

  it('renders footer totals and the show command hint', () => {
    displayDataSetList(
      [
        row({ dataSetId: 1n, activePieceCount: 1n, totalSizeBytes: 1048576n }),
        row({ dataSetId: 2n, activePieceCount: 2n, totalSizeBytes: 2097152n, withCDN: true }),
      ],
      'calibration',
      '0xtest'
    )

    const output = lines()
    expect(output).toContain('2 data sets, 3 active pieces, 3.0 MiB total known size')
    expect(output).toContain('Run `filecoin-pin data-set show <id>` for full details.')
    expect(output.some((line) => /^2\s+live\s+10\s+2\s+2\.0 MiB\s+enabled$/.test(line))).toBe(true)
  })

  it('renders unknown for rows with failed size lookups and excludes them from known-size totals', () => {
    displayDataSetList(
      [
        row({ dataSetId: 1n, activePieceCount: 1n, totalSizeBytes: 1048576n }),
        row({ dataSetId: 2n, activePieceCount: 2n, sizeKnown: false }),
      ],
      'calibration',
      '0xtest'
    )

    const output = lines()
    expect(output.some((line) => /^2\s+live\s+10\s+2\s+unknown\s+disabled$/.test(line))).toBe(true)
    expect(output).toContain('2 data sets, 3 active pieces, 1.0 MiB total known size')
  })

  it('renders lifecycle status labels in compact rows', () => {
    displayDataSetList(
      [row({ dataSetId: 1n, isLive: false, pdpEndEpoch: 0n }), row({ dataSetId: 2n, isLive: false, pdpEndEpoch: 42n })],
      'calibration',
      '0xtest'
    )

    const output = lines()
    expect(output.some((line) => /^1\s+inactive\s+10\s+1\s+1\.0 MiB\s+disabled$/.test(line))).toBe(true)
    expect(output.some((line) => /^2\s+terminated @ epoch 42\s+10\s+1\s+1\.0 MiB\s+disabled$/.test(line))).toBe(true)
  })
})
