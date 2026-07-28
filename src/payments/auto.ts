/**
 * Automatic payment setup flow
 *
 * This module provides an automated, non-interactive setup experience for
 * configuring payment approvals. It uses default values and command-line
 * options to complete the setup without user interaction.
 */

import pc from 'picocolors'
import { formatUnits, parseUnits } from 'viem'
import { CliFatal, isCliFatal } from '../common/cli-errors.js'
import { createVerifiedResolvedSourceClient, sourceAddressForPrivateKey } from '../core/payments/acquisition/execute.js'
import {
  ensureWalletReadyForFilecoinTransactions,
  reconcileReadyAcquisitionCheckpoint,
  recoverRemovedSourceAcquisition,
} from '../core/payments/acquisition/orchestrate.js'
import {
  fetchSquidCatalog,
  type ResolvedSourceToken,
  recoverySourceChainId,
  resolveCatalogSource,
  sourceTokenIdentity,
  verifyResolvedErc20Source,
} from '../core/payments/acquisition/source-catalog.js'
import {
  isSupportedSquidSlippage,
  MAX_SQUID_SLIPPAGE_PERCENT,
  MIN_SQUID_SLIPPAGE_PERCENT,
} from '../core/payments/acquisition/squid.js'
import {
  calculateDepositCapacity,
  checkAllowances,
  checkAndSetAllowances,
  checkFILBalance,
  checkUSDFCBalance,
  computeAutoSetupTargetBalance,
  depositUSDFC,
  getPaymentStatus,
  MIN_FIL_FOR_GAS,
  validateGasRequirement,
  validatePaymentRequirements,
} from '../core/payments/index.js'
import { calculateWalletShortfalls } from '../core/payments/wallet-funding.js'
import { DEFAULT_COPIES } from '../core/synapse/constants.js'
import { getClientAddress, initializeSynapse, mainnet } from '../core/synapse/index.js'
import { formatUSDFC } from '../core/utils/format.js'
import { getCLILogger, parseCLIAuth } from '../utils/cli-auth.js'
import { cancel, createSpinner, intro, outro } from '../utils/cli-helpers.js'
import { log } from '../utils/cli-logger.js'
import { displayAccountInfo, displayDepositWarning } from './setup.js'
import type { PaymentSetupOptions } from './types.js'

function shellQuote(value: string | number): string {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`
}

/** A safe-to-paste retry that never includes RPC endpoints or private keys. */
export function formatAutoSetupRetryCommand(
  options: PaymentSetupOptions,
  targetFilecoinPayBalance: bigint,
  resolvedSource?: ResolvedSourceToken
): string {
  const argumentsList = [
    'filecoin-pin',
    'payments',
    'setup',
    '--auto',
    '--deposit',
    formatUnits(targetFilecoinPayBalance, 18),
    '--from-chain',
    resolvedSource?.chain.cliName ?? options.fromChain ?? '<supported-chain>',
    '--from-token',
    resolvedSource?.native === true ? 'native' : (resolvedSource?.token ?? options.fromToken ?? '<source-token>'),
    '--max-source-amount',
    options.maxSourceAmount ?? '<maximum-source-amount>',
  ]
  if (options.network != null) argumentsList.push('--network', options.network)
  if (options.slippage != null) argumentsList.push('--slippage', String(options.slippage))
  return argumentsList.map(shellQuote).join(' ')
}

function formatAutoSetupDirectRetryCommand(options: PaymentSetupOptions, targetFilecoinPayBalance: bigint): string {
  const argumentsList = [
    'filecoin-pin',
    'payments',
    'setup',
    '--auto',
    '--deposit',
    formatUnits(targetFilecoinPayBalance, 18),
  ]
  if (options.network != null) argumentsList.push('--network', options.network)
  return argumentsList.map(shellQuote).join(' ')
}

function throwDisplayedFatal(message: string): never {
  log.line(pc.red(`Error: ${message}`))
  log.flush()
  throw new CliFatal(message)
}

function assertAcquisitionOwnerMatchesSynapse(address: string, privateKey: string | undefined): void {
  if (privateKey == null || privateKey === '') {
    throw new Error(
      'Token acquisition requires the wallet owner private key; session and view-only auth cannot approve source routes'
    )
  }
  const normalizedPrivateKey = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as `0x${string}`
  const sourceOwner = sourceAddressForPrivateKey(normalizedPrivateKey)
  if (sourceOwner.toLowerCase() !== address.toLowerCase()) {
    throw new Error('Acquisition private key must control the configured Filecoin wallet owner')
  }
}

function sourceOptionCount(options: PaymentSetupOptions): number {
  return [options.fromChain, options.fromToken, options.maxSourceAmount].filter((value) => value != null).length
}

function validateAcquisitionOptions(options: PaymentSetupOptions): boolean {
  const count = sourceOptionCount(options)
  if (count > 0 && count !== 3) {
    throwDisplayedFatal('Acquisition requires --from-chain, --from-token, and --max-source-amount together')
  }
  if (options.slippage != null && count !== 3) {
    throwDisplayedFatal('Acquisition requires --from-chain, --from-token, and --max-source-amount together')
  }
  if (options.slippage != null && !isSupportedSquidSlippage(options.slippage)) {
    throwDisplayedFatal(
      `Slippage must be between ${MIN_SQUID_SLIPPAGE_PERCENT} and ${MAX_SQUID_SLIPPAGE_PERCENT} percent.`
    )
  }
  if (count === 3) {
    // The token's decimals are catalog-verified only after a wallet shortfall
    // requires acquisition. Keep this preflight decimal-free: parsing with a
    // legacy scale here would reject a valid small 18-decimal native cap.
    const maximum = options.maxSourceAmount
    if (maximum == null || !/^\d+(?:\.\d+)?$/.test(maximum) || !/[1-9]/.test(maximum)) {
      throwDisplayedFatal('--max-source-amount must be greater than zero')
    }
    if (recoverySourceChainId(options.fromChain) == null) {
      throwDisplayedFatal(`Unsupported source chain: ${options.fromChain ?? '(missing)'}`)
    }
  }
  return count === 3
}

/** Resolve and verify a source only after the existing setup flow finds a wallet shortfall. */
async function resolveAutoSetupAcquisitionSource(options: PaymentSetupOptions): Promise<ResolvedSourceToken> {
  const catalog = await fetchSquidCatalog({ integratorId: process.env.SQUID_INTEGRATOR_ID })
  const resolved = resolveCatalogSource(catalog, options.fromChain, options.fromToken)
  const sourceClient = await createVerifiedResolvedSourceClient(resolved, options.sourceRpcUrl)
  return verifyResolvedErc20Source(sourceClient, resolved)
}

function sourceIdentityForDiagnostics(source: ResolvedSourceToken): string {
  return `${source.chain.cliName} (${source.chainId}), ${sourceTokenIdentity(source)}, ${source.decimals} decimals`
}

function walletShortfallMessage(filShortfall: bigint, usdfcShortfall: bigint): string {
  return `Wallet shortfalls: FIL ${formatUnits(filShortfall, 18)}, USDFC ${formatUSDFC(usdfcShortfall)}`
}

function isCredentialBearingUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.username !== '' || url.password !== '') return true
    return [...url.searchParams.keys()].some((key) =>
      /^(?:(?:access|api|x-api)[-_]?key|(?:access|api|auth|id|refresh)[-_]?token|auth(?:orization)?|credential|key|password|secret|signature|token)$/iu.test(
        key
      )
    )
  } catch {
    return false
  }
}

/** Acquisition errors can echo configured endpoints or a signing key through RPC client diagnostics. */
function sanitizeAcquisitionErrorMessage(message: string, options: PaymentSetupOptions): string {
  let sanitized = message
  const privateKey = options.privateKey
  const redactedValues = [
    options.sourceRpcUrl,
    options.rpcUrl,
    privateKey,
    ...(privateKey != null && privateKey !== '' && !privateKey.startsWith('0x') ? [`0x${privateKey}`] : []),
  ]
  for (const value of redactedValues) {
    if (value != null && value !== '') sanitized = sanitized.replaceAll(value, '[redacted secret]')
  }
  return sanitized.replace(/\b(?:https?|wss?):\/\/[^\s'"`<>]+/giu, (url) =>
    isCredentialBearingUrl(url) ? '[redacted credential-bearing URL]' : url
  )
}

function acquisitionRecoveryNote(): string {
  return 'Before retrying, supply SOURCE_RPC_URL and RPC_URL through the environment or CLI flags. Endpoint URLs are intentionally omitted from this command.'
}

/**
 * Run automatic payment setup with defaults
 *
 * @param options - Options from command line
 */
export async function runAutoSetup(options: PaymentSetupOptions): Promise<void> {
  intro(pc.bold('Filecoin Onchain Cloud Payment Setup'))
  log.message(pc.gray('Running in auto mode...'))

  // Parse an explicit --deposit override before the outer try below, throwing
  // CliFatal so the CLI wrapper exits without re-printing. When omitted, the
  // target balance is derived from live on-chain pricing after connecting (see
  // below).
  let targetFilecoinPayBalance: bigint | undefined
  if (options.deposit != null) {
    try {
      targetFilecoinPayBalance = parseUnits(options.deposit, 18)
    } catch {
      log.line(pc.red(`Error: Invalid deposit amount '${options.deposit}'`))
      log.flush()
      throw new CliFatal(`Invalid deposit amount '${options.deposit}'`)
    }
  }

  // SOURCE_RPC_URL may be ambient configuration. Only the complete, explicit
  // source selection activates acquisition; partial selections must fail before
  // we connect to a provider or send a Filecoin transaction.
  const acquisitionRequested = validateAcquisitionOptions(options)
  let acquisitionRetryCommand: string | undefined
  let directRetryCommand: string | undefined
  let acquisitionCompleted = false

  const spinner = createSpinner()
  spinner.start('Initializing connection...')

  try {
    // Parse and validate authentication
    const authConfig = parseCLIAuth(options)

    const logger = getCLILogger()
    const synapse = await initializeSynapse(authConfig, logger)
    const network = synapse.chain.name
    const address = getClientAddress(synapse)

    spinner.stop(`${pc.green('✓')} Connected to ${pc.bold(network)}`)

    // Check balances and on-chain payment state. Wallet funding is validated
    // later, once the transactions this run needs are known: an
    // already-configured account needs none, so it is never rejected for a
    // low-gas wallet or for holding all of its USDFC as deposits.
    spinner.start('Checking balances...')

    const filStatus = await checkFILBalance(synapse)
    const walletUsdfcBalance = await checkUSDFCBalance(synapse)
    const [status, accountSummary, allowanceCheck] = await Promise.all([
      getPaymentStatus(synapse),
      synapse.payments.accountSummary(),
      checkAllowances(synapse),
    ])

    spinner.stop(`${pc.green('✓')} Balance check complete`)

    // Display account and balance info using shared function
    displayAccountInfo(
      address,
      network,
      filStatus.balance,
      filStatus.isCalibnet,
      filStatus.hasSufficientGas,
      walletUsdfcBalance,
      status.filecoinPayBalance
    )

    // Get storage pricing for capacity calculation
    const storageInfo = await synapse.storage.getStorageInfo()
    const pricePerTiBPerEpoch = storageInfo.pricing.noCDN.perTiBPerEpoch

    // With no --deposit given, ask current on-chain pricing how much must be
    // available to set up DEFAULT_COPIES data sets (including the CDN lockup the
    // default FilCDN upload path needs), then deposit enough to cover it.
    if (targetFilecoinPayBalance == null) {
      const { targetBalance } = computeAutoSetupTargetBalance({
        filecoinPayBalance: status.filecoinPayBalance,
        availableFunds: accountSummary.availableFunds,
        copies: DEFAULT_COPIES,
        priceList: storageInfo.pricing.priceList,
      })
      targetFilecoinPayBalance = targetBalance
      log.line(
        pc.gray(
          `Using default deposit target ${formatUSDFC(targetFilecoinPayBalance)} USDFC ` +
            `(covers ${DEFAULT_COPIES} CDN data sets + 1 USDFC runway)`
        )
      )
      log.flush()
    }

    const resolvedTargetFilecoinPayBalance = targetFilecoinPayBalance
    if (acquisitionRequested) {
      acquisitionRetryCommand = formatAutoSetupRetryCommand(options, resolvedTargetFilecoinPayBalance)
      directRetryCommand = formatAutoSetupDirectRetryCommand(options, resolvedTargetFilecoinPayBalance)
    }

    // Track if any changes were made
    let actionsTaken = false
    let actualFilecoinPayTopUp = 0n

    const needsDeposit = status.filecoinPayBalance < resolvedTargetFilecoinPayBalance
    const needsAllowanceUpdate = allowanceCheck.needsUpdate
    const neededFilecoinPayTopUp = needsDeposit ? resolvedTargetFilecoinPayBalance - status.filecoinPayBalance : 0n
    const requiredFilReserve = needsDeposit || needsAllowanceUpdate ? MIN_FIL_FOR_GAS : 0n
    let currentWalletFilBalance = filStatus.balance
    let currentWalletUsdfcBalance = walletUsdfcBalance

    const shortfalls = calculateWalletShortfalls({
      requiredUsdfc: neededFilecoinPayTopUp,
      walletUsdfcBalance: currentWalletUsdfcBalance,
      requiredFilReserve,
      walletFilBalance: currentWalletFilBalance,
    })

    if (shortfalls.filShortfall > 0n || shortfalls.usdfcShortfall > 0n) {
      const retryCommand = formatAutoSetupRetryCommand(options, resolvedTargetFilecoinPayBalance)
      if (!acquisitionRequested) {
        const message = `${walletShortfallMessage(shortfalls.filShortfall, shortfalls.usdfcShortfall)}. Fund the Filecoin wallet directly, then retry.`
        log.line(pc.red(`✗ ${message}`))
        log.line(`Retry with source acquisition: ${retryCommand}`)
        log.flush()
        cancel('Please fund your wallet and try again')
        throw new CliFatal(message)
      }

      if (synapse.chain.id !== mainnet.id) {
        const message = `${walletShortfallMessage(shortfalls.filShortfall, shortfalls.usdfcShortfall)}. Token acquisition is available only on Filecoin mainnet; fund this wallet directly on ${network}.`
        log.line(pc.red(`✗ ${message}`))
        log.line(
          `Retry direct deposit: ${formatAutoSetupDirectRetryCommand(options, resolvedTargetFilecoinPayBalance)}`
        )
        log.flush()
        cancel('Please fund your wallet directly and try again')
        throw new CliFatal(message)
      }

      if ('readOnly' in authConfig && authConfig.readOnly === true) {
        throwDisplayedFatal('Token acquisition requires signing auth; --view-address is read-only')
      }
      if (options.sourceRpcUrl == null || options.sourceRpcUrl.trim() === '') {
        throwDisplayedFatal('Token acquisition requires --source-rpc-url or SOURCE_RPC_URL')
      }
      if (options.privateKey == null || options.privateKey.trim() === '') {
        throwDisplayedFatal('Token acquisition requires --private-key for source transactions')
      }
      assertAcquisitionOwnerMatchesSynapse(address, options.privateKey)
      const rereadWalletBalances = async () => {
        const freshStatus = await getPaymentStatus(synapse)
        return { fil: freshStatus.filBalance, usdfc: freshStatus.walletUsdfcBalance }
      }
      const removedSourceRecovery = await recoverRemovedSourceAcquisition({
        destinationOwner: address,
        destinationChainId: synapse.chain.id,
        privateKey: options.privateKey,
        sourceRpcUrl: options.sourceRpcUrl,
        fromChain: options.fromChain,
        fromToken: options.fromToken,
        provider: { integratorId: process.env.SQUID_INTEGRATOR_ID },
        rereadWalletBalances,
      })
      if (removedSourceRecovery == null) {
        const resolvedSource = await resolveAutoSetupAcquisitionSource(options)
        acquisitionRetryCommand = formatAutoSetupRetryCommand(options, resolvedTargetFilecoinPayBalance, resolvedSource)
        log.line(pc.gray(`Source: ${sourceIdentityForDiagnostics(resolvedSource)}`))
        log.flush()

        await ensureWalletReadyForFilecoinTransactions({
          destinationChainId: synapse.chain.id,
          walletUsdfcBalance: currentWalletUsdfcBalance,
          walletFilBalance: currentWalletFilBalance,
          requiredUsdfc: neededFilecoinPayTopUp,
          fromChain: options.fromChain,
          fromToken: options.fromToken,
          resolvedSource,
          maxSourceAmount: options.maxSourceAmount,
          sourceRpcUrl: options.sourceRpcUrl,
          slippage: options.slippage,
          privateKey: options.privateKey,
          provider: { integratorId: process.env.SQUID_INTEGRATOR_ID },
          rereadWalletBalances,
        })
      }
      // A successful source route has already funded the Filecoin wallet. Any
      // later failure must resume only the local Filecoin payment work, never
      // suggest another provider route that could acquire funds again.
      acquisitionCompleted = true
      const refreshedStatus = await getPaymentStatus(synapse)
      currentWalletFilBalance = refreshedStatus.filBalance
      currentWalletUsdfcBalance = refreshedStatus.walletUsdfcBalance
    } else if (acquisitionRequested) {
      const removedSourceRecovery = await recoverRemovedSourceAcquisition({
        destinationOwner: address,
        destinationChainId: synapse.chain.id,
        privateKey: options.privateKey,
        sourceRpcUrl: options.sourceRpcUrl,
        fromChain: options.fromChain,
        fromToken: options.fromToken,
        provider: { integratorId: process.env.SQUID_INTEGRATOR_ID },
        rereadWalletBalances: async () => {
          const freshStatus = await getPaymentStatus(synapse)
          return { fil: freshStatus.filBalance, usdfc: freshStatus.walletUsdfcBalance }
        },
        allowMissingCheckpoint: true,
      })
      if (removedSourceRecovery == null) {
        await reconcileReadyAcquisitionCheckpoint({
          destinationOwner: address,
          destinationChainId: synapse.chain.id,
          walletFilBalance: currentWalletFilBalance,
          walletUsdfcBalance: currentWalletUsdfcBalance,
          privateKey: options.privateKey,
          fromChain: options.fromChain,
          fromToken: options.fromToken,
        })
      }
    }

    // Preserve the existing validation and transaction behavior after the
    // funding layer has returned fresh destination balances.
    if (needsDeposit || needsAllowanceUpdate) {
      const validation = needsDeposit
        ? validatePaymentRequirements(currentWalletFilBalance, currentWalletUsdfcBalance, filStatus.isCalibnet)
        : validateGasRequirement(currentWalletFilBalance, filStatus.isCalibnet)
      if (!validation.isValid) {
        const errorMsg = validation.errorMessage ?? 'Payment validation failed'
        log.line(`${pc.red('✗')} ${errorMsg}`)
        if (validation.helpMessage) {
          log.line('')
          log.line(`  ${pc.cyan(validation.helpMessage)}`)
        }
        log.flush()
        cancel('Please fund your wallet and try again')
        throw new CliFatal(errorMsg)
      }
    }

    if (needsDeposit) {
      actualFilecoinPayTopUp = neededFilecoinPayTopUp

      if (neededFilecoinPayTopUp > currentWalletUsdfcBalance) {
        throw new Error(
          `Insufficient USDFC for deposit (need ${formatUSDFC(neededFilecoinPayTopUp)} USDFC, have ${formatUSDFC(currentWalletUsdfcBalance)} USDFC)`
        )
      }

      spinner.start(`Depositing ${formatUSDFC(neededFilecoinPayTopUp)} USDFC...`)
      const { depositTx } = await depositUSDFC(synapse, neededFilecoinPayTopUp)
      spinner.stop(`${pc.green('✓')} Deposited ${formatUSDFC(neededFilecoinPayTopUp)} USDFC`)
      actionsTaken = true

      log.line(pc.bold('Transaction details:'))
      log.indent(pc.gray(`Deposit: ${depositTx}`))
      log.flush()
    } else {
      // Use a dummy spinner to get consistent formatting
      spinner.start('Checking deposit...')
      const { updated, transactionHash } = await checkAndSetAllowances(synapse)
      if (updated) {
        spinner.stop(`${pc.green('✓')} Updated payment allowances, tx: ${transactionHash}`)
      } else {
        spinner.stop(`${pc.green('✓')} Deposit already sufficient (${formatUSDFC(status.filecoinPayBalance)} USDFC)`)
      }
    }

    // Calculate capacity for final summary
    const totalDeposit = status.filecoinPayBalance + actualFilecoinPayTopUp
    const capacity = calculateDepositCapacity(totalDeposit, pricePerTiBPerEpoch)

    // Final summary
    spinner.start('Completing setup...')
    spinner.stop('━━━ Configuration Summary ━━━')

    log.line(`Network: ${pc.bold(network)}`)
    log.line(`Deposit: ${formatUSDFC(totalDeposit)} USDFC`)

    if (capacity.gibPerMonth > 0) {
      const capacityStr =
        capacity.gibPerMonth >= 1024
          ? `${(capacity.gibPerMonth / 1024).toFixed(1)} TiB`
          : `${capacity.gibPerMonth.toFixed(1)} GiB`
      log.line(`Storage: ~${capacityStr} for 1 month`)
    }

    log.line(`Status: ${pc.green('Ready to upload')}`)
    log.flush()

    // Show deposit warning if needed
    displayDepositWarning(totalDeposit, status.currentAllowances.lockupUsage)

    // Show appropriate outro message based on whether actions were taken
    if (actionsTaken) {
      outro('Payment setup completed successfully')
    } else {
      outro('Payment setup already configured - ready to use')
    }
  } catch (error) {
    if (isCliFatal(error)) {
      spinner.stop()
      throw error
    }
    const msg = acquisitionRequested
      ? sanitizeAcquisitionErrorMessage(error instanceof Error ? error.message : String(error), options)
      : error instanceof Error
        ? error.message
        : String(error)
    spinner.stop(`${pc.red('✗')} Setup failed: ${msg}`)
    if (acquisitionRequested) {
      if (acquisitionCompleted && directRetryCommand != null) {
        log.line(`Retry direct deposit: ${directRetryCommand}`)
        log.flush()
      } else if (acquisitionRetryCommand != null) {
        log.line(`Retry source acquisition: ${acquisitionRetryCommand}`)
        log.line(pc.yellow(acquisitionRecoveryNote()))
        log.flush()
      }
    }
    cancel('Setup failed')
    // This error can be handed to callers or reporters. Do not retain the
    // original provider/RPC error after sanitizing an acquisition failure,
    // because Error.cause would otherwise bypass the displayed redaction.
    const cause = acquisitionRequested ? undefined : error instanceof Error ? error : undefined
    throw new CliFatal(msg, cause == null ? undefined : { cause })
  }
}
