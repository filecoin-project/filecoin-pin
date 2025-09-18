/**
 * Automatic payment setup flow
 *
 * This module provides an automated, non-interactive setup experience for
 * configuring payment approvals. It uses default values and command-line
 * options to complete the setup without user interaction.
 */

import { spinner as clackSpinner } from '@clack/prompts'
import { RPC_URLS, Synapse, TIME_CONSTANTS } from '@filoz/synapse-sdk'
import { ethers } from 'ethers'
import pc from 'picocolors'
import {
  calculateStorageAllowances,
  calculateStorageFromUSDFC,
  checkFILBalance,
  checkUSDFCBalance,
  createProvider,
  depositUSDFC,
  displayDepositWarning,
  displayPaymentSummary,
  displayServicePermissions,
  formatFIL,
  formatUSDFC,
  getPaymentStatus,
  parseStorageAllowance,
  setServiceApprovals,
} from './setup.js'
import type { PaymentSetupOptions, StorageAllowances } from './types.js'

/**
 * Creates a spinner that works in both TTY and non-TTY environments
 *
 * In TTY mode: Uses @clack/prompts spinner for nice visual feedback
 * In non-TTY mode: Prints simple status messages without ANSI codes
 */
function createSpinner() {
  const isTTY = process.stdout.isTTY

  if (isTTY) {
    // Use the real spinner for TTY
    return clackSpinner({ indicator: 'timer' })
  } else {
    // Non-TTY fallback - just print messages without spinners
    return {
      start(msg: string) {
        console.log(msg)
      },
      message(msg: string) {
        console.log(msg)
      },
      stop(msg?: string) {
        if (msg) {
          console.log(msg)
        }
      },
    }
  }
}

/**
 * Run automatic payment setup with defaults
 *
 * @param options - Options from command line
 */
export async function runAutoSetup(options: PaymentSetupOptions): Promise<void> {
  console.log(pc.bold('Filecoin Onchain Cloud Payment Setup'))
  console.log(pc.gray('Running in auto mode...'))

  // Parse and validate all arguments upfront
  // 1. Private key
  const privateKey = options.privateKey || process.env.PRIVATE_KEY
  if (!privateKey) {
    console.error(pc.red('Error: Private key required via --private-key or PRIVATE_KEY env'))
    process.exit(1)
  }

  let wallet: ethers.Wallet
  try {
    wallet = new ethers.Wallet(privateKey)
  } catch {
    console.error(pc.red('Error: Invalid private key format'))
    process.exit(1)
  }

  // 2. RPC URL
  const rpcUrl = options.rpcUrl || RPC_URLS.calibration.websocket

  // 3. Deposit amount
  let targetDeposit: bigint
  try {
    targetDeposit = ethers.parseUnits(options.deposit, 18)
  } catch {
    console.error(pc.red(`Error: Invalid deposit amount '${options.deposit}'`))
    process.exit(1)
  }

  // 4. Parse storage allowance early to validate format
  if (!options.rateAllowance) {
    console.error(pc.red('Error: Storage allowance is required'))
    process.exit(1)
  }

  let parsedTiB: number | null
  let rawUsdfcPerEpoch: string | null = null
  try {
    parsedTiB = parseStorageAllowance(options.rateAllowance)
    if (parsedTiB === null) {
      // parseStorageAllowance already validated it's a valid USDFC amount
      // (it would have thrown otherwise), so we can safely save it
      rawUsdfcPerEpoch = options.rateAllowance
    }
  } catch (error) {
    console.error(pc.red(`Error: Invalid storage allowance '${options.rateAllowance}'`))
    console.error(pc.red(error instanceof Error ? error.message : String(error)))
    process.exit(1)
  }

  const spinner = createSpinner()
  spinner.start('Initializing connection...')

  try {
    // Initialize Synapse
    const provider = createProvider(rpcUrl)
    const signer = wallet.connect(provider)

    const synapse = await Synapse.create({ signer })
    const network = synapse.getNetwork()
    const address = await signer.getAddress()

    spinner.stop(`${pc.green('✓')} Connected to ${pc.bold(network)}`)

    // Check balances
    spinner.start('Checking balances...')

    const { balance: filBalance, isCalibnet, hasSufficientGas } = await checkFILBalance(synapse)
    const usdfcBalance = await checkUSDFCBalance(synapse)
    const status = await getPaymentStatus(synapse)

    spinner.stop(`${pc.green('✓')} Balance check complete`)

    // Display connection and balance info together
    console.log(`\n${pc.bold('Account:')}`)
    console.log(pc.gray(`  Wallet: ${address}`))
    console.log(pc.gray(`  Network: ${network}`))
    console.log(`\n${pc.bold('Balances:')}`)
    console.log(pc.gray(`  FIL: ${formatFIL(filBalance, isCalibnet)}`))
    console.log(pc.gray(`  USDFC wallet: ${formatUSDFC(usdfcBalance)} USDFC`))
    console.log(pc.gray(`  USDFC deposited: ${formatUSDFC(status.depositedAmount)} USDFC`))

    // Check for insufficient funds
    if (!hasSufficientGas) {
      console.error(pc.red('✗ Insufficient FIL for gas fees'))
      if (isCalibnet) {
        console.log(pc.yellow('Get test FIL from: https://faucet.calibnet.chainsafe-fil.io/'))
      }
      process.exit(1)
    }

    if (usdfcBalance === 0n) {
      console.error(pc.red('✗ No USDFC tokens found'))
      if (isCalibnet) {
        console.log(
          pc.yellow(
            'Get test USDFC from: https://docs.secured.finance/usdfc-stablecoin/getting-started/getting-test-usdfc-on-testnet'
          )
        )
      } else {
        console.log(
          pc.yellow(
            'Mint USDFC with FIL: https://docs.secured.finance/usdfc-stablecoin/getting-started/minting-usdfc-step-by-step'
          )
        )
      }
      process.exit(1)
    }

    // Calculate storage allowances now that we have synapse
    let allowances: StorageAllowances
    if (parsedTiB !== null) {
      // User specified TiB/month, calculate allowances
      allowances = await calculateStorageAllowances(synapse, parsedTiB)
    } else if (rawUsdfcPerEpoch !== null) {
      // User specified USDFC per epoch directly
      allowances = await calculateStorageFromUSDFC(synapse, rawUsdfcPerEpoch)
    } else {
      // This shouldn't happen due to earlier validation
      throw new Error('Invalid storage allowance state')
    }

    // Handle deposits
    let actualDepositAmount = 0n

    if (status.depositedAmount < targetDeposit) {
      const depositAmount = targetDeposit - status.depositedAmount
      actualDepositAmount = depositAmount

      if (depositAmount > usdfcBalance) {
        console.error(
          pc.red(
            `✗ Insufficient USDFC for deposit (need ${formatUSDFC(depositAmount)} USDFC, have ${formatUSDFC(usdfcBalance)} USDFC)`
          )
        )
        process.exit(1)
      }

      spinner.start(`Depositing ${formatUSDFC(depositAmount)} USDFC...`)
      const { approvalTx, depositTx } = await depositUSDFC(synapse, depositAmount)
      spinner.stop(`${pc.green('✓')} Deposited ${formatUSDFC(depositAmount)} USDFC`)

      console.log(`\n${pc.bold('Transaction details:')}`)
      if (approvalTx) {
        console.log(pc.gray(`  Approval: ${approvalTx}`))
      }
      console.log(pc.gray(`  Deposit: ${depositTx}`))
    } else {
      // Use a dummy spinner to get consistent formatting
      spinner.start('Checking deposit...')
      spinner.stop(`${pc.green('✓')} Deposit already sufficient (${formatUSDFC(status.depositedAmount)} USDFC)`)
    }

    // Get storage pricing for capacity calculation
    const storageInfo = await synapse.storage.getStorageInfo()
    const pricePerTiBPerEpoch = storageInfo.pricing.noCDN.perTiBPerEpoch

    // Set storage allowances
    spinner.start(`Checking WarmStorage service allowances (${options.rateAllowance})...`)

    // Check if we need to update allowances
    const currentAllowances = status.currentAllowances
    let needsUpdate = false

    if (currentAllowances.rateAllowance < allowances.ratePerEpoch) {
      needsUpdate = true
    }

    if (currentAllowances.lockupAllowance < allowances.lockupAmount) {
      needsUpdate = true
    }

    // Calculate total deposit for capacity display
    const totalDeposit = status.depositedAmount + actualDepositAmount

    if (needsUpdate) {
      spinner.message('Setting WarmStorage service approvals...')
      const approvalTx = await setServiceApprovals(synapse, allowances.ratePerEpoch, allowances.lockupAmount)
      spinner.stop(`${pc.green('✓')} WarmStorage service approvals updated`)

      console.log(`\n${pc.bold('Transaction:')}`)
      console.log(pc.gray(`  ${approvalTx}`))

      // Display new permissions with capacity info
      const monthlyRate = allowances.ratePerEpoch * TIME_CONSTANTS.EPOCHS_PER_MONTH
      displayServicePermissions(
        'New WarmStorage Service Limits:',
        monthlyRate,
        allowances.lockupAmount,
        totalDeposit,
        pricePerTiBPerEpoch
      )
    } else {
      spinner.stop(`${pc.green('✓')} WarmStorage service permissions already sufficient`)

      // Display current permissions with capacity info
      const monthlyRate = currentAllowances.rateAllowance * TIME_CONSTANTS.EPOCHS_PER_MONTH
      displayServicePermissions(
        'Your Current WarmStorage Service Limits:',
        monthlyRate,
        currentAllowances.lockupAllowance,
        totalDeposit,
        pricePerTiBPerEpoch
      )
    }

    // Get final values
    let finalRateAllowance: bigint
    let finalLockupAllowance: bigint

    if (needsUpdate) {
      finalRateAllowance = allowances.ratePerEpoch
      finalLockupAllowance = allowances.lockupAmount
    } else {
      finalRateAllowance = currentAllowances.rateAllowance
      finalLockupAllowance = currentAllowances.lockupAllowance
    }

    // Final summary
    displayPaymentSummary(
      network,
      filBalance,
      isCalibnet,
      usdfcBalance,
      totalDeposit,
      finalRateAllowance,
      finalLockupAllowance,
      pricePerTiBPerEpoch
    )

    // Show deposit warning if needed
    displayDepositWarning(totalDeposit, status.currentAllowances.lockupUsed)

    // Clean up
    await provider.destroy()
  } catch (error) {
    spinner.stop() // Stop spinner without message
    console.error(pc.red('✗ Setup failed'))
    console.error(pc.red('Error:'), error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
