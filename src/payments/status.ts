/**
 * Payment status display command
 *
 * Shows current payment configuration and balances for Filecoin Onchain Cloud.
 * This provides a quick overview of the user's payment setup without making changes.
 */

import { RPC_URLS, Synapse } from '@filoz/synapse-sdk'
import { ethers } from 'ethers'
import pc from 'picocolors'
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

  console.log(pc.bold('Filecoin Onchain Cloud Payment Status'))
  console.log(pc.gray('Fetching current configuration...'))

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
    const { balance: filBalance, isCalibnet } = await checkFILBalance(synapse)
    const usdfcBalance = await checkUSDFCBalance(synapse)
    const status = await getPaymentStatus(synapse)

    // Get storage pricing for capacity calculation
    const storageInfo = await synapse.storage.getStorageInfo()
    const pricePerTiBPerEpoch = storageInfo.pricing.noCDN.perTiBPerEpoch

    // Display status (with custom header)
    console.log(`\n━━━ Current Status ━━━`)
    console.log(`Address: ${address}`)

    displayPaymentSummary(
      network,
      filBalance,
      isCalibnet,
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
    console.log(`\n${pc.gray('Payment rails details coming soon...')}`)

    // Clean up WebSocket providers to allow process termination
    if (provider && typeof provider.destroy === 'function') {
      try {
        await provider.destroy()
      } catch {
        // Ignore cleanup errors
      }
    }
  } catch (error) {
    console.error(`\n${pc.red('Error:')}`, error instanceof Error ? error.message : error)

    // Clean up even on error
    if (provider && typeof provider.destroy === 'function') {
      try {
        await provider.destroy()
      } catch {
        // Ignore cleanup errors
      }
    }

    process.exit(1)
  }
}
