/**
 * Interactive payment setup flow with TTY support
 *
 * This module provides a guided, interactive setup experience for configuring
 * payment approvals. It uses @clack/prompts for a terminal interface
 * with password-style input for private keys and spinners for long operations.
 */

import { cancel, confirm, intro, isCancel, outro, password, spinner, text } from '@clack/prompts'
import { RPC_URLS, Synapse, TIME_CONSTANTS } from '@filoz/synapse-sdk'
import { ethers } from 'ethers'
import pc from 'picocolors'
import {
  calculateActualCapacity,
  calculateStorageAllowances,
  calculateStorageFromUSDFC,
  checkFILBalance,
  checkUSDFCBalance,
  createProvider,
  depositUSDFC,
  displayCapacity,
  displayDepositWarning,
  displayServicePermissions,
  formatFIL,
  formatUSDFC,
  getPaymentStatus,
  parseStorageAllowance,
  setServiceApprovals,
} from './setup.js'
import type { PaymentSetupOptions, StorageAllowances } from './types.js'

/**
 * Run interactive payment setup
 *
 * @param options - Initial options from command line
 */
export async function runInteractiveSetup(options: PaymentSetupOptions): Promise<void> {
  // Check for TTY support
  if (!process.stdout.isTTY) {
    console.error(pc.red('Error: Interactive mode requires a TTY terminal.'))
    console.error('Use --auto flag for non-interactive setup.')
    process.exit(1)
  }

  intro(pc.bold('Filecoin Onchain Cloud Payment Setup'))

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
        process.exit(0)
      }

      // Add 0x prefix if it was missing
      privateKey = input.startsWith('0x') ? input : `0x${input}`
    }

    // Step 2: Initialize Synapse
    const s = spinner({ indicator: 'timer' })
    s.start('Initializing connection...')

    const rpcUrl = options.rpcUrl || RPC_URLS.calibration.websocket

    const wallet = new ethers.Wallet(privateKey)
    const provider = createProvider(rpcUrl)
    const signer = wallet.connect(provider)

    const synapse = await Synapse.create({ signer })
    const network = synapse.getNetwork()
    const address = await signer.getAddress()

    s.stop(`${pc.green('✓')} Connected to ${pc.bold(network)}`)
    console.log(pc.gray(`  Wallet: ${address}`))

    // Step 3: Check balances
    s.start('Checking balances...')

    const { balance: filBalance, isCalibnet, hasSufficientGas } = await checkFILBalance(synapse)
    const usdfcBalance = await checkUSDFCBalance(synapse)
    const status = await getPaymentStatus(synapse)

    s.stop(`${pc.green('✓')} Balance check complete`)

    // Display balance summary
    console.log(`\n${pc.bold('Current Balances:')}`)
    console.log(
      `  ${formatFIL(filBalance, isCalibnet)}: ${hasSufficientGas ? pc.green('✓') : pc.red('✗ Insufficient for gas')}`
    )
    console.log(`  USDFC wallet: ${formatUSDFC(usdfcBalance)} USDFC`)
    console.log(`  USDFC deposited: ${formatUSDFC(status.depositedAmount)} USDFC`)

    // Check if user needs funds
    if (!hasSufficientGas) {
      console.log(`\n${pc.yellow('⚠ Insufficient FIL for gas fees')}`)
      if (isCalibnet) {
        console.log(`  Get test FIL from: ${pc.cyan('https://faucet.calibnet.chainsafe-fil.io/')}`)
      }
      cancel('Please fund your wallet and try again')
      process.exit(1)
    }

    if (usdfcBalance === 0n) {
      console.log(`\n${pc.yellow('⚠ No USDFC tokens found')}`)
      if (isCalibnet) {
        console.log(
          '  Get test USDFC from: ' +
            pc.cyan('https://docs.secured.finance/usdfc-stablecoin/getting-started/getting-test-usdfc-on-testnet')
        )
      } else {
        console.log(
          '  Mint USDFC with FIL: ' +
            pc.cyan('https://docs.secured.finance/usdfc-stablecoin/getting-started/minting-usdfc-step-by-step')
        )
      }
      cancel('Please acquire USDFC tokens and try again')
      process.exit(1)
    }

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

    if (status.depositedAmount < defaultDeposit) {
      // Use pricing info to help user decide

      console.log(`\n${pc.bold('Current Pricing:')}`)
      console.log(`  1 GiB/month: ${formatUSDFC(pricePerGiBPerMonth)} USDFC`)
      console.log(`  1 TiB/month: ${formatUSDFC(pricePerTiBPerMonth)} USDFC`)
      console.log(pc.gray('  (10-day reserve required for active storage)'))

      const shouldDeposit = await confirm({
        message: `Would you like to deposit USDFC? (Current: ${formatUSDFC(status.depositedAmount)}, Recommended: ${formatUSDFC(defaultDeposit)})`,
        initialValue: true,
      })

      if (isCancel(shouldDeposit)) {
        cancel('Setup cancelled')
        process.exit(0)
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
          process.exit(0)
        }

        depositAmount = ethers.parseUnits(amountStr, 18)

        s.start('Depositing USDFC...')
        const { approvalTx, depositTx } = await depositUSDFC(synapse, depositAmount)
        s.stop(`${pc.green('✓')} Deposit complete`)

        if (approvalTx) {
          console.log(pc.gray(`  Approval tx: ${approvalTx}`))
        }
        console.log(pc.gray(`  Deposit tx: ${depositTx}`))
      }
    }

    // Step 5: Set storage allowances
    console.log(`\n${pc.bold('Your Current WarmStorage Service Limits:')}`)

    // Show current allowances
    let currentAllowances = status.currentAllowances
    if (currentAllowances.rateAllowance > 0n) {
      // Calculate actual vs potential capacity
      const capacity = calculateActualCapacity(
        status.depositedAmount + depositAmount, // Include any deposits we just made
        currentAllowances.rateAllowance,
        currentAllowances.lockupAllowance,
        pricePerTiBPerEpoch
      )
      const monthlyRate = currentAllowances.rateAllowance * TIME_CONSTANTS.EPOCHS_PER_MONTH

      console.log(`  Max payment: ${formatUSDFC(monthlyRate)} USDFC/month`)
      console.log(`  Max reserve: ${formatUSDFC(currentAllowances.lockupAllowance)} USDFC (10-day lockup)`)

      displayCapacity(capacity)
    } else {
      console.log(pc.gray('  No limits set yet'))
    }

    // Ask about setting/updating storage limits
    const shouldSetAllowances = await confirm({
      message: 'Would you like to set storage payment limits?',
      initialValue: currentAllowances.rateAllowance === 0n,
    })

    if (isCancel(shouldSetAllowances)) {
      cancel('Setup cancelled')
      process.exit(0)
    }

    if (shouldSetAllowances) {
      // Show pricing to help with decision
      console.log(`\n${pc.bold('Storage Pricing:')}`)
      console.log(`  1 GiB/month: ${formatUSDFC(pricePerGiBPerMonth)} USDFC`)
      console.log(`  1 TiB/month: ${formatUSDFC(pricePerTiBPerMonth)} USDFC`)
      console.log(pc.gray('  (for each upload, WarmStorage service will reserve 10 days of costs as security)'))

      const allowanceStr = await text({
        message: 'Enter storage allowance',
        placeholder: '1TiB/month or 0.0000565 (USDFC/epoch)',
        initialValue: options.rateAllowance || '1TiB/month',
        validate: (value: string) => {
          // Note: Can't use async validation here due to @clack/prompts limitations
          // We'll validate after the input is received
          if (!value) return 'Storage allowance is required'
          return undefined
        },
      })

      if (isCancel(allowanceStr)) {
        cancel('Setup cancelled')
        process.exit(0)
      }

      // Parse and calculate allowances
      s.start('Calculating allowances...')
      let allowances: StorageAllowances
      try {
        const parsedTiB = parseStorageAllowance(allowanceStr)
        if (parsedTiB !== null) {
          // User specified TiB/month
          allowances = await calculateStorageAllowances(synapse, parsedTiB)
        } else {
          // User specified USDFC per epoch directly
          allowances = await calculateStorageFromUSDFC(synapse, allowanceStr)
        }
      } catch (error) {
        s.stop(`${pc.red('✗')} Invalid storage allowance format`)
        console.error(pc.red(error instanceof Error ? error.message : 'Invalid format'))
        cancel('Setup cancelled')
        process.exit(1)
      }
      s.stop(`${pc.green('✓')} Allowances calculated`)

      const pricePerTiBPerEpoch = storageInfo.pricing.noCDN.perTiBPerEpoch
      const monthlyRate = allowances.ratePerEpoch * TIME_CONSTANTS.EPOCHS_PER_MONTH

      // Calculate total deposit including any new deposits
      const totalDeposit = status.depositedAmount + depositAmount

      // Display the new permissions with capacity info
      displayServicePermissions(
        'New WarmStorage Service Limits:',
        monthlyRate,
        allowances.lockupAmount,
        totalDeposit,
        pricePerTiBPerEpoch
      )

      // Check if deposit is sufficient for lockup
      if (totalDeposit < allowances.lockupAmount) {
        console.log(
          '\n' +
            pc.yellow(
              `⚠ Insufficient deposit for WarmStorage service reserve (need ${formatUSDFC(allowances.lockupAmount)} USDFC)`
            )
        )
        const shouldContinue = await confirm({
          message: 'Continue anyway? (You can deposit more later)',
          initialValue: false,
        })

        if (isCancel(shouldContinue) || !shouldContinue) {
          cancel('Setup cancelled')
          process.exit(0)
        }
      }

      // Set approvals
      s.start('Setting WarmStorage service approvals...')
      const approvalTx = await setServiceApprovals(synapse, allowances.ratePerEpoch, allowances.lockupAmount)
      s.stop(`${pc.green('✓')} WarmStorage service approvals set`)
      console.log(pc.gray(`  Transaction: ${approvalTx}`))

      // Update currentAllowances to reflect the new values
      currentAllowances = {
        rateAllowance: allowances.ratePerEpoch,
        lockupAllowance: allowances.lockupAmount,
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
      const capacity = calculateActualCapacity(
        currentTotalDeposit,
        currentAllowances.rateAllowance,
        currentAllowances.lockupAllowance,
        pricePerTiBPerEpoch
      )

      // Always offer if deposit-limited or below lockup requirement
      if (capacity.isDepositLimited || currentTotalDeposit < currentAllowances.lockupAllowance) {
        const shouldDepositMore = await confirm({
          message: `Would you like to deposit additional USDFC to better utilize your payment limits? (Current: ${formatUSDFC(currentTotalDeposit)})`,
          initialValue: capacity.isDepositLimited,
        })

        if (isCancel(shouldDepositMore)) {
          cancel('Setup cancelled')
          process.exit(0)
        }

        if (shouldDepositMore) {
          console.log(`\n${pc.bold('Current Pricing:')}`)
          console.log(`  1 GiB/month: ${formatUSDFC(pricePerGiBPerMonth)} USDFC`)
          console.log(`  1 TiB/month: ${formatUSDFC(pricePerTiBPerMonth)} USDFC`)
          console.log(pc.gray('  (10-day reserve required for active storage)'))

          if (capacity.isDepositLimited) {
            console.log(
              `\n${pc.yellow('Recommended:')} Deposit at least ${formatUSDFC(capacity.additionalDepositNeeded)} more to fully utilize your configured limits`
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
            process.exit(0)
          }

          const additionalDeposit = ethers.parseUnits(amountStr, 18)
          depositAmount += additionalDeposit

          s.start('Depositing USDFC...')
          const { approvalTx, depositTx } = await depositUSDFC(synapse, additionalDeposit)
          s.stop(`${pc.green('✓')} Deposit complete`)

          if (approvalTx) {
            console.log(pc.gray(`  Approval tx: ${approvalTx}`))
          }
          console.log(pc.gray(`  Deposit tx: ${depositTx}`))
        }
      }
    }

    // Step 7: Final summary
    s.start('Fetching final status...')
    const finalStatus = await getPaymentStatus(synapse)
    s.stop(`${pc.green('✓')} Setup complete`)

    // Final summary with three clear sections
    outro(pc.bold('━━━ Setup Complete ━━━'))
    console.log(`Network: ${pc.bold(network)}`)

    // Section 1: Wallet
    console.log(`\n${pc.bold('Wallet')}`)
    console.log(`  ${formatFIL(filBalance, isCalibnet)}`)
    console.log(`  ${formatUSDFC(usdfcBalance)} USDFC`)

    // Section 2: Filecoin Pay deposit
    console.log(`\n${pc.bold('Filecoin Pay Deposit')}`)
    console.log(`  ${formatUSDFC(finalStatus.depositedAmount)} USDFC`)
    console.log(pc.gray('  (spendable on any service)'))

    // Section 3: WarmStorage service permissions
    const monthlyRate = finalStatus.currentAllowances.rateAllowance * TIME_CONSTANTS.EPOCHS_PER_MONTH
    displayServicePermissions(
      'Your WarmStorage Service Limits',
      monthlyRate,
      finalStatus.currentAllowances.lockupAllowance,
      finalStatus.depositedAmount,
      pricePerTiBPerEpoch
    )

    // Show deposit warning if needed
    displayDepositWarning(finalStatus.depositedAmount, finalStatus.currentAllowances.lockupUsed)

    // Clean up
    await provider.destroy()
  } catch (error) {
    console.error(`\n${pc.red('Error:')}`, error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
