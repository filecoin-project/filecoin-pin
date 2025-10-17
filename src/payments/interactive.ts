/**
 * Interactive payment setup flow with TTY support
 *
 * This module provides a guided, interactive setup experience for configuring
 * payment approvals. It uses @clack/prompts for a terminal interface
 * with password-style input for private keys and spinners for long operations.
 */

import { cancel, confirm, isCancel, password, text } from '@clack/prompts'
import { RPC_URLS, Synapse } from '@filoz/synapse-sdk'
import { ethers } from 'ethers'
import pc from 'picocolors'
import {
  calculateDepositCapacity,
  checkAllowances,
  checkFILBalance,
  checkUSDFCBalance,
  depositUSDFC,
  getPaymentStatus,
  setMaxAllowances,
  validatePaymentRequirements,
} from '../core/payments/index.js'
import { cleanupProvider, cleanupSynapseService } from '../core/synapse/index.js'
import { formatUSDFC } from '../core/utils/format.js'
import { createSpinner, intro, outro } from '../utils/cli-helpers.js'
import { isTTY, log } from '../utils/cli-logger.js'
import { displayAccountInfo, displayDepositWarning, displayPricing } from './setup.js'
import type { PaymentSetupOptions } from './types.js'

/**
 * Run interactive payment setup
 *
 * @param options - Initial options from command line
 */
export async function runInteractiveSetup(options: PaymentSetupOptions): Promise<void> {
  // Check for TTY support
  if (!isTTY()) {
    console.error(pc.red('Error: Interactive mode requires a TTY terminal.'))
    console.error('Use --auto flag for non-interactive setup.')
    // Even though we're exiting early, ensure any background connections are cleaned up
    await cleanupSynapseService()
    process.exit(1)
  }

  intro(pc.bold('Filecoin Onchain Cloud Payment Setup'))

  // Store provider reference for cleanup if it's a WebSocket provider
  let provider: any = null

  try {
    // Get private key
    let privateKey = options.privateKey || process.env.PRIVATE_KEY

    if (!privateKey) {
      const input = await password({
        message: 'Enter your private key',
        validate: (value: string) => {
          if (!value) return 'Private key is required'

          // Add 0x prefix if missing
          const key = value.startsWith('0x') ? value : `0x${value}`

          // Validate format: 0x followed by 64 hex characters
          if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
            return 'Private key must be 64 hex characters (with or without 0x prefix)'
          }

          try {
            new ethers.Wallet(key)
            return undefined
          } catch {
            return 'Invalid private key format'
          }
        },
      })

      if (isCancel(input)) {
        cancel('Setup cancelled')
        process.exit(1)
      }

      // Add 0x prefix if it was missing
      privateKey = input.startsWith('0x') ? input : `0x${input}`
    }

    // Initialize Synapse
    const s = createSpinner()
    s.start('Initializing connection...')

    const rpcUrl = options.rpcUrl || RPC_URLS.calibration.websocket

    const synapse = await Synapse.create({
      privateKey,
      rpcURL: rpcUrl,
      withIpni: true, // Always filter for IPNI-enabled providers
    })
    const network = synapse.getNetwork()
    const client = synapse.getClient()
    const address = await client.getAddress()

    // Store provider reference for cleanup if it's a WebSocket provider
    if (rpcUrl.match(/^wss?:\/\//)) {
      provider = synapse.getProvider()
    }

    s.stop(`${pc.green('✓')} Connected to ${pc.bold(network)}`)

    // Check balances
    s.start('Checking balances...')

    const filStatus = await checkFILBalance(synapse)
    const usdfcBalance = await checkUSDFCBalance(synapse)

    s.stop(`${pc.green('✓')} Balance check complete`)

    // Validate payment requirements
    const validation = validatePaymentRequirements(filStatus.hasSufficientGas, usdfcBalance, filStatus.isCalibnet)
    if (!validation.isValid) {
      log.line(`${pc.red('✗')} ${validation.errorMessage}`)
      if (validation.helpMessage) {
        log.line('')
        log.line(`  ${pc.cyan(validation.helpMessage)}`)
      }
      log.flush()
      cancel('Please fund your wallet and try again')
      process.exit(1)
    }

    // Now safe to get payment status since we know account exists
    const status = await getPaymentStatus(synapse)

    displayAccountInfo(
      address,
      network,
      filStatus.balance,
      filStatus.isCalibnet,
      filStatus.hasSufficientGas,
      usdfcBalance,
      status.depositedAmount
    )

    // Get storage pricing info once for all subsequent operations
    s.start('Getting current pricing...')
    const storageInfo = await synapse.storage.getStorageInfo()
    const pricePerTiBPerEpoch = storageInfo.pricing.noCDN.perTiBPerEpoch
    const pricePerTiBPerMonth = storageInfo.pricing.noCDN.perTiBPerMonth
    const pricePerGiBPerMonth = pricePerTiBPerMonth / 1024n
    s.stop(`${pc.green('✓')} Pricing loaded`)

    // Initialize tracking variables
    let depositAmount = 0n
    let actionsTaken = false // Track if any changes were made

    // Check and optionally set max allowances for WarmStorage
    s.start('Checking WarmStorage permissions...')
    const allowanceCheck = await checkAllowances(synapse)

    if (allowanceCheck.needsUpdate) {
      s.stop(`${pc.yellow('⚠')} WarmStorage authorization required`)
      log.line('')
      log.line(pc.bold('WarmStorage Service Authorization'))
      log.line('WarmStorage needs permissions to manage storage payments on your behalf.')
      log.line('This is a one-time setup.')
      log.line('')

      const shouldSetAllowances = await confirm({
        message: 'Authorize WarmStorage?',
        initialValue: true,
      })

      if (isCancel(shouldSetAllowances)) {
        cancel('Setup cancelled')
        process.exit(1)
      }

      if (shouldSetAllowances) {
        s.start('Setting WarmStorage permissions...')
        const setResult = await setMaxAllowances(synapse)
        s.stop(`${pc.green('✓')} WarmStorage permissions configured`)
        log.indent(pc.gray(`Transaction: ${setResult.transactionHash}`))
        actionsTaken = true
      } else {
        log.line(pc.yellow('⚠ Skipping WarmStorage authorization. You may need to set this before using storage.'))
      }
    } else {
      s.stop(`${pc.green('✓')} WarmStorage permissions already configured`)
    }

    // Show current deposit capacity
    const currentCapacity = calculateDepositCapacity(status.depositedAmount, pricePerTiBPerEpoch)
    log.line(pc.bold('Current Storage Capacity:'))
    if (status.depositedAmount > 0n) {
      const capacityStr =
        currentCapacity.gibPerMonth >= 1024
          ? `${(currentCapacity.gibPerMonth / 1024).toFixed(1)} TiB`
          : `${currentCapacity.gibPerMonth.toFixed(1)} GiB`
      log.indent(`Deposit: ${formatUSDFC(status.depositedAmount)} USDFC`)
      log.indent(`Capacity: ~${capacityStr} for 1 month`)
    } else {
      log.indent(pc.gray('No deposit yet'))
    }
    log.flush()

    // Show pricing to help user understand costs
    displayPricing(pricePerGiBPerMonth, pricePerTiBPerMonth)

    // Offer deposit options with contextual message
    const depositMessage =
      status.depositedAmount === 0n
        ? 'Would you like to deposit USDFC to enable storage?'
        : 'Would you like to deposit additional USDFC?'

    const shouldDeposit = await confirm({
      message: depositMessage,
      initialValue: status.depositedAmount === 0n,
    })

    if (isCancel(shouldDeposit)) {
      cancel('Setup cancelled')
      process.exit(1)
    }

    if (shouldDeposit) {
      // Show examples to help user decide
      log.line(pc.bold('Storage Examples (per month):'))
      log.indent(`100 GiB capacity: ~${formatUSDFC((pricePerGiBPerMonth * 100n * 11n) / 10n)} USDFC`)
      log.indent(`1 TiB capacity:   ~${formatUSDFC((pricePerTiBPerMonth * 11n) / 10n)} USDFC`)
      log.indent(`10 TiB capacity:  ~${formatUSDFC((pricePerTiBPerMonth * 10n * 11n) / 10n)} USDFC`)
      log.indent(pc.gray('(deposit covers 1 month + 10-day safety reserve)'))
      log.flush()

      const amountStr = await text({
        message: 'How much USDFC would you like to deposit?',
        placeholder: '10.0',
        initialValue: status.depositedAmount === 0n ? '10.0' : '5.0',
        validate: (value: string) => {
          try {
            const amount = ethers.parseUnits(value, 18)
            if (amount <= 0n) return 'Amount must be greater than 0'
            if (amount > usdfcBalance) return `Insufficient balance (have ${formatUSDFC(usdfcBalance)} USDFC)`
            return undefined
          } catch {
            return 'Invalid amount'
          }
        },
      })

      if (isCancel(amountStr)) {
        cancel('Setup cancelled')
        process.exit(1)
      }

      depositAmount = ethers.parseUnits(amountStr, 18)

      s.start('Depositing USDFC...')
      const { approvalTx, depositTx } = await depositUSDFC(synapse, depositAmount)
      s.stop(`${pc.green('✓')} Deposit complete`)

      if (approvalTx) {
        log.indent(pc.gray(`Approval tx: ${approvalTx}`))
      }
      log.indent(pc.gray(`Deposit tx: ${depositTx}`))
      actionsTaken = true

      // Show new capacity after deposit
      const newCapacity = calculateDepositCapacity(status.depositedAmount + depositAmount, pricePerTiBPerEpoch)
      const newCapacityStr =
        newCapacity.gibPerMonth >= 1024
          ? `${(newCapacity.gibPerMonth / 1024).toFixed(1)} TiB`
          : `${newCapacity.gibPerMonth.toFixed(1)} GiB`
      log.line('')
      log.line(pc.bold('New Storage Capacity:'))
      log.indent(`Total deposit: ${formatUSDFC(status.depositedAmount + depositAmount)} USDFC`)
      log.indent(`Capacity: ~${newCapacityStr} for 1 month`)
      log.flush()
    }

    // Final summary
    s.start('Fetching final status...')
    const finalStatus = await getPaymentStatus(synapse)
    s.stop('━━━ Setup Complete ━━━')

    const finalCapacity = calculateDepositCapacity(finalStatus.depositedAmount, pricePerTiBPerEpoch)

    log.line(`Network: ${pc.bold(network)}`)
    log.line('')

    log.line(pc.bold('Wallet'))
    log.indent(`${formatUSDFC(usdfcBalance)} USDFC available`)
    log.line('')

    log.line(pc.bold('Storage Deposit'))
    log.indent(`${formatUSDFC(finalStatus.depositedAmount)} USDFC deposited`)
    if (finalCapacity.gibPerMonth > 0) {
      const capacityStr =
        finalCapacity.gibPerMonth >= 1024
          ? `${(finalCapacity.gibPerMonth / 1024).toFixed(1)} TiB`
          : `${finalCapacity.gibPerMonth.toFixed(1)} GiB`
      log.indent(`Capacity: ~${capacityStr} for 1 month`)
      log.indent(pc.gray('(includes 10-day safety reserve)'))
    }
    log.flush()

    // Show deposit warning if needed
    displayDepositWarning(finalStatus.depositedAmount, finalStatus.currentAllowances.lockupUsed)

    // Show appropriate outro message based on whether actions were taken
    if (actionsTaken) {
      outro('Payment setup completed successfully')
    } else {
      outro('No changes made to payment setup')
    }
  } catch (error) {
    console.error(`\n${pc.red('Error:')}`, error instanceof Error ? error.message : error)
    process.exitCode = 1
  } finally {
    await cleanupProvider(provider)
    process.exit()
  }
}
