import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runProviderList, runProviderPing, runProviderShow } from '../../provider/run.js'
import * as cliAuthModule from '../../utils/cli-auth.js'

// Fix hoisting issue: define mocks in hoisted block
const { mockWarmStorage, mockSynapse, mockGetProvider, mockGetAllActiveProviders } = vi.hoisted(() => {
  const mockGetProvider = vi.fn()
  const mockGetAllActiveProviders = vi.fn()
  const mockWarmStorage = {
    getServiceProviderRegistryAddress: vi.fn(),
    getApprovedProviderIds: vi.fn(),
    getProvider: vi.fn(),
  }
  const mockSynapse = {
    getProvider: vi.fn(),
    client: {}, // 0.37: SPRegistryService({ client: synapse.client })
    storage: {
      _warmStorageService: mockWarmStorage,
    },
  }
  return {
    mockWarmStorage,
    mockSynapse,
    mockGetProvider,
    mockGetAllActiveProviders,
  }
})

// Mock dependencies
vi.mock('@filoz/synapse-sdk/sp-registry', () => ({
  // biome-ignore lint/complexity/useArrowFunction: Must be a function to support new
  SPRegistryService: vi.fn().mockImplementation(function () {
    return {
      getProvider: mockGetProvider,
      getAllActiveProviders: mockGetAllActiveProviders,
    }
  }),
}))

vi.mock('../../utils/cli-auth.js', () => ({
  getCliSynapse: vi.fn(),
  getAuthFromEnv: vi.fn(),
  getAuthFromConfig: vi.fn(),
  addAuthOptions: vi.fn(),
}))

vi.mock('../../core/synapse/index.js', () => ({
  cleanupSynapseService: vi.fn(),
  initializeSynapse: vi.fn(),
}))

vi.mock('../../utils/cli-helpers.js', () => ({
  createSpinner: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    message: vi.fn(),
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

describe('provider command', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    // Configure default mock behaviors
    mockWarmStorage.getServiceProviderRegistryAddress.mockReturnValue('0xRegistry')
    mockWarmStorage.getApprovedProviderIds.mockResolvedValue([1n, 2n])

    // 0.37: getProvider({ providerId: bigint })
    mockGetProvider.mockImplementation(async (opts: { providerId: bigint | number }) => {
      const id = typeof opts?.providerId === 'bigint' ? Number(opts.providerId) : opts?.providerId
      if (id === 1)
        return {
          id: 1n,
          name: 'Provider 1',
          serviceProvider: '0x123',
          pdp: { serviceURL: 'http://p1.com/pdp' },
        }
      if (id === 2)
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
    vi.mocked(cliAuthModule.getCliSynapse).mockResolvedValue(mockSynapse as any)

    vi.spyOn(console, 'log').mockImplementation(() => {
      // no-op
    })
    vi.spyOn(process, 'exit').mockImplementation((() => {
      // no-op
    }) as any)
  })

  it('list command should list all approved providers when no arg is passed', async () => {
    await runProviderList({})
    expect(mockWarmStorage.getApprovedProviderIds).toHaveBeenCalled()
    expect(mockGetProvider).toHaveBeenCalledWith({ providerId: 1n })
    expect(mockGetProvider).toHaveBeenCalledWith({ providerId: 2n })
  })

  it('show command should show specific provider when arg is passed', async () => {
    await runProviderShow('1', {})
    expect(mockGetProvider).toHaveBeenCalledWith({ providerId: 1n })
  })

  it('ping command should ping all approved providers when no arg is passed', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as any)
    await runProviderPing(undefined, {})
    expect(mockWarmStorage.getApprovedProviderIds).toHaveBeenCalled()
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

  it('list command should list all active providers with --all flag', async () => {
    await runProviderList({ all: true })
    expect(mockGetAllActiveProviders).toHaveBeenCalled()
    expect(mockWarmStorage.getApprovedProviderIds).not.toHaveBeenCalled()
  })

  it('ping command should ping all active providers with --all flag', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as any)
    await runProviderPing(undefined, { all: true })

    expect(mockGetAllActiveProviders).toHaveBeenCalled()
    expect(mockWarmStorage.getApprovedProviderIds).not.toHaveBeenCalled()
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/pdp/ping'),
      expect.objectContaining({ method: 'GET' })
    )
  })
})
