import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runProviderList, runProviderPing, runProviderShow } from '../../provider/run.js'
import * as cliAuthModule from '../../utils/cli-auth.js'

const { mockGetApprovedProviders, mockGetEndorsedProviderIds, mockSynapse, mockGetProvider, logMock } = vi.hoisted(
  () => {
    const mockGetProvider = vi.fn()
    const mockGetApprovedProviders = vi.fn()
    const mockGetEndorsedProviderIds = vi.fn()
    const mockSynapse = {
      client: {},
      providers: {
        getProvider: mockGetProvider,
        getAllActiveProviders: vi.fn(),
      },
      storage: {},
    }
    const logMock = {
      line: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
    }
    return {
      mockGetApprovedProviders,
      mockGetEndorsedProviderIds,
      mockSynapse,
      mockGetProvider,
      logMock,
    }
  }
)

vi.mock('../../utils/cli-auth.js', () => ({
  getCliSynapse: vi.fn(),
}))

vi.mock('../../utils/cli-helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/cli-helpers.js')>()
  return {
    ...actual,
    createSpinner: vi.fn().mockImplementation(() => ({
      start: vi.fn(),
      stop: vi.fn(),
      message: vi.fn(),
      clear: vi.fn(),
    })),
    intro: vi.fn(),
    outro: vi.fn(),
    cancel: vi.fn(),
  }
})

vi.mock('../../utils/cli-logger.js', () => ({
  log: logMock,
}))

vi.mock('@filoz/synapse-core/warm-storage', () => ({
  getApprovedProviderIds: mockGetApprovedProviders,
}))

vi.mock('@filoz/synapse-core/endorsements', () => ({
  getEndorsedProviderIds: mockGetEndorsedProviderIds,
}))

function lines(): string[] {
  return logMock.line.mock.calls.map(([line]) => String(line))
}

const LIST_FIXTURE = [
  'ID     Name                  Address                                     Location         Service URL                        ',
  '-----------------------------------------------------------------------------------------------------------------------------',
  '1      Provider 1            0x123                                       US-East          http://p1.com/pdp                  ',
  '2      Provider 2            0x456                                       -                http://p2.com/pdp                  ',
]

const SHOW_FIXTURE = [
  'Provider: Provider 1 (ID: 1)',
  '  Address: 0x123',
  '  Endorsed: yes',
  '  Approved: yes',
  '  Description: A test provider',
  '  PDP Service: http://p1.com/pdp',
  '  Location: US-East',
  '  Min Piece Size: 1.0 KiB',
  '  Max Piece Size: 1.0 MiB',
  '  Storage Price: 1.0000 USDFC/TiB/Day',
  '  Min Proving Period: 2880 epochs',
]

describe('provider list/show/ping text fixtures', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()

    mockGetApprovedProviders.mockResolvedValue({ items: [1n, 2n] })
    mockGetEndorsedProviderIds.mockResolvedValue([1n])

    mockGetProvider.mockImplementation(async ({ providerId }: { providerId: bigint }) => {
      if (providerId === 1n) {
        return {
          id: 1n,
          name: 'Provider 1',
          serviceProvider: '0x123',
          description: 'A test provider',
          pdp: {
            serviceURL: 'http://p1.com/pdp',
            location: 'US-East',
            minPieceSizeInBytes: 1024,
            maxPieceSizeInBytes: 1024 * 1024,
            storagePricePerTibPerDay: 10n ** 18n,
            minProvingPeriodInEpochs: 2880,
          },
        }
      }
      if (providerId === 2n) {
        return {
          id: 2n,
          name: 'Provider 2',
          serviceProvider: '0x456',
          pdp: { serviceURL: 'http://p2.com/pdp' },
        }
      }
      return null
    })

    vi.mocked(cliAuthModule.getCliSynapse).mockReturnValue(mockSynapse as never)
  })

  it('list writes the provider table through the CLI logger', async () => {
    await runProviderList({})
    expect(lines()).toEqual(LIST_FIXTURE)
    expect(logMock.flush).toHaveBeenCalled()
  })

  it('show writes provider details through the CLI logger', async () => {
    await runProviderShow('1', {})
    expect(lines()).toEqual(SHOW_FIXTURE)
    expect(logMock.flush).toHaveBeenCalled()
  })

  it('ping writes each result through the CLI logger', async () => {
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => {
      const value = now
      now += 42
      return value
    })
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })

    await runProviderPing(undefined, {})

    expect(lines()).toEqual([
      '✔ [ID:1]   Provider 1: OK (42ms) -> http://p1.com/pdp/pdp/ping',
      '✔ [ID:2]   Provider 2: OK (42ms) -> http://p2.com/pdp/pdp/ping',
    ])
    expect(logMock.flush).toHaveBeenCalled()
  })

  it('ping writes the no-URL warning through the CLI logger', async () => {
    mockGetApprovedProviders.mockResolvedValue({ items: [1n] })
    mockGetProvider.mockResolvedValue({
      id: 1n,
      name: 'Bare',
      serviceProvider: '0xabc',
    })

    await runProviderPing(undefined, {})

    expect(lines()).toEqual(['⚠ Bare [0xabc]: No PDP Service URL'])
    expect(logMock.flush).toHaveBeenCalled()
  })
})
