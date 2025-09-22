/**
 * Interactive payment setup flow with TTY support
 *
 * This module provides a guided, interactive setup experience for configuring
 * payment approvals. It uses @clack/prompts for a terminal interface
 * with password-style input for private keys and spinners for long operations.
 */

import { cancel, confirm, isCancel, password, text } from '@clack/prompts'
import { RPC_URLS, Synapse, TIME_CONSTANTS } from '@filoz/synapse-sdk'
import { ethers } from 'ethers'
import pc from 'picocolors'
import { cleanupProvider, cleanupSynapseService } from '../synapse/service.js'
import { createSpinner, intro, outro } from '../utils/cli-helpers.js'
import { isTTY, log } from '../utils/cli-logger.js'
import {
  calculateActualCapacity,
  calculateStorageAllowances,
  calculateStorageFromUSDFC,
  checkFILBalance,
  checkUSDFCBalance,
  depositUSDFC,
  displayAccountInfo,
  displayCapacity,
  displayDepositWarning,
  displayPaymentSummary,
  displayPricing,
  displayServicePermissions,
  formatUSDFC,
  getPaymentStatus,
  parseStorageAllowance,
  setServiceApprovals,
  validatePaymentRequirements,
} from './setup.js'
import type { PaymentSetupOptions, StorageAllowances } from './types.js'

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
    // Step 1: Get private key
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

    // Step 2: Initialize Synapse
    const s = createSpinner()
    s.start('Initializing connection...')

    const rpcUrl = options.rpcUrl || RPC_URLS.calibration.websocket

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

    s.stop(`${pc.green('✓')} Connected to ${pc.bold(network)}`)

    // Step 3: Check balances
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

    // Step 4: Handle deposits
    const defaultDeposit = ethers.parseUnits(options.deposit || '1', 18)
    let depositAmount = 0n
    let pricingShown = false // Track if pricing has been displayed

    if (status.depositedAmount < defaultDeposit) {
      // Show pricing info to help user decide
      displayPricing(pricePerGiBPerMonth, pricePerTiBPerMonth)
      pricingShown = true

      const shouldDeposit = await confirm({
        message: `Would you like to deposit USDFC? (Current: ${formatUSDFC(status.depositedAmount)}, Recommended: ${formatUSDFC(defaultDeposit)})`,
        initialValue: true,
      })

      if (isCancel(shouldDeposit)) {
        cancel('Setup cancelled')
        process.exit(1)
      }

      if (shouldDeposit) {
        const amountStr = await text({
          message: 'How much USDFC would you like to deposit?',
          placeholder: '1.0',
          initialValue: formatUSDFC(defaultDeposit - status.depositedAmount),
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
      }
    }

    // Step 5: Set storage allowances
    log.line(pc.bold('Your Current WarmStorage Service Limits:'))

    // Show current allowances
    let currentAllowances = status.currentAllowances
    if (currentAllowances.rateAllowance > 0n) {
      // Calculate actual vs potential capacity
      const capacityTiB = calculateActualCapacity(currentAllowances.rateAllowance, pricePerTiBPerEpoch)
      const totalDeposit = status.depositedAmount + depositAmount
      const capacity = {
        actualGiB: capacityTiB * 1024,
        potentialGiB: capacityTiB * 1024,
        isDepositLimited: totalDeposit < currentAllowances.lockupAllowance,
        additionalDepositNeeded:
          currentAllowances.lockupAllowance > totalDeposit ? currentAllowances.lockupAllowance - totalDeposit : 0n,
      }
      const monthlyRate = currentAllowances.rateAllowance * TIME_CONSTANTS.EPOCHS_PER_MONTH

      log.indent(`Max payment: ${formatUSDFC(monthlyRate)} USDFC/month`)
      log.indent(`Max reserve: ${formatUSDFC(currentAllowances.lockupAllowance)} USDFC (10-day lockup)`)

      displayCapacity(capacity)
      log.flush()
    } else {
      log.indent(pc.gray('No limits set yet'))
      log.flush()
    }

    // Ask about setting/updating storage limits
    const shouldSetAllowances = await confirm({
      message: 'Would you like to set storage payment limits?',
      initialValue: currentAllowances.rateAllowance === 0n,
    })

    if (isCancel(shouldSetAllowances)) {
      cancel('Setup cancelled')
      process.exit(1)
    }

    if (shouldSetAllowances) {
      // Show pricing if not already shown
      if (!pricingShown) {
        displayPricing(pricePerGiBPerMonth, pricePerTiBPerMonth)
        pricingShown = true
      }

      const allowanceStr = await text({
        message: 'Enter storage allowance',
        placeholder: '1TiB/month or 0.0000565 (USDFC/epoch)',
        initialValue: options.rateAllowance || '1TiB/month',
        validate: (value: string) => {
          if (!value) return 'Storage allowance is required'
          return undefined
        },
      })

      if (isCancel(allowanceStr)) {
        cancel('Setup cancelled')
        process.exit(1)
      }

      // Parse and calculate allowances
      s.start('Calculating allowances...')
      let allowances: StorageAllowances
      try {
        const parsedTiB = parseStorageAllowance(allowanceStr)
        if (parsedTiB !== null) {
          // User specified TiB/month
          allowances = calculateStorageAllowances(parsedTiB, pricePerTiBPerEpoch)
        } else {
          // User specified USDFC per epoch directly
          const usdfcPerEpochBigint = ethers.parseUnits(allowanceStr, 18)
          const capacityTiB = calculateStorageFromUSDFC(usdfcPerEpochBigint, pricePerTiBPerEpoch)
          allowances = calculateStorageAllowances(capacityTiB, pricePerTiBPerEpoch)
        }
      } catch (error) {
        s.stop(`${pc.red('✗')} Invalid storage allowance format`)
        console.error(pc.red(error instanceof Error ? error.message : 'Invalid format'))
        cancel('Setup cancelled')
        process.exit(1)
      }
      s.stop(`${pc.green('✓')} Allowances calculated`)

      const monthlyRate = allowances.rateAllowance * TIME_CONSTANTS.EPOCHS_PER_MONTH

      // Calculate total deposit including any new deposits
      const totalDeposit = status.depositedAmount + depositAmount

      // Display the new permissions with capacity info
      displayServicePermissions(
        'New WarmStorage Service Limits:',
        monthlyRate,
        allowances.lockupAllowance,
        totalDeposit,
        pricePerTiBPerEpoch
      )

      // Check if deposit is sufficient for lockup
      if (totalDeposit < allowances.lockupAllowance) {
        log.newline()
        log.message(
          pc.yellow(
            `⚠ Insufficient deposit for WarmStorage service reserve (need ${formatUSDFC(allowances.lockupAllowance)} USDFC)`
          )
        )
        const shouldContinue = await confirm({
          message: 'Continue anyway? (You can deposit more later)',
          initialValue: false,
        })

        if (isCancel(shouldContinue) || !shouldContinue) {
          cancel('Setup cancelled')
          process.exit(1)
        }
      }

      // Set approvals
      s.start('Setting WarmStorage service approvals...')
      const approvalTx = await setServiceApprovals(synapse, allowances.rateAllowance, allowances.lockupAllowance)
      s.stop(`${pc.green('✓')} WarmStorage service approvals set`)
      log.indent(pc.gray(`Transaction: ${approvalTx}`))

      // Update currentAllowances to reflect the new values
      currentAllowances = {
        rateAllowance: allowances.rateAllowance,
        lockupAllowance: allowances.lockupAllowance,
        rateUsed: 0n,
        lockupUsed: 0n,
      }
    }

    // Step 6: Offer additional deposit if it would help utilize the configured limits
    // Only if we haven't just done an initial deposit and have limits configured
    const didInitialDeposit = depositAmount > 0n
    const hasConfiguredLimits = currentAllowances.rateAllowance > 0n

    if (!didInitialDeposit && hasConfiguredLimits) {
      // Check if we're deposit-limited and could benefit from more funds
      const currentTotalDeposit = status.depositedAmount + depositAmount
      const capacityTiB = calculateActualCapacity(currentAllowances.rateAllowance, pricePerTiBPerEpoch)
      const capacity = {
        actualGiB: capacityTiB * 1024,
        potentialGiB: capacityTiB * 1024,
        isDepositLimited: currentTotalDeposit < currentAllowances.lockupAllowance,
        additionalDepositNeeded:
          currentAllowances.lockupAllowance > currentTotalDeposit
            ? currentAllowances.lockupAllowance - currentTotalDeposit
            : 0n,
      }

      // Always offer if deposit-limited or below lockup requirement
      if (capacity.isDepositLimited || currentTotalDeposit < currentAllowances.lockupAllowance) {
        const shouldDepositMore = await confirm({
          message: `Would you like to deposit additional USDFC to better utilize your payment limits? (Current: ${formatUSDFC(currentTotalDeposit)})`,
          initialValue: capacity.isDepositLimited,
        })

        if (isCancel(shouldDepositMore)) {
          cancel('Setup cancelled')
          process.exit(1)
        }

        if (shouldDepositMore) {
          // Don't show pricing again if already shown
          if (!pricingShown) {
            displayPricing(pricePerGiBPerMonth, pricePerTiBPerMonth)
          }

          if (capacity.isDepositLimited) {
            log.newline()
            log.message(
              `${pc.yellow('Recommended:')} Deposit at least ${formatUSDFC(capacity.additionalDepositNeeded)} more to fully utilize your configured limits`
            )
          }

          const amountStr = await text({
            message: 'How much USDFC would you like to deposit?',
            placeholder: '1.0',
            initialValue: capacity.isDepositLimited ? formatUSDFC(capacity.additionalDepositNeeded) : '1.0',
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

          const additionalDeposit = ethers.parseUnits(amountStr, 18)
          depositAmount += additionalDeposit

          s.start('Depositing USDFC...')
          const { approvalTx, depositTx } = await depositUSDFC(synapse, additionalDeposit)
          s.stop(`${pc.green('✓')} Deposit complete`)

          if (approvalTx) {
            log.indent(pc.gray(`Approval tx: ${approvalTx}`))
          }
          log.indent(pc.gray(`Deposit tx: ${depositTx}`))
        }
      }
    }

    // Step 7: Final summary
    s.start('Fetching final status...')
    const finalStatus = await getPaymentStatus(synapse)
    s.stop('━━━ Setup Complete ━━━')

    // Use the shared display function for consistency
    displayPaymentSummary(
      network,
      filStatus.balance,
      filStatus.isCalibnet,
      usdfcBalance,
      finalStatus.depositedAmount,
      finalStatus.currentAllowances.rateAllowance,
      finalStatus.currentAllowances.lockupAllowance,
      pricePerTiBPerEpoch
    )

    // Show deposit warning if needed
    displayDepositWarning(finalStatus.depositedAmount, finalStatus.currentAllowances.lockupUsed)

    outro('Payment setup completed successfully')
  } catch (error) {
    console.error(`\n${pc.red('Error:')}`, error instanceof Error ? error.message : error)
    process.exitCode = 1
  } finally {
    await cleanupProvider(provider)
    process.exit()
  }
}
