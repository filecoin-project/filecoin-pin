/**
 * payments fund command
 *
 * Adjusts funds to exactly match a target runway (days) or a target deposited amount.
 */

import { confirm, isCancel } from '@clack/prompts'
import type { Synapse } from '@filoz/synapse-sdk'
import pc from 'picocolors'
import { formatUnits, parseUnits } from 'viem'
import { CliFatal, CliIncomplete, isCliFatal, isCliIncomplete, setIncompleteExitCode } from '../common/cli-errors.js'
import { MIN_RUNWAY_DAYS } from '../common/constants.js'
import { resolveIpfsIndexedMetadata } from '../core/metadata/index.js'
import { createVerifiedResolvedSourceClient, sourceAddressForPrivateKey } from '../core/payments/acquisition/execute.js'
import {
  ensureWalletReadyForFilecoinTransactions,
  reconcileReadyAcquisitionCheckpoint,
} from '../core/payments/acquisition/orchestrate.js'
import {
  fetchSquidCatalog,
  type ResolvedSourceToken,
  resolveCatalogSource,
  sourceTokenIdentity,
  verifyResolvedErc20Source,
} from '../core/payments/acquisition/source-catalog.js'
import {
  isSupportedSquidSlippage,
  MAX_SQUID_SLIPPAGE_PERCENT,
  MIN_SQUID_SLIPPAGE_PERCENT,
} from '../core/payments/acquisition/squid.js'
import type { AcquisitionEvidence } from '../core/payments/acquisition/types.js'
import {
  checkUSDFCBalance,
  clampDepositToLimit,
  DEFAULT_LOCKUP_DAYS,
  depositUSDFC,
  executeFilecoinPayFunding,
  getPaymentStatus,
  MIN_FIL_FOR_GAS,
  planFilecoinPayFunding,
  toStorageRunwaySummary,
  withdrawUSDFC,
} from '../core/payments/index.js'
import { getClientAddress, initializeSynapse, mainnet } from '../core/synapse/index.js'
import { formatUSDFC } from '../core/utils/format.js'
import { formatRunwaySummary } from '../core/utils/index.js'
import { getCLILogger, parseCLIAuth } from '../utils/cli-auth.js'
import type { Spinner } from '../utils/cli-helpers.js'
import { cancel, createSpinner, intro, isInteractive, outro } from '../utils/cli-helpers.js'
import { isTTY, log } from '../utils/cli-logger.js'
import type { AutoFundOptions, FundingAdjustmentResult, FundOptions } from './types.js'

// Helper: confirm/warn or bail when target implies < lockup-days runway
async function ensureBelowThirtyDaysAllowed(opts: {
  spinner: Spinner
  warningLine1: string
  warningLine2: string
}): Promise<void> {
  const { spinner, warningLine1, warningLine2 } = opts
  if (!isInteractive()) {
    spinner.stop()
    log.line(pc.red(warningLine1))
    log.line(pc.red(warningLine2))
    log.flush()
    cancel('Fund adjustment aborted')
    throw new CliFatal(`Unsafe target below ${DEFAULT_LOCKUP_DAYS}-day baseline`)
  }

  log.line(pc.yellow('⚠ Warning'))
  log.indent(pc.yellow(warningLine1))
  log.indent(pc.yellow(warningLine2))
  log.flush()

  const proceed = await confirm({
    message: 'Proceed with reducing runway below 30 days?',
    initialValue: false,
  })
  if (isCancel(proceed) || !proceed) {
    throw new CliIncomplete('Fund adjustment cancelled by user')
  }
}

function shellQuote(value: string | number): string {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`
}

function acquisitionRecoveryCommand(
  options: FundOptions,
  hasDays: boolean,
  resolvedSource?: ResolvedSourceToken
): string {
  const argumentsList = [
    'filecoin-pin',
    'payments',
    'fund',
    hasDays ? '--days' : '--amount',
    hasDays ? String(options.days) : String(options.amount),
    '--from-chain',
    resolvedSource?.chain.cliName ?? String(options.fromChain),
    '--from-token',
    resolvedSource?.native === true ? 'native' : (resolvedSource?.token ?? String(options.fromToken)),
    '--max-source-amount',
    String(options.maxSourceAmount),
  ]
  // Endpoint values are credentials in practice and must never be echoed into terminal history or logs.
  if (options.network != null) argumentsList.push('--network', options.network)
  if (options.mode != null) argumentsList.push('--mode', options.mode)
  if (options.slippage != null) argumentsList.push('--slippage', String(options.slippage))
  return argumentsList.map(shellQuote).join(' ')
}

function acquisitionRecoveryNote(): string {
  return 'Before resuming, supply SOURCE_RPC_URL and RPC_URL through the environment or CLI flags. Endpoint URLs are intentionally omitted from this command.'
}

function sourceIdentityForDiagnostics(source: ResolvedSourceToken): string {
  return `${source.chain.cliName} (${source.chainId}), ${sourceTokenIdentity(source)}, ${source.decimals} decimals`
}

function directDepositRecoveryCommand(options: FundOptions, hasDays: boolean): string {
  const argumentsList = [
    'filecoin-pin',
    'payments',
    'fund',
    hasDays ? '--days' : '--amount',
    hasDays ? String(options.days) : String(options.amount),
  ]
  if (options.network != null) argumentsList.push('--network', options.network)
  if (options.mode != null) argumentsList.push('--mode', options.mode)
  return argumentsList.map(shellQuote).join(' ')
}

function directDepositRecoveryNote(): string {
  return 'Acquisition is confirmed: FIL and USDFC are already in the Filecoin wallet. Retry only the Filecoin Pay deposit; do not rerun source acquisition. Supply RPC_URL through the environment or CLI flag if needed.'
}

function directFundingRecoveryNote(): string {
  return 'Token acquisition is available only on Filecoin mainnet. Fund this wallet with FIL and USDFC directly, then retry only the Filecoin Pay deposit without --from-* acquisition flags. Supply RPC_URL through the environment or CLI flag if needed.'
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

/** RPC failures can include configured endpoints, credentials, or private keys in viem's message fields. */
function sanitizeRpcErrorMessage(message: string, options: FundOptions): string {
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

/** A source acquisition must fund the same EVM wallet that owns the Filecoin Pay account. */
function assertAcquisitionOwnerMatchesSynapse(synapse: Synapse, privateKey: string | undefined): void {
  if (privateKey == null || privateKey === '') return
  const normalizedPrivateKey = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as `0x${string}`
  const sourceOwner = sourceAddressForPrivateKey(normalizedPrivateKey)
  const filecoinOwner = getClientAddress(synapse)
  if (sourceOwner.toLowerCase() !== filecoinOwner.toLowerCase()) {
    throw new Error('Acquisition private key must control the configured Filecoin wallet owner')
  }
}

function acquisitionEvidenceLines(evidence: AcquisitionEvidence[]): string[] {
  return evidence.map((item) => {
    const fields = [
      `${item.asset.toUpperCase()} status ${item.status}`,
      `quote ${item.quoteId}`,
      ...(item.requestId != null ? [`request ${item.requestId}`] : []),
      ...(item.sourceTransactionHash != null ? [`source ${item.sourceTransactionHash}`] : []),
      ...(item.destinationTransactionHash != null ? [`destination ${item.destinationTransactionHash}`] : []),
      ...(item.providerExplorerUrl != null ? [`provider ${item.providerExplorerUrl}`] : []),
      ...(item.destinationTransactionUrl != null ? [`destination explorer ${item.destinationTransactionUrl}`] : []),
    ]
    return fields.join(' | ')
  })
}

function throwDisplayedFatal(message: string): never {
  log.line(pc.red(`Error: ${message}`))
  log.flush()
  throw new CliFatal(message)
}

/** Resolve and verify a source only after the Filecoin funding planner needs acquisition. */
async function resolveFundAcquisitionSource(options: FundOptions): Promise<ResolvedSourceToken> {
  const catalog = await fetchSquidCatalog({ integratorId: process.env.SQUID_INTEGRATOR_ID })
  const resolved = resolveCatalogSource(catalog, options.fromChain, options.fromToken)
  const sourceClient = await createVerifiedResolvedSourceClient(resolved, options.sourceRpcUrl)
  return verifyResolvedErc20Source(sourceClient, resolved)
}

// Helper: perform deposit or withdraw according to delta
async function performAdjustment(params: {
  synapse: Synapse
  spinner: Spinner
  delta: bigint
  depositMsg: string
  withdrawMsg: string
}): Promise<void> {
  const { synapse, spinner, delta, depositMsg, withdrawMsg } = params
  if (delta > 0n) {
    const needed = delta
    const usdfcWallet = await checkUSDFCBalance(synapse)
    if (needed > usdfcWallet) {
      throw new Error(
        `Insufficient USDFC in wallet (need ${formatUSDFC(needed)} USDFC, have ${formatUSDFC(usdfcWallet)} USDFC)`
      )
    }
    if (isTTY()) {
      // we will deposit `needed` USDFC, display confirmation to user unless not TTY or --auto flag was passed
      const proceed = await confirm({
        message: `Deposit ${formatUSDFC(needed)} USDFC?`,
        initialValue: false,
      })
      if (isCancel(proceed) || !proceed) {
        throw new CliIncomplete('Deposit cancelled by user')
      }
    }
    spinner.start(depositMsg)
    const { depositTx } = await depositUSDFC(synapse, needed)
    spinner.stop(`${pc.green('✓')} Deposit complete`)
    log.line(pc.bold('Transaction details:'))
    log.indent(pc.gray(`Deposit: ${depositTx}`))
    log.flush()
  } else if (delta < 0n) {
    const withdrawAmount = -delta
    if (isTTY()) {
      // we will withdraw `withdrawAmount` USDFC, display confirmation to user unless not TTY or --auto flag was passed
      const proceed = await confirm({
        message: `Withdraw ${formatUSDFC(withdrawAmount)} USDFC?`,
        initialValue: false,
      })
      if (isCancel(proceed) || !proceed) {
        throw new CliIncomplete('Withdraw cancelled by user')
      }
    }
    spinner.start(withdrawMsg)
    const txHash = await withdrawUSDFC(synapse, withdrawAmount)
    spinner.stop(`${pc.green('✓')} Withdraw complete`)
    log.line(pc.bold('Transaction'))
    log.indent(pc.gray(txHash))
    log.flush()
  }
}

// Helper: summary after adjustment
async function printSummary(synapse: Synapse, title = 'Updated'): Promise<void> {
  const summary = await synapse.payments.accountSummary({})
  const runway = toStorageRunwaySummary(summary)
  const runwayDisplay = formatRunwaySummary(runway)
  const lines = [`Deposited: ${formatUSDFC(summary.funds)} USDFC`]
  if (runway.state === 'active') {
    lines.push(`Storage covered: ~${runwayDisplay.coverage} total`)
    lines.push(`Top-up needed in: ~${runwayDisplay.runway}`)
  } else {
    lines.push(runwayDisplay.coverage)
  }
  log.section(title, lines)
}

/**
 * Automatically adjust funding to meet target runway or deposit amount.
 * This is a non-interactive version suitable for programmatic use.
 *
 * @param options - Auto-funding options
 * @returns Funding adjustment result
 * @throws Error if adjustment fails or target is unsafe
 */
export async function autoFund(options: AutoFundOptions): Promise<FundingAdjustmentResult> {
  const { synapse, fileSize, copies, providerIds, dataSetIds, metadata, spinner, maxBalance, withCDN } = options
  const targetRunwayDays = options.minRunwayDays ?? MIN_RUNWAY_DAYS

  spinner?.message('Checking wallet readiness...')

  const resolvedMetadata = resolveIpfsIndexedMetadata(metadata, dataSetIds)

  const contexts = await synapse.storage.createContexts({
    ...(copies != null ? { copies } : {}),
    ...(providerIds != null ? { providerIds } : {}),
    ...(dataSetIds != null ? { dataSetIds } : {}),
    metadata: resolvedMetadata,
  })
  const newDataSetCount = contexts.filter((context) => context.dataSetId == null).length

  const planResult = await planFilecoinPayFunding({
    synapse,
    targetRunwayDays,
    pieceSizeBytes: fileSize,
    newDataSetCount,
    withCDN: withCDN === true,
    ensureAllowances: true,
    allowWithdraw: false,
  })
  const { plan, status, allowances } = planResult

  spinner?.message(
    allowances.updated ? 'WarmStorage permissions configured' : 'WarmStorage permissions already configured'
  )
  spinner?.message('Calculating funding requirements...')

  // Auto-fund only deposits, never withdraws
  if (plan.delta <= 0n) {
    spinner?.message('No additional funding required')
    return {
      adjusted: false,
      delta: 0n,
      newDepositedAmount: plan.projected.depositedBalance,
      newRunwayDays: plan.projected.runway.runwayDays,
      newRunwayHours: plan.projected.runway.runwayHours,
    }
  }

  // Apply --max-balance ceiling (skip or clamp the planned deposit)
  const warnings: string[] = []
  const clamp = clampDepositToLimit(status.filecoinPayBalance, plan.delta, maxBalance)
  if (clamp.reason === 'already-at-limit') {
    if (clamp.message) warnings.push(clamp.message)
    return {
      adjusted: false,
      delta: 0n,
      newDepositedAmount: status.filecoinPayBalance,
      newRunwayDays: plan.current.runway.runwayDays,
      newRunwayHours: plan.current.runway.runwayHours,
      warnings,
    }
  }
  if (clamp.reason === 'clamped' && clamp.message != null) {
    warnings.push(clamp.message)
  }
  const adjustedPlan = clamp.deposit !== plan.delta ? { ...plan, delta: clamp.deposit } : plan

  if (status.walletUsdfcBalance < adjustedPlan.delta) {
    throw new Error(
      `Insufficient USDFC in wallet (need ${formatUSDFC(adjustedPlan.delta)} USDFC, have ${formatUSDFC(status.walletUsdfcBalance)} USDFC)`
    )
  }

  const depositMsg =
    clamp.reason === 'clamped'
      ? `Depositing ${formatUSDFC(adjustedPlan.delta)} USDFC toward ${targetRunwayDays} day(s) runway (limited by --max-balance)...`
      : `Depositing ${formatUSDFC(adjustedPlan.delta)} USDFC to ensure at least ${targetRunwayDays} day(s) runway...`
  spinner?.message(depositMsg)
  const execution = await executeFilecoinPayFunding(synapse, adjustedPlan)
  spinner?.message(`${pc.green('✓')} Deposit complete`)

  return {
    adjusted: execution.adjusted,
    delta: adjustedPlan.delta,
    transactionHash: execution.transactionHash,
    newDepositedAmount: execution.newDepositedAmount,
    newRunwayDays: execution.newRunwayDays,
    newRunwayHours: execution.newRunwayHours,
    warnings,
  }
}

export async function runFund(options: FundOptions): Promise<void> {
  intro(pc.bold('Filecoin Onchain Cloud Fund Adjustment'))
  const spinner = createSpinner()
  let acquisitionDiagnostics: string | undefined
  let acquisitionResumeCommand: string | undefined
  let acquisitionRecoveryKind: 'await-provider' | 'deposit-only' | 'direct-funding' | undefined

  // Validate inputs
  const hasDays = options.days != null
  const hasAmount = options.amount != null
  if ((hasDays && hasAmount) || (!hasDays && !hasAmount)) {
    log.line(pc.red('Error: Specify exactly one of --days <N> or --amount <USDFC>'))
    log.flush()
    throw new CliFatal('Specify exactly one of --days <N> or --amount <USDFC>')
  }
  if (options.mode != null && !['exact', 'minimum'].includes(options.mode)) {
    log.line(pc.red(`Error: Invalid mode (must be "exact" or "minimum"), received: '${options.mode}'`))
    log.flush()
    throw new CliFatal(`Invalid mode (must be "exact" or "minimum"), received: '${options.mode}'`)
  }
  const sourceOptionCount = [options.fromChain, options.fromToken, options.maxSourceAmount].filter(
    (value) => value != null
  ).length
  if (sourceOptionCount > 0 && sourceOptionCount !== 3) {
    throwDisplayedFatal('Acquisition requires --from-chain, --from-token, and --max-source-amount together')
  }
  if (options.slippage != null && sourceOptionCount !== 3) {
    throwDisplayedFatal('Acquisition requires --from-chain, --from-token, and --max-source-amount together')
  }
  if (options.slippage != null && !isSupportedSquidSlippage(options.slippage)) {
    throwDisplayedFatal(
      `Slippage must be between ${MIN_SQUID_SLIPPAGE_PERCENT} and ${MAX_SQUID_SLIPPAGE_PERCENT} percent.`
    )
  }
  spinner.start('Connecting...')
  try {
    // Parse and validate authentication
    const authConfig = parseCLIAuth(options)

    const logger = getCLILogger()
    const synapse = await initializeSynapse(authConfig, logger)

    spinner.stop(`${pc.green('✓')} Connected`)

    const targetDays: number = hasDays ? Number(options.days) : 0
    if (hasDays && (!Number.isFinite(targetDays) || targetDays < 0)) {
      throw new Error('--days must be a non-negative number')
    }

    let targetDeposit: bigint = 0n
    try {
      targetDeposit = options.amount != null ? parseUnits(String(options.amount), 18) : 0n
    } catch {
      throw new Error(`Invalid --amount '${options.amount}'`)
    }

    spinner.start('Calculating funding plan...')
    // SOURCE_RPC_URL can be ambient Commander configuration for a later acquisition.
    // It must not turn an ordinary Filecoin Pay deposit or withdrawal into one.
    const acquisitionRequested = sourceOptionCount === 3
    const planResult = await planFilecoinPayFunding({
      synapse,
      targetRunwayDays: hasDays ? targetDays : undefined,
      targetDeposit: hasAmount ? targetDeposit : undefined,
      mode: options.mode ?? 'exact',
      allowWithdraw: options.mode !== 'minimum',
      validateWalletReadiness: true,
      deferWalletReadinessForPositiveDelta: acquisitionRequested,
    })
    const { plan } = planResult
    spinner.stop(`${pc.green('✓')} Funding plan prepared`)

    if (plan.targetType === 'runway-days' && plan.current.runway.rateUsed === 0n) {
      log.line(`${pc.red('✗')} No active spend detected (rateUsed = 0). Cannot compute runway.`)
      log.line('Use --amount to set a target deposit instead.')
      log.flush()
      cancel('Fund adjustment aborted')
      throw new CliFatal('No active spend')
    }

    // Safety baseline measures projected top-up window (net runway after deposit),
    // sourced from the SDK so --days and --amount paths share one metric.
    const projectedRunwayDays = plan.projected.runway.state === 'active' ? plan.projected.runway.runwayDays : null

    if (plan.mode !== 'minimum' && projectedRunwayDays != null && projectedRunwayDays < DEFAULT_LOCKUP_DAYS) {
      const line1 = `Projected top-up window after this adjustment is less than ${DEFAULT_LOCKUP_DAYS} days.`
      const line2 = `WarmStorage reserves ${DEFAULT_LOCKUP_DAYS} days of costs; a shorter top-up window risks termination.`
      await ensureBelowThirtyDaysAllowed({
        spinner,
        warningLine1: line1,
        warningLine2: line2,
      })
    }

    const targetDepositLabel = formatUSDFC(plan.targetDeposit ?? targetDeposit)

    let alreadyMessage: string
    if (plan.targetType === 'runway-days') {
      const runwayLabel = plan.targetRunwayDays ?? 0
      alreadyMessage =
        plan.mode === 'minimum'
          ? `Already above minimum of ${runwayLabel} day(s) runway. No changes needed.`
          : `Already at target of ~${runwayLabel} day(s). No changes needed.`
    } else {
      alreadyMessage =
        plan.mode === 'minimum'
          ? `Already above minimum deposit of ${targetDepositLabel} USDFC. No changes needed.`
          : `Already at target deposit of ${targetDepositLabel} USDFC. No changes needed.`
    }

    let depositMsg: string
    let withdrawMsg: string
    if (plan.targetType === 'runway-days') {
      const runwayLabel = plan.targetRunwayDays ?? 0
      depositMsg = `Depositing ${formatUSDFC(plan.delta)} USDFC to reach ~${runwayLabel} day(s) runway...`
      withdrawMsg = `Withdrawing ${formatUSDFC(-plan.delta)} USDFC to reach ~${runwayLabel} day(s) runway...`
    } else {
      depositMsg = `Depositing ${formatUSDFC(plan.delta)} USDFC to reach ${targetDepositLabel} USDFC total...`
      withdrawMsg = `Withdrawing ${formatUSDFC(-plan.delta)} USDFC to reach ${targetDepositLabel} USDFC total...`
    }

    if (plan.mode === 'minimum' && plan.delta > 0n) {
      if (hasAmount) {
        depositMsg = `Depositing ${formatUSDFC(plan.delta)} USDFC to reach minimum of ${targetDepositLabel} USDFC total...`
      } else if (targetDays > 0) {
        depositMsg = `Depositing ${formatUSDFC(plan.delta)} USDFC to reach minimum of ${targetDays} day(s) runway...`
      }
    }

    if (plan.delta === 0n) {
      await printSummary(synapse, 'No Changes Needed')
      outro(alreadyMessage)
      return
    }

    if (plan.delta > 0n && acquisitionRequested) {
      const currentStatus = await getPaymentStatus(synapse)
      const filShortfall = currentStatus.filBalance < MIN_FIL_FOR_GAS ? MIN_FIL_FOR_GAS - currentStatus.filBalance : 0n
      const usdfcShortfall =
        currentStatus.walletUsdfcBalance < plan.delta ? plan.delta - currentStatus.walletUsdfcBalance : 0n
      if (filShortfall > 0n || usdfcShortfall > 0n) {
        if (synapse.chain.id !== mainnet.id) {
          acquisitionDiagnostics =
            'Direct wallet funding is required on this network: add FIL and USDFC, then retry the Filecoin Pay deposit without source acquisition.'
          acquisitionResumeCommand = directDepositRecoveryCommand(options, hasDays)
          acquisitionRecoveryKind = 'direct-funding'
          throw new Error(
            'Token acquisition is available only on Filecoin mainnet; use a direct USDFC deposit on this network'
          )
        }
        if (options.sourceRpcUrl == null || options.sourceRpcUrl.trim() === '') {
          throwDisplayedFatal('Token acquisition requires --source-rpc-url or SOURCE_RPC_URL')
        }
        if (options.privateKey == null || options.privateKey.trim() === '') {
          throwDisplayedFatal('Token acquisition requires --private-key for source transactions')
        }
        if ('readOnly' in authConfig && authConfig.readOnly === true) {
          throwDisplayedFatal('Token acquisition requires signing auth; --view-address is read-only')
        }
        assertAcquisitionOwnerMatchesSynapse(synapse, options.privateKey)
        acquisitionDiagnostics = `Remaining wallet shortfalls: FIL ${formatUnits(filShortfall, 18)}, USDFC ${formatUnits(usdfcShortfall, 18)}. Squid fallback: https://app.squidrouter.com/`
        acquisitionResumeCommand = acquisitionRecoveryCommand(options, hasDays)
        acquisitionRecoveryKind = 'await-provider'
        const resolvedSource = await resolveFundAcquisitionSource(options)
        acquisitionDiagnostics = `Source: ${sourceIdentityForDiagnostics(resolvedSource)}. Remaining wallet shortfalls: FIL ${formatUnits(filShortfall, 18)}, USDFC ${formatUnits(usdfcShortfall, 18)}. Squid fallback: https://app.squidrouter.com/`
        acquisitionResumeCommand = acquisitionRecoveryCommand(options, hasDays, resolvedSource)
        const completedAcquisition = await ensureWalletReadyForFilecoinTransactions({
          destinationChainId: synapse.chain.id,
          walletUsdfcBalance: currentStatus.walletUsdfcBalance,
          walletFilBalance: currentStatus.filBalance,
          requiredUsdfc: plan.delta,
          fromChain: options.fromChain,
          fromToken: options.fromToken,
          resolvedSource,
          maxSourceAmount: options.maxSourceAmount,
          sourceRpcUrl: options.sourceRpcUrl,
          slippage: options.slippage,
          privateKey: options.privateKey,
          provider: { integratorId: process.env.SQUID_INTEGRATOR_ID },
          confirmSourceAcquisition: isTTY()
            ? async (summary) => {
                if (summary.sourceAmount > summary.maxSourceAmount) {
                  throw new Error('Validated source route exceeds --max-source-amount before confirmation')
                }
                const routeLegs = summary.legs
                  .map(
                    (leg) =>
                      `${formatUnits(leg.minimumDestinationAmount, 18)} ${leg.asset.toUpperCase()} (expires ${new Date(leg.expiresAt * 1_000).toISOString()})`
                  )
                  .join(', ')
                const sourceIdentity = sourceTokenIdentity(resolvedSource)
                const nativeCommitment = formatUnits(
                  summary.nativeCommitment ?? 0n,
                  resolvedSource.chain.nativeDecimals
                )
                const nativeCeiling = formatUnits(summary.maxNativeGas ?? 0n, resolvedSource.chain.nativeDecimals)
                const proceed = await confirm({
                  message:
                    `Acquire ${formatUnits(summary.sourceAmount, resolvedSource.decimals)} ${sourceIdentity} ` +
                    `on ${resolvedSource.chain.cliName} (${resolvedSource.chainId}, ${resolvedSource.decimals} decimals; ` +
                    `cap ${formatUnits(summary.maxSourceAmount, resolvedSource.decimals)}; ` +
                    `quoted route-native commitment ${nativeCommitment}; ceiling ${nativeCeiling} ${resolvedSource.chain.nativeSymbol}) ` +
                    `for ${routeLegs} before depositing ${formatUSDFC(plan.delta)} USDFC?`,
                  initialValue: false,
                })
                if (isCancel(proceed) || !proceed) throw new CliIncomplete('Source acquisition cancelled by user')
              }
            : undefined,
          rereadWalletBalances: async () => {
            const status = await getPaymentStatus(synapse)
            return { fil: status.filBalance, usdfc: status.walletUsdfcBalance }
          },
        })
        const acquisitionEvidence = completedAcquisition ?? []
        if (acquisitionEvidence.length > 0) {
          log.section('Acquisition evidence', acquisitionEvidenceLines(acquisitionEvidence))
          acquisitionDiagnostics =
            'Acquisition is confirmed: FIL and USDFC are already in the Filecoin wallet. The Filecoin Pay deposit can be retried without another source acquisition.'
          acquisitionResumeCommand = directDepositRecoveryCommand(options, hasDays)
          acquisitionRecoveryKind = 'deposit-only'
        }
      } else {
        await reconcileReadyAcquisitionCheckpoint({
          destinationChainId: synapse.chain.id,
          walletFilBalance: currentStatus.filBalance,
          walletUsdfcBalance: currentStatus.walletUsdfcBalance,
          privateKey: options.privateKey,
        })
      }
    }

    if (plan.walletShortfall != null && plan.walletShortfall > 0n && !acquisitionRequested) {
      throw new Error(
        `Insufficient USDFC in wallet (need ${formatUSDFC(plan.delta)} USDFC, have ${formatUSDFC(planResult.status.walletUsdfcBalance)} USDFC)`
      )
    }

    await performAdjustment({
      synapse,
      spinner,
      delta: plan.delta,
      depositMsg,
      withdrawMsg,
    })

    await printSummary(synapse)
    outro('Fund adjustment completed')
  } catch (error) {
    if (isCliIncomplete(error)) {
      spinner.stop()
      cancel(error.message)
      setIncompleteExitCode()
      return
    }
    if (isCliFatal(error)) {
      spinner.stop()
      throw error
    }
    const message = sanitizeRpcErrorMessage(error instanceof Error ? error.message : String(error), options)
    const msg = acquisitionDiagnostics == null ? message : `${message}\n${acquisitionDiagnostics}`
    spinner.stop(`${pc.red('✗')} Fund adjustment failed: ${msg}`)
    if (acquisitionResumeCommand != null) {
      const resumePrefix =
        acquisitionRecoveryKind === 'direct-funding'
          ? 'After direct wallet funding, resume with'
          : 'After provider arrival or a deposit failure, resume with'
      const recoveryNote =
        acquisitionRecoveryKind === 'direct-funding'
          ? directFundingRecoveryNote()
          : acquisitionRecoveryKind === 'deposit-only'
            ? directDepositRecoveryNote()
            : acquisitionRecoveryNote()
      log.line(`${resumePrefix}: ${acquisitionResumeCommand}`)
      log.line(pc.yellow(recoveryNote))
      log.flush()
    }
    cancel('Fund adjustment failed')
    throw new CliFatal(msg)
  }
}
