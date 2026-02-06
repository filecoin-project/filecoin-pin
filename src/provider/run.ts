import { SPRegistryService } from '@filoz/synapse-sdk/sp-registry'
import pc from 'picocolors'
import { cleanupSynapseService } from '../core/synapse/index.js'
import { formatUSDFC } from '../core/utils/format.js'
import { getCliSynapse } from '../utils/cli-auth.js'
import { cancel, createSpinner, formatFileSize, intro, outro } from '../utils/cli-helpers.js'
import { log } from '../utils/cli-logger.js'
import type { ProviderListOptions, ProviderPingOptions, ProviderShowOptions } from './types.js'

export async function runProviderList(options: ProviderListOptions): Promise<void> {
  const spinner = createSpinner()
  intro(pc.bold('Filecoin Onchain Cloud Providers'))
  spinner.start('Connecting to Synapse...')

  try {
    ensurePublicAuth(options)
    const synapse = await getCliSynapse(options)

    // Access Synapse's internal WarmStorageService
    // @ts-expect-error - Accessing private _warmStorageService
    const warmStorage = synapse.storage._warmStorageService
    if (!warmStorage) throw new Error('WarmStorageService not available')

    const registryAddress = warmStorage.getServiceProviderRegistryAddress()
    const spRegistry = new SPRegistryService(synapse.getProvider(), registryAddress)

    spinner.message('Fetching providers...')

    let providers = []
    if (options.all) {
      providers = await spRegistry.getAllActiveProviders()
      spinner.stop(`Found ${providers.length} active providers (all):`)
    } else {
      const approvedIds = await warmStorage.getApprovedProviderIds()
      spinner.message(`Fetching details for ${approvedIds.length} approved providers...`)
      const providersOrNull = await Promise.all(approvedIds.map((id: number) => spRegistry.getProvider(id)))
      providers = providersOrNull.filter((p) => p !== null)
      spinner.stop(`Found ${providers.length} approved providers:`)
    }

    if (providers.length > 0) {
      printTable(providers)
    }

    outro('Provider list complete')
  } catch (error) {
    spinner.stop(`${pc.red('✗')} Failed to list providers`)
    log.line('')
    log.line(`${pc.red('Error:')} ${error instanceof Error ? error.message : String(error)}`)
    cancel('Listing failed')
    throw error
  } finally {
    await cleanupSynapseService()
  }
}

export async function runProviderShow(providerIdOrAddr: string, options: ProviderShowOptions): Promise<void> {
  const spinner = createSpinner()
  intro(pc.bold(`Provider Details: ${providerIdOrAddr}`))
  spinner.start('Connecting to Synapse...')

  try {
    ensurePublicAuth(options)
    const synapse = await getCliSynapse(options)

    // Access Synapse's internal WarmStorageService
    // @ts-expect-error - Accessing private _warmStorageService
    const warmStorage = synapse.storage._warmStorageService
    if (!warmStorage) throw new Error('WarmStorageService not available')

    const registryAddress = warmStorage.getServiceProviderRegistryAddress()
    const spRegistry = new SPRegistryService(synapse.getProvider(), registryAddress)

    spinner.message(`Fetching details for ${providerIdOrAddr}...`)

    let provider: any
    const id = parseInt(providerIdOrAddr, 10)

    // If it looks like a number, try fetching by ID
    if (!Number.isNaN(id) && id.toString() === providerIdOrAddr) {
      provider = await spRegistry.getProvider(id)
    } else {
      // NOTE: Querying by address is not directly supported by the registry service yet in this context cleanly without iterating all
      spinner.stop(pc.yellow('Querying by address is not directly supported, trying as ID if numeric.'))
      throw new Error('Please provide a numeric Provider ID')
    }

    if (!provider) {
      spinner.stop(pc.red(`Provider ${providerIdOrAddr} not found or invalid.`))
      throw new Error(`Provider ${providerIdOrAddr} not found`)
    }

    spinner.stop('Provider found')
    printProvider(provider)

    outro('Provider inspection complete')
  } catch (error) {
    spinner.stop(`${pc.red('✗')} Failed to show provider`)
    log.line('')
    log.line(`${pc.red('Error:')} ${error instanceof Error ? error.message : String(error)}`)
    cancel('Inspection failed')
    throw error
  } finally {
    await cleanupSynapseService()
  }
}

export async function runProviderPing(
  providerIdOrAddr: string | undefined,
  options: ProviderPingOptions
): Promise<void> {
  const spinner = createSpinner()
  intro(pc.bold('Ping Providers'))
  spinner.start('Connecting to Synapse...')

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
      spinner.message(`Fetching provider ${providerIdOrAddr}...`)
      const id = parseInt(providerIdOrAddr, 10)
      if (Number.isNaN(id)) throw new Error('Please provide a numeric Provider ID')

      const provider = await spRegistry.getProvider(id)
      if (!provider) {
        throw new Error(`Provider ${id} not found`)
      }
      providersToPing.push(provider)
    } else {
      spinner.message('Fetching provider list...')
      if (options.all) {
        const active = await spRegistry.getAllActiveProviders()
        providersToPing.push(...active)
      } else {
        const approvedIds = await warmStorage.getApprovedProviderIds()
        const providers = await Promise.all(approvedIds.map((id: number) => spRegistry.getProvider(id)))
        providersToPing.push(...providers.filter((p) => p !== null))
      }
    }

    spinner.stop(`Pinging ${providersToPing.length} provider(s)...`)

    for (const p of providersToPing) {
      const serviceUrl = p.products?.PDP?.data?.serviceURL
      if (!serviceUrl) {
        console.log(`${pc.yellow('⚠')} ${p.name || p.id} [${p.serviceProvider}]: ${pc.gray('No PDP Service URL')}`)
        continue
      }

      let timeout: NodeJS.Timeout | undefined
      try {
        const controller = new AbortController()
        timeout = setTimeout(() => controller.abort(), 5000)

        // Construct ping URL: append /pdp/ping
        const baseUrl = serviceUrl.endsWith('/') ? serviceUrl.slice(0, -1) : serviceUrl
        const pingUrl = `${baseUrl}/pdp/ping`

        const start = Date.now()
        // Use GET for specific ping endpoint
        const res = await fetch(pingUrl, { method: 'GET', signal: controller.signal }).catch(async () => {
          if (controller.signal.aborted) throw new Error('Timeout')
          throw new Error('Network Error')
        })

        const ms = Date.now() - start
        const prefix = `[ID:${p.id}]`.padEnd(8)

        if (res.ok) {
          console.log(
            `${pc.green('✔')} ${prefix} ${p.name || 'Unknown'}: ${pc.green('OK')} ${pc.gray(`(${ms}ms)`)} -> ${pingUrl}`
          )
        } else {
          console.log(
            `${pc.red('✖')} ${prefix} ${p.name || 'Unknown'}: ${pc.red(`HTTP ${res.status}`)} ${pc.gray(`(${ms}ms)`)} -> ${pingUrl}`
          )
        }
      } catch (err: any) {
        const prefix = `[ID:${p.id}]`.padEnd(8)
        console.log(
          `${pc.red('✖')} ${prefix} ${p.name || 'Unknown'}: ${pc.red('FAILED')} ${pc.gray(`(${err.message})`)} -> ${serviceUrl}`
        )
      } finally {
        if (timeout) clearTimeout(timeout)
      }
    }

    outro('Ping complete')
  } catch (error) {
    spinner.stop(`${pc.red('✗')} Ping failed`)
    log.line('')
    log.line(`${pc.red('Error:')} ${error instanceof Error ? error.message : String(error)}`)
    cancel('Ping failed')
    throw error // Re-throw to let command wiring handle process exit code if needed, though we usually just exit 1
  } finally {
    await cleanupSynapseService()
  }
}

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
    if (data.minPieceSizeInBytes != null) console.log(`  Min Piece Size: ${formatFileSize(data.minPieceSizeInBytes)}`)
    if (data.maxPieceSizeInBytes != null) console.log(`  Max Piece Size: ${formatFileSize(data.maxPieceSizeInBytes)}`)
    if (data.storagePricePerTibPerDay != null)
      console.log(`  Storage Price: ${formatUSDFC(BigInt(data.storagePricePerTibPerDay))} USDFC/TiB/Day`)
    if (data.minProvingPeriodInEpochs != null)
      console.log(`  Min Proving Period: ${data.minProvingPeriodInEpochs} epochs`)
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
    { header: 'Service URL', key: 'serviceUrl', width: 35 },
  ]

  // extract data for table
  const rows = providers.map((p) => ({
    id: p.id?.toString() || '?',
    name: p.name || 'Unknown',
    serviceProvider: p.serviceProvider || '',
    location: p.products?.PDP?.data?.location || '-',
    serviceUrl: p.products?.PDP?.data?.serviceURL || '-',
  }))

  // adjust widths based on content
  rows.forEach((r) => {
    columns.forEach((c) => {
      const val = (r as any)[c.key] || ''
      if (val.length > c.width) c.width = Math.min(val.length, 60) // cap max width
    })
  })

  // Header
  const headerRow = columns.map((c) => c.header.padEnd(c.width)).join('  ')
  console.log(pc.gray(headerRow))
  console.log(pc.gray('-'.repeat(headerRow.length)))

  // Rows
  rows.forEach((r) => {
    const line = columns
      .map((c) => {
        let val = (r as any)[c.key] || ''
        // Truncate if exceeds width
        if (val.length > c.width) {
          val = `${val.substring(0, c.width - 1)}…`
        }
        return val.padEnd(c.width)
      })
      .join('  ')
    console.log(line)
  })
}

function ensurePublicAuth(options: any) {
  // Check if any auth options are provided (env vars are checked in cli-auth but we check keys here)
  const hasAuth =
    options.privateKey ||
    options.walletAddress ||
    options.sessionKey ||
    options.viewAddress ||
    process.env.PRIVATE_KEY ||
    process.env.WALLET_ADDRESS ||
    process.env.SESSION_KEY ||
    process.env.VIEW_ADDRESS

  if (!hasAuth) {
    // If no auth provided, default to public read-only mode using zero address
    options.viewAddress = '0x0000000000000000000000000000000000000000'
  }
}
