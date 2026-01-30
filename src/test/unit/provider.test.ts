
import { Command } from 'commander'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { providerCommand } from '../../commands/provider.js'
import * as cliAuthModule from '../../utils/cli-auth.js'

// Fix hoisting issue: define mocks in hoisted block
const { mockWarmStorage, mockSynapse, mockGetProvider, mockGetAllActiveProviders } = vi.hoisted(() => {
    const mockGetProvider = vi.fn()
    const mockGetAllActiveProviders = vi.fn()
    const mockWarmStorage = {
        getServiceProviderRegistryAddress: vi.fn(),
        getApprovedProviderIds: vi.fn(),
        getProvider: vi.fn()
    }
    const mockSynapse = {
        getProvider: vi.fn(),
        storage: {
            _warmStorageService: mockWarmStorage
        }
    }
    return { mockWarmStorage, mockSynapse, mockGetProvider, mockGetAllActiveProviders }
})

// Mock dependencies
vi.mock('@filoz/synapse-sdk/sp-registry', () => ({
    SPRegistryService: vi.fn().mockImplementation(function () {
        return {
            getProvider: mockGetProvider,
            getAllActiveProviders: mockGetAllActiveProviders
        }
    })
}))

vi.mock('../../utils/cli-auth.js', () => ({
    getCliSynapse: vi.fn(),
    getAuthFromEnv: vi.fn(),
    getAuthFromConfig: vi.fn(),
    addAuthOptions: vi.fn()
}))

vi.mock('../../core/synapse/index.js', () => ({
    cleanupSynapseService: vi.fn(),
    initializeSynapse: vi.fn()
}))

describe('provider command', () => {
    let program: Command

    beforeEach(() => {
        vi.clearAllMocks()

        // Configure default mock behaviors
        mockWarmStorage.getServiceProviderRegistryAddress.mockReturnValue('0xRegistry')
        mockWarmStorage.getApprovedProviderIds.mockResolvedValue([1, 2])

        mockGetProvider.mockImplementation(async (id: any) => {
            if (id === 1 || id === '1') return {
                id: 1,
                name: 'Provider 1',
                serviceProvider: '0x123',
                products: { PDP: { data: { serviceURL: 'http://p1.com/pdp' } } }
            }
            if (id === 2) return {
                id: 2,
                name: 'Provider 2',
                serviceProvider: '0x456',
                products: { PDP: { data: { serviceURL: 'http://p2.com/pdp' } } }
            }
            return null
        })

        mockGetAllActiveProviders.mockResolvedValue([
            { id: 1, name: 'Active1', serviceProvider: '0x1', products: { PDP: { data: { serviceURL: 'http://p1.com/pdp' } } } },
            { id: 3, name: 'Active3', serviceProvider: '0x3', products: { PDP: { data: { serviceURL: 'http://p3.com/pdp' } } } }
        ])

        // Configure getCliSynapse to return our mock synapse
        vi.mocked(cliAuthModule.getCliSynapse).mockResolvedValue(mockSynapse as any)

        program = new Command()
        program.exitOverride()
        program.addCommand(providerCommand)

        vi.spyOn(console, 'log').mockImplementation(() => { })
        vi.spyOn(process, 'exit').mockImplementation((() => { }) as any)
    })

    it('list command should list all approved providers when no arg is passed', async () => {
        await program.parseAsync(['node', 'test', 'provider', 'list'])
        expect(mockWarmStorage.getApprovedProviderIds).toHaveBeenCalled()
        // list command calls getProvider for each ID, so expect it to be called
        // for IDs 1 and 2 (from mockWarmStorage.getApprovedProviderIds returning [1, 2])
        expect(mockGetProvider).toHaveBeenCalledWith(1)
        expect(mockGetProvider).toHaveBeenCalledWith(2)
    })

    it('show command should show specific provider when arg is passed', async () => {
        await program.parseAsync(['node', 'test', 'provider', 'show', '1'])
        expect(mockGetProvider).toHaveBeenCalledWith(1)
    })

    it('ping command should ping all approved providers when no arg is passed', async () => {
        global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as any)
        await program.parseAsync(['node', 'test', 'provider', 'ping'])
        expect(mockWarmStorage.getApprovedProviderIds).toHaveBeenCalled()
        expect(global.fetch).toHaveBeenCalledTimes(2)
        // Verify URL suffix and method
        expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/pdp/ping'), expect.objectContaining({ method: 'GET' }))
    })

    it('ping command should ping specific provider when arg is passed', async () => {
        global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as any)
        await program.parseAsync(['node', 'test', 'provider', 'ping', '1'])

        expect(mockGetProvider).toHaveBeenCalledWith(1)
        expect(global.fetch).toHaveBeenCalledTimes(1)
        expect(global.fetch).toHaveBeenCalledWith('http://p1.com/pdp/pdp/ping', expect.objectContaining({ method: 'GET' }))
    })

    it('should use default public auth if no credentials provided', async () => {
        await program.parseAsync(['node', 'test', 'provider', 'list'])
        expect(cliAuthModule.getCliSynapse).toHaveBeenCalledWith(expect.objectContaining({
            viewAddress: '0x0000000000000000000000000000000000000000'
        }))
    })

    it('list command should list all active providers with --all flag', async () => {
        await program.parseAsync(['node', 'test', 'provider', 'list', '--all'])
        expect(mockGetAllActiveProviders).toHaveBeenCalled()
        expect(mockWarmStorage.getApprovedProviderIds).not.toHaveBeenCalled()
    })

    it('ping command should ping all active providers with --all flag', async () => {
        global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as any)
        await program.parseAsync(['node', 'test', 'provider', 'ping', '--all'])

        expect(mockGetAllActiveProviders).toHaveBeenCalled()
        expect(mockWarmStorage.getApprovedProviderIds).not.toHaveBeenCalled()
        expect(global.fetch).toHaveBeenCalledTimes(2)
        expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/pdp/ping'), expect.objectContaining({ method: 'GET' }))
    })
})
