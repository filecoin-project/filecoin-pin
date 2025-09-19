/**
 * Payment status display command
 *
 * Shows current payment configuration and balances for Filecoin Onchain Cloud.
 * This provides a quick overview of the user's payment setup without making changes.
 */

import { RPC_URLS, Synapse } from '@filoz/synapse-sdk'
import { ethers } from 'ethers'
import pc from 'picocolors'
import { cleanupProvider } from '../synapse/service.js'
import { cancel, createSpinner, intro, outro } from '../utils/cli-helpers.js'
import { log } from '../utils/cli-logger.js'
import {
  checkFILBalance,
  checkUSDFCBalance,
  displayDepositWarning,
  displayPaymentSummary,
  getPaymentStatus,
} from './setup.js'

interface StatusOptions {
  privateKey?: string
  rpcUrl?: string
}

/**
 * Display current payment status
 *
 * @param options - Options from command line
 */
export async function showPaymentStatus(options: StatusOptions): Promise<void> {
  // Parse and validate all arguments upfront
  // 1. Private key
  const privateKey = options.privateKey || process.env.PRIVATE_KEY
  if (!privateKey) {
    console.error(pc.red('Error: Private key required via --private-key or PRIVATE_KEY env'))
    process.exit(1)
  }

  // Validate private key format early
  try {
    new ethers.Wallet(privateKey)
  } catch {
    console.error(pc.red('Error: Invalid private key format'))
    process.exit(1)
  }

  // 2. RPC URL
  const rpcUrl = options.rpcUrl || process.env.RPC_URL || RPC_URLS.calibration.websocket

  intro(pc.bold('Filecoin Onchain Cloud Payment Status'))

  const spinner = createSpinner()
  spinner.start('Fetching current configuration...')

  // Store provider reference for cleanup if it's a WebSocket provider
  let provider: any = null

  try {
    // Initialize connection
    const synapse = await Synapse.create({
      privateKey,
      rpcURL: rpcUrl,
    })
    const network = synapse.getNetwork()
    const signer = synapse.getSigner()
    const address = await signer.getAddress()

    // Store provider reference for cleanup if it's a WebSocket provider
    if (rpcUrl.match(/^wss?:\/\//)) {
      provider = synapse.getProvider()
    }

    // Check balances and status
    const filStatus = await checkFILBalance(synapse)

    // Early exit if account has no funds
    if (filStatus.balance === 0n) {
      spinner.stop('━━━ Current Status ━━━')

      log.line(`Address: ${address}`)
      log.line(`Network: ${network}`)
      log.line('')
      log.line(`${pc.red('✗')} Account has no FIL balance`)
      log.line('')
      log.line(
        `Get test FIL from: ${filStatus.isCalibnet ? 'https://faucet.calibnet.chainsafe-fil.io/' : 'Purchase FIL from an exchange'}`
      )
      log.flush()

      // Clean up WebSocket provider before exiting
      await cleanupProvider(provider)

      cancel('Account not funded')
      process.exit(1)
    }

    const usdfcBalance = await checkUSDFCBalance(synapse)

    // Check if we have USDFC tokens before continuing
    if (usdfcBalance === 0n) {
      spinner.stop('━━━ Current Status ━━━')

      log.line(`Address: ${address}`)
      log.line(`Network: ${network}`)
      log.line('')
      log.line(`${pc.red('✗')} No USDFC tokens found`)
      log.line('')
      const helpMessage = filStatus.isCalibnet
        ? 'Get test USDFC from: https://docs.secured.finance/usdfc-stablecoin/getting-started/getting-test-usdfc-on-testnet'
        : 'Mint USDFC with FIL: https://docs.secured.finance/usdfc-stablecoin/getting-started/minting-usdfc-step-by-step'
      log.line(`  ${pc.cyan(helpMessage)}`)
      log.flush()

      await cleanupProvider(provider)

      cancel('USDFC required to use Filecoin Onchain Cloud')
      process.exit(1)
    }

    const status = await getPaymentStatus(synapse)

    // Get storage pricing for capacity calculation
    const storageInfo = await synapse.storage.getStorageInfo()
    const pricePerTiBPerEpoch = storageInfo.pricing.noCDN.perTiBPerEpoch

    // Stop spinner and display status
    spinner.stop('━━━ Current Status ━━━')

    log.line(`Address: ${address}`)

    displayPaymentSummary(
      network,
      filStatus.balance,
      filStatus.isCalibnet,
      usdfcBalance,
      status.depositedAmount,
      status.currentAllowances.rateAllowance,
      status.currentAllowances.lockupAllowance,
      pricePerTiBPerEpoch
    )

    // Show deposit warning if needed
    displayDepositWarning(status.depositedAmount, status.currentAllowances.lockupUsed)

    // TODO: Add payment rails information
    // - Active data sets
    // - Recent payments
    // - Usage statistics
    log.line('')
    log.line(pc.gray('Payment rails details coming soon...'))
    log.flush()

    await cleanupProvider(provider)

    // Show success outro
    outro('Status check complete')
  } catch (error) {
    spinner.stop(`${pc.red('✗')} Status check failed`)

    log.line('')
    log.line(`${pc.red('Error:')} ${error instanceof Error ? error.message : String(error)}`)
    log.flush()

    await cleanupProvider(provider)

    cancel('Status check failed')
    process.exit(1)
  }
}
