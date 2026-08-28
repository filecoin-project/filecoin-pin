import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type DataSetSummary, type PieceInfo, PieceStatus } from '../../core/data-set/types.js'
import { displayDataSetList, displayPieceStatuses } from '../../data-set/display.js'

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

function row(fields: Partial<DataSetSummary> = {}): DataSetSummary {
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
    ...fields,
  } as unknown as DataSetSummary
}

function lines(): string[] {
  return logMock.line.mock.calls.map(([line]) => line as string)
}

function renderedText(): string {
  return [...logMock.line.mock.calls, ...logMock.indent.mock.calls].map(([line]) => String(line)).join('\n')
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
    expect(output.some((line) => line.includes('Network:') && line.includes('calibration'))).toBe(true)
    expect(output).toContain('Client address: 0xtest')
    expect(output.some((line) => /^ID\s+Status\s+Provider ID\s+Pieces\s+CDN$/.test(line))).toBe(true)
    expect(output.some((line) => /\bSize\b/.test(line))).toBe(false)
    expect(output.findIndex((line) => /^1\s+live\s+10\s+1\s+disabled$/.test(line.trim()))).toBeLessThan(
      output.findIndex((line) => /^3\s+live\s+30\s+1\s+disabled$/.test(line.trim()))
    )
  })

  it('renders footer totals and the show command hint', () => {
    displayDataSetList(
      [row({ dataSetId: 1n, activePieceCount: 1n }), row({ dataSetId: 2n, activePieceCount: 2n, withCDN: true })],
      'calibration',
      '0xtest'
    )

    const output = lines()
    expect(output).toContain('2 data sets, 3 active pieces')
    expect(output).toContain('Run `filecoin-pin data-set show <id>` for full details.')
    expect(output.some((line) => /total known size/i.test(line))).toBe(false)
    expect(output.some((line) => /^2\s+live\s+10\s+2\s+enabled$/.test(line.trim()))).toBe(true)
  })

  it('renders lifecycle status labels in compact rows', () => {
    displayDataSetList(
      [row({ dataSetId: 1n, isLive: false, pdpEndEpoch: 0n }), row({ dataSetId: 2n, isLive: false, pdpEndEpoch: 42n })],
      'calibration',
      '0xtest'
    )

    const output = lines()
    expect(output.some((line) => /^1\s+inactive\s+10\s+1\s+disabled$/.test(line.trim()))).toBe(true)
    expect(output.some((line) => /^2\s+terminated\s+10\s+1\s+disabled$/.test(line.trim()))).toBe(true)
  })
})

describe('displayPieceStatuses', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not expose legacy piece metadata fields', () => {
    const piece = {
      pieceId: 1n,
      pieceCid: 'bafkpiece1',
      status: PieceStatus.ACTIVE,
      size: 1024,
      rootIpfsCid: 'bafyroot1',
      metadata: { ipfsRootCID: 'bafyroot1', secret: 'value' },
    } as unknown as PieceInfo

    displayPieceStatuses([piece], 1, 'calibration', '0xtest')

    const output = renderedText()
    expect(output).toContain('bafkpiece1')
    expect(output).not.toContain('bafyroot1')
    expect(output).not.toContain('secret')
  })
})
