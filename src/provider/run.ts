import { getProviderIds as getEndorsedProviders } from '@filoz/synapse-core/endorsements'
import { getApprovedProviders } from '@filoz/synapse-core/warm-storage'
import pc from 'picocolors'
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

    spinner.message('Fetching providers...')

    let providers = []
    if (options.all) {
      providers = await synapse.providers.getAllActiveProviders()
      spinner.stop(`Found ${providers.length} active providers (all):`)
    } else if (options.endorsed) {
      const endorsedIds = await getEndorsedProviders(synapse.client)
      const ids = [...endorsedIds]
      spinner.message(`Fetching details for ${ids.length} endorsed providers...`)
      const providersOrNull = await Promise.all(ids.map((id) => synapse.providers.getProvider({ providerId: id })))
      providers = providersOrNull.filter((p) => p !== null)
      spinner.stop(`Found ${providers.length} endorsed providers:`)
    } else {
      const approvedIds = await getApprovedProviders(synapse.client)
      spinner.message(`Fetching details for ${approvedIds.length} approved providers...`)
      const providersOrNull = await Promise.all(
        approvedIds.map((id: bigint) => synapse.providers.getProvider({ providerId: id }))
      )
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
  }
}

export async function runProviderShow(providerIdOrAddr: string, options: ProviderShowOptions): Promise<void> {
  const spinner = createSpinner()
  intro(pc.bold(`Provider Details: ${providerIdOrAddr}`))
  spinner.start('Connecting to Synapse...')

  try {
    ensurePublicAuth(options)
    const synapse = await getCliSynapse(options)

    spinner.message(`Fetching details for ${providerIdOrAddr}...`)

    let provider: any
    const id = parseInt(providerIdOrAddr, 10)

    // If it looks like a number, try fetching by ID
    if (!Number.isNaN(id) && id.toString() === providerIdOrAddr) {
      provider = await synapse.providers.getProvider({ providerId: BigInt(id) })
    } else {
      spinner.stop(pc.yellow('Querying by address is not directly supported, trying as ID if numeric.'))
      throw new Error('Please provide a numeric Provider ID')
    }

    if (!provider) {
      spinner.stop(pc.red(`Provider ${providerIdOrAddr} not found or invalid.`))
      throw new Error(`Provider ${providerIdOrAddr} not found`)
    }

    spinner.message('Checking endorsement and approval status...')
    const [endorsedIds, approvedIds] = await Promise.all([
      getEndorsedProviders(synapse.client),
      getApprovedProviders(synapse.client),
    ])
    const providerId = BigInt(id)
    const isEndorsed = endorsedIds.has(providerId)
    const isApproved = approvedIds.includes(providerId)

    spinner.stop('Provider found')
    printProvider(provider, { isEndorsed, isApproved })

    outro('Provider inspection complete')
  } catch (error) {
    spinner.stop(`${pc.red('✗')} Failed to show provider`)
    log.line('')
    log.line(`${pc.red('Error:')} ${error instanceof Error ? error.message : String(error)}`)
    cancel('Inspection failed')
    throw error
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

    const providersToPing = []

    if (providerIdOrAddr) {
      spinner.message(`Fetching provider ${providerIdOrAddr}...`)
      const id = parseInt(providerIdOrAddr, 10)
      if (Number.isNaN(id)) throw new Error('Please provide a numeric Provider ID')

      const provider = await synapse.providers.getProvider({ providerId: BigInt(id) })
      if (!provider) {
        throw new Error(`Provider ${id} not found`)
      }
      providersToPing.push(provider)
    } else {
      spinner.message('Fetching provider list...')
      if (options.all) {
        const active = await synapse.providers.getAllActiveProviders()
        providersToPing.push(...active)
      } else {
        const approvedIds = await getApprovedProviders(synapse.client)
        const providers = await Promise.all(
          approvedIds.map((id: bigint) => synapse.providers.getProvider({ providerId: id }))
        )
        providersToPing.push(...providers.filter((p) => p !== null))
      }
    }

    spinner.stop(`Pinging ${providersToPing.length} provider(s)...`)

    for (const p of providersToPing) {
      const serviceUrl = p.pdp?.serviceURL
      if (!serviceUrl) {
        console.log(`${pc.yellow('⚠')} ${p.name || p.id} [${p.serviceProvider}]: ${pc.gray('No PDP Service URL')}`)
        continue
      }

      let timeout: NodeJS.Timeout | undefined
      try {
        const controller = new AbortController()
        timeout = setTimeout(() => controller.abort(), 5000)

        const baseUrl = serviceUrl.endsWith('/') ? serviceUrl.slice(0, -1) : serviceUrl
        const pingUrl = `${baseUrl}/pdp/ping`

        const start = Date.now()
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
    throw error
  }
}

function printProvider(p: any, status?: { isEndorsed: boolean; isApproved: boolean }) {
  console.log(`Provider: ${pc.cyan(p.name || 'Unknown')} (ID: ${p.id})`)
  console.log(`  Address: ${p.serviceProvider}`)
  if (status) {
    console.log(`  Endorsed: ${status.isEndorsed ? pc.green('yes') : 'no'}`)
    console.log(`  Approved: ${status.isApproved ? pc.green('yes') : 'no'}`)
  }
  if (p.description) console.log(`  Description: ${p.description}`)
  if (p.pdp?.serviceURL) {
    console.log(`  PDP Service: ${p.pdp.serviceURL}`)
  }
  const location = p.pdp?.location
  if (location) console.log(`  Location: ${location}`)

  const pdp = p.pdp
  if (pdp) {
    if (pdp.minPieceSizeInBytes != null)
      console.log(`  Min Piece Size: ${formatFileSize(Number(pdp.minPieceSizeInBytes))}`)
    if (pdp.maxPieceSizeInBytes != null)
      console.log(`  Max Piece Size: ${formatFileSize(Number(pdp.maxPieceSizeInBytes))}`)
    if (pdp.storagePricePerTibPerDay != null)
      console.log(`  Storage Price: ${formatUSDFC(pdp.storagePricePerTibPerDay)} USDFC/TiB/Day`)
    if (pdp.minProvingPeriodInEpochs != null)
      console.log(`  Min Proving Period: ${pdp.minProvingPeriodInEpochs} epochs`)
  }
}

function printTable(providers: any[]) {
  if (!providers.length) return

  const columns = [
    { header: 'ID', key: 'id', width: 5 },
    { header: 'Name', key: 'name', width: 20 },
    { header: 'Address', key: 'serviceProvider', width: 42 },
    { header: 'Location', key: 'location', width: 15 },
    { header: 'Service URL', key: 'serviceUrl', width: 35 },
  ]

  const rows = providers.map((p) => ({
    id: p.id?.toString() || '?',
    name: p.name || 'Unknown',
    serviceProvider: p.serviceProvider || '',
    location: p.pdp?.location || '-',
    serviceUrl: p.pdp?.serviceURL || '-',
  }))

  rows.forEach((r) => {
    columns.forEach((c) => {
      const val = (r as any)[c.key] || ''
      if (val.length > c.width) c.width = Math.min(val.length, 60)
    })
  })

  const headerRow = columns.map((c) => c.header.padEnd(c.width)).join('  ')
  console.log(pc.gray(headerRow))
  console.log(pc.gray('-'.repeat(headerRow.length)))

  rows.forEach((r) => {
    const line = columns
      .map((c) => {
        let val = (r as any)[c.key] || ''
        if (val.length > c.width) {
          val = `${val.substring(0, c.width - 1)}...`
        }
        return val.padEnd(c.width)
      })
      .join('  ')
    console.log(line)
  })
}

function ensurePublicAuth(options: any) {
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
    options.viewAddress = '0x0000000000000000000000000000000000000000'
  }
}
