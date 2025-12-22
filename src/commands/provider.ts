
import { SPRegistryService } from '@filoz/synapse-sdk/sp-registry'
import { Command } from 'commander'
import pc from 'picocolors'
import { cleanupSynapseService } from '../core/synapse/index.js'
import { formatUSDFC } from '../core/utils/format.js'
import { getCliSynapse } from '../utils/cli-auth.js'
import { formatFileSize } from '../utils/cli-helpers.js'
import { addAuthOptions } from '../utils/cli-options.js'

export const providerCommand = new Command('provider')
    .description('Inspect and interact with storage providers')

const infoCommand = new Command('info')
    .description('View provider info. Lists all approved providers if no ID/Address specified.')
    .argument('[provider]', 'Provider ID or Address')
    .option('--all', 'List all active providers (ignoring approval status)')
    .action(async (providerIdOrAddr, options) => {
        try {
            ensurePublicAuth(options)

            const synapse = await getCliSynapse(options)

            // Access Synapse's internal WarmStorageService
            // @ts-expect-error - Accessing private _warmStorageService
            const warmStorage = synapse.storage._warmStorageService
            if (!warmStorage) throw new Error('WarmStorageService not available')

            const registryAddress = warmStorage.getServiceProviderRegistryAddress()
            const spRegistry = new SPRegistryService(synapse.getProvider(), registryAddress)

            if (providerIdOrAddr) {
                let provider
                const id = parseInt(providerIdOrAddr)

                // If it looks like a number, try fetching by ID
                if (!isNaN(id) && id.toString() === providerIdOrAddr) {
                    provider = await spRegistry.getProvider(id)
                } else {
                    console.log(pc.yellow('Note: Querying by address is not directly supported, trying as ID if numeric.'))
                    throw new Error('Please provide a numeric Provider ID')
                }

                if (!provider) {
                    console.error(pc.red(`Provider ${providerIdOrAddr} not found or invalid.`))
                    process.exit(1)
                }
                printProvider(provider)
            } else {
                let providers = []
                if (options.all) {
                    providers = await spRegistry.getAllActiveProviders()
                    console.log(pc.bold(`Found ${providers.length} active providers (all):`))
                } else {
                    const approvedIds = await warmStorage.getApprovedProviderIds()
                    console.log(pc.bold(`Found ${approvedIds.length} approved providers:`))
                    const providersOrNull = await Promise.all(approvedIds.map((id: number) => spRegistry.getProvider(id)))
                    providers = providersOrNull.filter(p => p !== null)
                }

                if (providers.length > 0) {
                    printTable(providers)
                }
            }

            await cleanupSynapseService()
        } catch (error) {
            console.error('Failed to get provider info:', error instanceof Error ? error.message : error)
            process.exit(1)
        }
    })

addAuthOptions(infoCommand)

const pingCommand = new Command('ping')
    .description('Ping provider PDP service. Pings all approved providers if no ID specified.')
    .argument('[provider]', 'Provider ID')
    .option('--all', 'Ping all active providers (ignoring approval status)')
    .action(async (providerIdOrAddr, options) => {
        try {
            ensurePublicAuth(options)

            const synapse = await getCliSynapse(options)

            // @ts-expect-error - Accessing private _warmStorageService
            const warmStorage = synapse.storage._warmStorageService
            if (!warmStorage) throw new Error('WarmStorageService not available')

            const registryAddress = warmStorage.getServiceProviderRegistryAddress()
            const spRegistry = new SPRegistryService(synapse.getProvider(), registryAddress)

            const providersToPing = []

            if (providerIdOrAddr) {
                const id = parseInt(providerIdOrAddr)
                if (isNaN(id)) throw new Error('Please provide a numeric Provider ID')

                const provider = await spRegistry.getProvider(id)
                if (!provider) {
                    console.error(pc.red(`Provider ${id} not found.`))
                    process.exit(1)
                }
                providersToPing.push(provider)
            } else {
                if (options.all) {
                    const active = await spRegistry.getAllActiveProviders()
                    providersToPing.push(...active)
                } else {
                    const approvedIds = await warmStorage.getApprovedProviderIds()
                    const providers = await Promise.all(approvedIds.map((id: number) => spRegistry.getProvider(id)))
                    providersToPing.push(...providers.filter(p => p !== null))
                }
            }

            console.log(pc.bold(`Pinging ${providersToPing.length} provider(s)...`))

            for (const p of providersToPing) {
                const serviceUrl = p.products?.PDP?.data?.serviceURL
                if (!serviceUrl) {
                    console.log(`${pc.yellow('⚠')} ${p.name || p.id} [${p.serviceProvider}]: ${pc.gray('No PDP Service URL')}`)
                    continue
                }

                try {
                    const controller = new AbortController()
                    const timeout = setTimeout(() => controller.abort(), 5000)

                    // Construct ping URL: append /pdp/ping
                    // Ensure serviceUrl doesn't end with / to avoid double slashes when simple appending,
                    // or use URL API.
                    const baseUrl = serviceUrl.endsWith('/') ? serviceUrl.slice(0, -1) : serviceUrl
                    const pingUrl = `${baseUrl}/pdp/ping`

                    const start = Date.now()
                    // Use GET for specific ping endpoint
                    const res = await fetch(pingUrl, { method: 'GET', signal: controller.signal }).catch(async () => {
                        if (controller.signal.aborted) throw new Error('Timeout')
                        throw new Error('Network Error')
                    })
                    clearTimeout(timeout)

                    const ms = Date.now() - start
                    const prefix = `[ID:${p.id}]`.padEnd(8)

                    if (res.ok) {
                        console.log(`${pc.green('✔')} ${prefix} ${p.name || 'Unknown'}: ${pc.green('OK')} ${pc.gray(`(${ms}ms)`)} -> ${pingUrl}`)
                    } else {
                        console.log(`${pc.red('✖')} ${prefix} ${p.name || 'Unknown'}: ${pc.red(`HTTP ${res.status}`)} ${pc.gray(`(${ms}ms)`)} -> ${pingUrl}`)
                    }
                } catch (err: any) {
                    const prefix = `[ID:${p.id}]`.padEnd(8)
                    console.log(`${pc.red('✖')} ${prefix} ${p.name || 'Unknown'}: ${pc.red('FAILED')} ${pc.gray(`(${err.message})`)} -> ${serviceUrl}`)
                }
            }

            await cleanupSynapseService()
        } catch (error) {
            console.error('Ping failed:', error instanceof Error ? error.message : error)
            process.exit(1)
        }
    })

addAuthOptions(pingCommand)

providerCommand.addCommand(infoCommand)
providerCommand.addCommand(pingCommand)

function printProvider(p: any) {
    console.log(`Provider: ${pc.cyan(p.name || 'Unknown')} (ID: ${p.id})`)
    console.log(`  Address: ${p.serviceProvider}`)
    if (p.description) console.log(`  Description: ${p.description}`)
    if (p.products?.PDP?.data?.serviceURL) {
        console.log(`  PDP Service: ${p.products.PDP.data.serviceURL}`)
    }
    const location = p.products?.PDP?.data?.location
    if (location) console.log(`  Location: ${location}`)

    // Additional Details
    const data = p.products?.PDP?.data
    if (data) {
        if (data.minPieceSizeInBytes) console.log(`  Min Piece Size: ${formatFileSize(data.minPieceSizeInBytes)}`)
        if (data.maxPieceSizeInBytes) console.log(`  Max Piece Size: ${formatFileSize(data.maxPieceSizeInBytes)}`)
        if (data.storagePricePerTibPerDay) console.log(`  Storage Price: ${formatUSDFC(BigInt(data.storagePricePerTibPerDay))} USDFC/TiB/Day`)
        if (data.minProvingPeriodInEpochs) console.log(`  Min Proving Period: ${data.minProvingPeriodInEpochs} epochs`)
    }
}

function printTable(providers: any[]) {
    if (!providers.length) return

    // Define columns
    const columns = [
        { header: 'ID', key: 'id', width: 5 },
        { header: 'Name', key: 'name', width: 20 },
        { header: 'Address', key: 'serviceProvider', width: 42 },
        { header: 'Location', key: 'location', width: 15 },
        { header: 'Service URL', key: 'serviceUrl', width: 35 }
    ]

    // extract data for table
    const rows = providers.map(p => ({
        id: p.id?.toString() || '?',
        name: p.name || 'Unknown',
        serviceProvider: p.serviceProvider || '',
        location: p.products?.PDP?.data?.location || '-',
        serviceUrl: p.products?.PDP?.data?.serviceURL || '-'
    }))

    // adjust widths based on content (optional, but good for table)
    rows.forEach(r => {
        columns.forEach(c => {
            const val = (r as any)[c.key] || ''
            if (val.length > c.width) c.width = Math.min(val.length, 60) // cap max width
        })
    })

    // Header
    const headerRow = columns.map(c => c.header.padEnd(c.width)).join('  ')
    console.log(pc.gray(headerRow))
    console.log(pc.gray('-'.repeat(headerRow.length)))

    // Rows
    rows.forEach(r => {
        const line = columns.map(c => {
            const val = (r as any)[c.key] || ''
            return val.padEnd(c.width)
        }).join('  ')
        console.log(line)
    })
}

function ensurePublicAuth(options: any) {
    // Check if any auth options are provided (env vars are checked in cli-auth but we check keys here)
    const hasAuth = options.privateKey || options.walletAddress || options.sessionKey || options.viewAddress || process.env.PRIVATE_KEY || process.env.WALLET_ADDRESS || process.env.SESSION_KEY || process.env.VIEW_ADDRESS

    if (!hasAuth) {
        // If no auth provided, default to public read-only mode using zero address
        options.viewAddress = '0x0000000000000000000000000000000000000000'
    }
}
