import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runProviderList, runProviderPing, runProviderShow } from '../../provider/run.js'
import * as cliAuthModule from '../../utils/cli-auth.js'

// Fix hoisting issue: define mocks in hoisted block
const {
  mockGetApprovedProviders,
  mockGetEndorsedProviderIds,
  mockSynapse,
  mockGetProvider,
  mockGetAllActiveProviders,
} = vi.hoisted(() => {
  const mockGetProvider = vi.fn()
  const mockGetAllActiveProviders = vi.fn()
  const mockGetApprovedProviders = vi.fn()
  const mockGetEndorsedProviderIds = vi.fn()
  const mockSynapse = {
    client: {},
    providers: {
      getProvider: mockGetProvider,
      getAllActiveProviders: mockGetAllActiveProviders,
    },
    storage: {},
  }
  return {
    mockGetApprovedProviders,
    mockGetEndorsedProviderIds,
    mockSynapse,
    mockGetProvider,
    mockGetAllActiveProviders,
  }
})

// Mock dependencies
vi.mock('../../utils/cli-auth.js', () => ({
  getCliSynapse: vi.fn(),
}))

vi.mock('../../utils/cli-helpers.js', () => ({
  createSpinner: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    message: vi.fn(),
    clear: vi.fn(),
  })),
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  formatFileSize: vi.fn(),
}))

vi.mock('../../utils/cli-logger.js', () => ({
  log: {
    line: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@filoz/synapse-core/warm-storage', () => ({
  getApprovedProviderIds: mockGetApprovedProviders,
}))

vi.mock('@filoz/synapse-core/endorsements', () => ({
  getEndorsedProviderIds: mockGetEndorsedProviderIds,
}))

describe('provider command', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    // Configure default mock behaviors
    mockGetApprovedProviders.mockResolvedValue([1n, 2n])
    mockGetEndorsedProviderIds.mockResolvedValue([1n])

    mockGetProvider.mockImplementation(async ({ providerId }: any) => {
      if (providerId === 1n)
        return {
          id: 1n,
          name: 'Provider 1',
          serviceProvider: '0x123',
          pdp: { serviceURL: 'http://p1.com/pdp' },
        }
      if (providerId === 2n)
        return {
          id: 2n,
          name: 'Provider 2',
          serviceProvider: '0x456',
          pdp: { serviceURL: 'http://p2.com/pdp' },
        }
      return null
    })

    mockGetAllActiveProviders.mockResolvedValue([
      {
        id: 1n,
        name: 'Active1',
        serviceProvider: '0x1',
        pdp: { serviceURL: 'http://p1.com/pdp' },
      },
      {
        id: 3n,
        name: 'Active3',
        serviceProvider: '0x3',
        pdp: { serviceURL: 'http://p3.com/pdp' },
      },
    ])

    // Configure getCliSynapse to return our mock synapse
    vi.mocked(cliAuthModule.getCliSynapse).mockReturnValue(mockSynapse as any)

    vi.spyOn(console, 'log').mockImplementation(() => {
      // no-op
    })
    vi.spyOn(process, 'exit').mockImplementation((() => {
      // no-op
    }) as any)
  })

  it('list command should list all approved providers when no arg is passed', async () => {
    await runProviderList({})
    expect(mockGetApprovedProviders).toHaveBeenCalled()
    expect(mockGetProvider).toHaveBeenCalledWith({ providerId: 1n })
    expect(mockGetProvider).toHaveBeenCalledWith({ providerId: 2n })
  })

  it('show command should show specific provider when arg is passed', async () => {
    await runProviderShow('1', {})
    expect(mockGetProvider).toHaveBeenCalledWith({ providerId: 1n })
    expect(mockGetEndorsedProviderIds).toHaveBeenCalled()
    expect(mockGetApprovedProviders).toHaveBeenCalled()
  })

  it('ping command should ping all approved providers when no arg is passed', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as any)
    await runProviderPing(undefined, {})
    expect(mockGetApprovedProviders).toHaveBeenCalled()
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/pdp/ping'),
      expect.objectContaining({ method: 'GET' })
    )
  })

  it('ping command should ping specific provider when arg is passed', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as any)
    await runProviderPing('1', {})

    expect(mockGetProvider).toHaveBeenCalledWith({ providerId: 1n })
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(global.fetch).toHaveBeenCalledWith('http://p1.com/pdp/pdp/ping', expect.objectContaining({ method: 'GET' }))
  })

  it('should use default public auth if no credentials provided', async () => {
    await runProviderList({})
    expect(cliAuthModule.getCliSynapse).toHaveBeenCalledWith(
      expect.objectContaining({
        viewAddress: '0x0000000000000000000000000000000000000000',
      })
    )
  })

  it('list command should list all active providers with --all flag', async () => {
    await runProviderList({ all: true })
    expect(mockGetAllActiveProviders).toHaveBeenCalled()
    expect(mockGetApprovedProviders).not.toHaveBeenCalled()
  })

  it('list command should list only endorsed providers with --endorsed flag', async () => {
    await runProviderList({ endorsed: true })
    expect(mockGetEndorsedProviderIds).toHaveBeenCalled()
    expect(mockGetApprovedProviders).not.toHaveBeenCalled()
    expect(mockGetProvider).toHaveBeenCalledWith({ providerId: 1n })
  })

  it('ping command should ping all active providers with --all flag', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as any)
    await runProviderPing(undefined, { all: true })

    expect(mockGetAllActiveProviders).toHaveBeenCalled()
    expect(mockGetApprovedProviders).not.toHaveBeenCalled()
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/pdp/ping'),
      expect.objectContaining({ method: 'GET' })
    )
  })
})
