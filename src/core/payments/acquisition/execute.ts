import {
  type Address,
  createPublicClient,
  createWalletClient,
  getAddress,
  type Hex,
  http,
  keccak256,
  type PublicClient,
  parseEther,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum } from 'viem/chains'
import type { AcquisitionCheckpoint, AcquisitionCheckpointStore } from './checkpoint.js'
import { ARBITRUM_USDC, getSourceWalletBalances, SQUID_ROUTER } from './source-assets.js'
import { waitForSquidTerminalStatus } from './squid.js'
import type { AcquisitionEvidence, AcquisitionExecutionStatus, PlannedAcquisitionQuote } from './types.js'

const ERC20_ALLOWANCE_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: 'amount', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

/** The #6 hard source-chain gas cap is enforced early even in the #4 CLI. */
export const MAX_SOURCE_NATIVE_GAS = parseEther('0.0001')

/** A route may only add its maximum native commitment inside the hard acquisition cap. */
export function isWithinCumulativeSourceGasCap(options: {
  committedNativeGas: bigint
  nextCommitment: bigint
  cap?: bigint
}): boolean {
  return options.committedNativeGas + options.nextCommitment <= (options.cap ?? MAX_SOURCE_NATIVE_GAS)
}

export function assertArbitrumSourceChain(chainId: number): void {
  if (chainId !== arbitrum.id) {
    throw new Error(`Source RPC chain id ${chainId} is not Arbitrum (${arbitrum.id})`)
  }
}

export function assertFixedInputRefresh(previous: PlannedAcquisitionQuote, refreshed: PlannedAcquisitionQuote): void {
  if (
    refreshed.sourceAmount !== previous.sourceAmount ||
    refreshed.destinationAmount < previous.destinationAmount ||
    refreshed.asset !== previous.asset
  ) {
    throw new Error('Squid route changed after refresh; rerun without submitting the route')
  }
  assertRouteNotExpired(refreshed)
}

function assertRouteNotExpired(quote: PlannedAcquisitionQuote): void {
  if (Math.floor(Date.now() / 1000) >= quote.expiresAt) {
    throw new Error('Acquisition route expired before submission; rerun')
  }
}

export interface ExecuteTokenAcquisitionOptions {
  privateKey: Hex
  sourceRpcUrl?: string | undefined
  /** Test seam; production always creates and verifies the explicit source RPC client. */
  sourceClient?: PublicClient | undefined
  /** Test seam; production always creates the wallet client from the supplied test-only source key. */
  walletClient?: AcquisitionWalletClient | undefined
  quotes: PlannedAcquisitionQuote[]
  /** Original operator source-token cap, retained across an interrupted multi-leg acquisition. */
  maxSourceAmount?: bigint
  /** Re-fetch after approval with the same fixed source input; it may never increase spend. */
  refreshQuote: (quote: PlannedAcquisitionQuote) => Promise<PlannedAcquisitionQuote>
  getProviderStatus: (evidence: AcquisitionEvidence) => Promise<{
    status: AcquisitionExecutionStatus
    sourceTransactionUrl?: string
    destinationTransactionHash?: string
    destinationTransactionUrl?: string
    providerExplorerUrl?: string
  }>
  checkpointStore: AcquisitionCheckpointStore
  destinationChainId: number
  /** Baseline Filecoin wallet balances used to prove destination arrivals. */
  getFilecoinBalances: () => Promise<{ fil: bigint; usdfc: bigint }>
  /** Re-read Filecoin balances after bridge execution. Never infer arrival from a source receipt. */
  waitForFilecoinArrival: (required: { fil: bigint; usdfc: bigint }) => Promise<void>
}

interface AcquisitionWalletClient {
  writeContract: (parameters: {
    address: Address
    abi: typeof ERC20_ALLOWANCE_ABI
    functionName: 'approve'
    args: readonly [Address, bigint]
    gas: bigint
    maxFeePerGas: bigint
    nonce: number
  }) => Promise<Hex>
  sendTransaction: (parameters: {
    to: Address
    data: Hex
    value: bigint
    gas: bigint
    maxFeePerGas: bigint
    nonce: number
  }) => Promise<Hex>
}

function addDestinationAmounts(
  baseline: { fil: bigint; usdfc: bigint },
  quotes: PlannedAcquisitionQuote[]
): { fil: bigint; usdfc: bigint } {
  return quotes.reduce(
    (required, quote) => ({
      fil: required.fil + (quote.asset === 'fil' ? quote.destinationAmount : 0n),
      usdfc: required.usdfc + (quote.asset === 'usdfc' ? quote.destinationAmount : 0n),
    }),
    baseline
  )
}

async function resumeCheckpoint(options: {
  checkpoint: AcquisitionCheckpoint
  checkpointStore: AcquisitionCheckpointStore
  owner: Address
  destinationChainId: number
  getProviderStatus: ExecuteTokenAcquisitionOptions['getProviderStatus']
  getFilecoinBalances: ExecuteTokenAcquisitionOptions['getFilecoinBalances']
  waitForSourceReceipt: (hash: Hex) => Promise<{ status: 'success' | 'reverted' }>
  waitForFilecoinArrival: ExecuteTokenAcquisitionOptions['waitForFilecoinArrival']
}): Promise<AcquisitionCheckpoint> {
  const { checkpoint } = options
  let recoveredCheckpoint = checkpoint
  if (checkpoint.committedNativeGas > MAX_SOURCE_NATIVE_GAS) {
    throw new Error(
      'Acquisition recovery state exceeds the approved source-native gas cap; do not submit another route'
    )
  }
  if (checkpoint.approvalIntent != null || checkpoint.routeIntent != null) {
    throw new Error(
      'Acquisition has a pre-broadcast intent without a transaction hash; inspect the recorded nonce before any rerun'
    )
  }
  if (
    checkpoint.owner.toLowerCase() !== options.owner.toLowerCase() ||
    checkpoint.sourceChainId !== arbitrum.id ||
    checkpoint.destinationChainId !== options.destinationChainId ||
    checkpoint.evidence.some((item) => item.sourceTransactionHash == null)
  ) {
    throw new Error(
      'Acquisition recovery state does not match this wallet or destination; do not submit another source route'
    )
  }
  const evidence = [...checkpoint.evidence]
  if (checkpoint.approvalTransactionHash != null) {
    const approvalReceipt = await options.waitForSourceReceipt(checkpoint.approvalTransactionHash as Hex)
    if (approvalReceipt.status !== 'success') {
      throw new Error('Source USDC approval transaction failed; do not submit another source route')
    }
    const { approvalTransactionHash: _approvalTransactionHash, ...confirmedCheckpoint } = checkpoint
    recoveredCheckpoint = { ...confirmedCheckpoint, evidence }
    await options.checkpointStore.save(recoveredCheckpoint)
  }
  const balances = await options.getFilecoinBalances()
  if (balances.fil >= recoveredCheckpoint.requiredWallet.fil && balances.usdfc >= recoveredCheckpoint.requiredWallet.usdfc) {
    const balanceProvenCheckpoint = {
      ...recoveredCheckpoint,
      evidence: evidence.map((current) => ({ ...current, status: 'confirmed' as const })),
    }
    await options.checkpointStore.save(balanceProvenCheckpoint)
    return balanceProvenCheckpoint
  }
  for (let index = 0; index < evidence.length; index += 1) {
    const current = evidence[index]
    if (current == null || current.sourceTransactionHash == null) continue
    const providerStatus = await waitForSquidTerminalStatus({
      getStatus: () => options.getProviderStatus(current),
      ...(current.estimatedRouteDurationSeconds != null
        ? { estimatedRouteDurationSeconds: current.estimatedRouteDurationSeconds }
        : {}),
    })
    if (providerStatus.status !== 'confirmed') {
      evidence[index] = { ...current, ...providerStatus, status: providerStatus.status }
      await options.checkpointStore.save({ ...recoveredCheckpoint, evidence })
      throw new Error(
        `Acquisition remains ${providerStatus.status}; do not resend the source transaction ${current.sourceTransactionHash}`
      )
    }
    evidence[index] = { ...current, ...providerStatus, status: 'confirmed' }
  }
  const resumedCheckpoint = { ...recoveredCheckpoint, evidence }
  await options.checkpointStore.save(resumedCheckpoint)
  await options.waitForFilecoinArrival(recoveredCheckpoint.requiredWallet)
  return resumedCheckpoint
}

function committedSourceAmount(evidence: AcquisitionEvidence[]): bigint {
  return evidence.reduce((total, item) => {
    if (item.sourceAmount == null || !/^\d+$/.test(item.sourceAmount)) {
      throw new Error('Acquisition recovery state lacks a valid consumed source amount; do not submit another route')
    }
    return total + BigInt(item.sourceAmount)
  }, 0n)
}

/**
 * An approval may be confirmed just before a process crashes, before any route
 * is submitted. Keep its durable gas commitment and continue with the route;
 * clearing this state would let a rerun evade the cumulative cap.
 */
async function resumeApprovalOnlyCheckpoint(options: {
  checkpoint: AcquisitionCheckpoint
  checkpointStore: AcquisitionCheckpointStore
  owner: Address
  destinationChainId: number
  waitForSourceReceipt: (hash: Hex) => Promise<{ status: 'success' | 'reverted' }>
}): Promise<AcquisitionCheckpoint> {
  const { checkpoint } = options
  if (checkpoint.committedNativeGas > MAX_SOURCE_NATIVE_GAS) {
    throw new Error(
      'Acquisition recovery state exceeds the approved source-native gas cap; do not submit another route'
    )
  }
  if (checkpoint.approvalIntent != null || checkpoint.routeIntent != null) {
    throw new Error(
      'Acquisition has a pre-broadcast intent without a transaction hash; inspect the recorded nonce before any rerun'
    )
  }
  if (
    checkpoint.owner.toLowerCase() !== options.owner.toLowerCase() ||
    checkpoint.sourceChainId !== arbitrum.id ||
    checkpoint.destinationChainId !== options.destinationChainId ||
    checkpoint.evidence.length !== 0
  ) {
    throw new Error(
      'Acquisition recovery state does not match an approval-only wallet recovery; do not submit another source route'
    )
  }
  if (checkpoint.approvalTransactionHash == null) return checkpoint
  const approvalReceipt = await options.waitForSourceReceipt(checkpoint.approvalTransactionHash as Hex)
  if (approvalReceipt.status !== 'success') {
    throw new Error('Source USDC approval transaction failed; do not submit another source route')
  }
  const { approvalTransactionHash: _approvalTransactionHash, ...confirmedCheckpoint } = checkpoint
  await options.checkpointStore.save(confirmedCheckpoint)
  return confirmedCheckpoint
}

/**
 * Submit the strictly validated, fixed-input source routes. This function is
 * deliberately not called for Calibration/devnet: those networks have no
 * approved acquisition route.
 */
export async function executeTokenAcquisition(options: ExecuteTokenAcquisitionOptions): Promise<AcquisitionEvidence[]> {
  const account = privateKeyToAccount(options.privateKey)
  const publicClient = options.sourceClient ?? (await createSourcePublicClient(options.sourceRpcUrl))
  if (options.sourceClient != null) assertArbitrumSourceChain(await publicClient.getChainId())
  const pending = await options.checkpointStore.load()
  let recoveredCheckpoint: AcquisitionCheckpoint | undefined
  if (pending != null) {
    if (pending.evidence.length > 0) {
      recoveredCheckpoint = await resumeCheckpoint({
        checkpoint: pending,
        checkpointStore: options.checkpointStore,
        owner: account.address,
        destinationChainId: options.destinationChainId,
        getProviderStatus: options.getProviderStatus,
        getFilecoinBalances: options.getFilecoinBalances,
        waitForSourceReceipt: (hash) => publicClient.waitForTransactionReceipt({ hash }),
        waitForFilecoinArrival: options.waitForFilecoinArrival,
      })
    } else if (pending.approvalIntent != null || pending.routeIntent != null) {
      throw new Error(
        'Acquisition has a pre-broadcast intent without a transaction hash; inspect the recorded nonce before any rerun'
      )
    } else {
      recoveredCheckpoint = await resumeApprovalOnlyCheckpoint({
        checkpoint: pending,
        checkpointStore: options.checkpointStore,
        owner: account.address,
        destinationChainId: options.destinationChainId,
        waitForSourceReceipt: (hash) => publicClient.waitForTransactionReceipt({ hash }),
      })
    }
  }
  const priorEvidence = recoveredCheckpoint?.evidence ?? []
  const completedAssets = new Set(priorEvidence.map((item) => item.asset))
  const quotes = options.quotes.filter((quote) => !completedAssets.has(quote.asset))
  const priorSourceAmount = priorEvidence.length > 0 ? committedSourceAmount(priorEvidence) : 0n
  const plannedSourceAmount = quotes.reduce((total, quote) => total + quote.sourceAmount, 0n)
  if (options.maxSourceAmount != null && priorSourceAmount + plannedSourceAmount > options.maxSourceAmount) {
    throw new Error('Acquisition exceeds the remaining --max-source-amount after confirmed source routes')
  }
  if (recoveredCheckpoint != null && quotes.length === 0) {
    await options.checkpointStore.clear()
    return priorEvidence
  }
  const walletClient: AcquisitionWalletClient =
    options.walletClient ??
    (() => {
      const client = createWalletClient({ account, chain: arbitrum, transport: http(options.sourceRpcUrl) })
      return {
        writeContract: (parameters) => client.writeContract(parameters),
        sendTransaction: (parameters) => client.sendTransaction(parameters),
      }
    })()
  const source = await getSourceWalletBalances(publicClient, account.address)
  const sourceAmount = plannedSourceAmount
  if (source.usdc < sourceAmount) throw new Error('Insufficient Arbitrum USDC for the planned acquisition')
  const gasPrice = await publicClient.getGasPrice()
  const firstQuote = quotes[0]
  const initialAllowance =
    firstQuote == null
      ? 0n
      : await publicClient.readContract({
          address: ARBITRUM_USDC,
          abi: ERC20_ALLOWANCE_ABI,
          functionName: 'allowance',
          args: [account.address, SQUID_ROUTER],
        })
  const approvalCommitments = await Promise.all(
    quotes.map(async (quote, index) => {
      // A Squid route consumes its allowance. Only the first pending route can reuse what is currently approved.
      if (index === 0 && initialAllowance === quote.sourceAmount) return 0n
      return (
        (await publicClient.estimateContractGas({
          account: account.address,
          address: ARBITRUM_USDC,
          abi: ERC20_ALLOWANCE_ABI,
          functionName: 'approve',
          args: [SQUID_ROUTER, quote.sourceAmount],
        })) * gasPrice
      )
    })
  )
  const approvalGas = approvalCommitments.reduce((total, commitment) => total + commitment, 0n)
  const routeGas = quotes.reduce((total, quote) => total + quote.value + quote.gasLimit * quote.maxFeePerGas, 0n)
  const requiredNativeGas = routeGas + approvalGas
  if (requiredNativeGas > MAX_SOURCE_NATIVE_GAS || source.native < requiredNativeGas) {
    throw new Error('Insufficient source native gas for the approved acquisition route')
  }

  const baseline = await options.getFilecoinBalances()
  let committedNativeGas = recoveredCheckpoint?.committedNativeGas ?? 0n
  const evidence: AcquisitionEvidence[] = [...priorEvidence]
  for (const [index, quote] of quotes.entries()) {
    const preApprovalQuote = await options.refreshQuote(quote)
    assertFixedInputRefresh(quote, preApprovalQuote)
    const allowance = await publicClient.readContract({
      address: ARBITRUM_USDC,
      abi: ERC20_ALLOWANCE_ABI,
      functionName: 'allowance',
      args: [account.address, SQUID_ROUTER],
    })
    const remainingCommitment = quotes
      .slice(index + 1)
      .reduce(
        (total, remainingQuote, remainingIndex) =>
          total +
          remainingQuote.value +
          remainingQuote.gasLimit * remainingQuote.maxFeePerGas +
          (approvalCommitments[index + remainingIndex + 1] ?? 0n),
        0n
      )
    let approval: { gasLimit: bigint; maxFeePerGas: bigint; nonce: number; commitment: bigint } | undefined
    if (allowance !== preApprovalQuote.sourceAmount) {
      const [gasLimit, maxFeePerGas, nonce] = await Promise.all([
        publicClient.estimateContractGas({
          account: account.address,
          address: ARBITRUM_USDC,
          abi: ERC20_ALLOWANCE_ABI,
          functionName: 'approve',
          args: [SQUID_ROUTER, preApprovalQuote.sourceAmount],
        }),
        publicClient.getGasPrice(),
        publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }),
      ])
      approval = { gasLimit, maxFeePerGas, nonce, commitment: gasLimit * maxFeePerGas }
    }
    const preApprovalRouteCommitment =
      preApprovalQuote.value + preApprovalQuote.gasLimit * preApprovalQuote.maxFeePerGas
    const nativeBeforeSignature = await publicClient.getBalance({ address: account.address })
    const reservedBeforeSignature = (approval?.commitment ?? 0n) + preApprovalRouteCommitment + remainingCommitment
    if (
      !isWithinCumulativeSourceGasCap({
        committedNativeGas,
        nextCommitment: reservedBeforeSignature,
      }) ||
      nativeBeforeSignature < reservedBeforeSignature
    ) {
      throw new Error(
        'Refreshed acquisition route exceeds the approved source-native gas cap or current native balance'
      )
    }
    if (approval != null) {
      const {
        gasLimit: approvalGasLimit,
        maxFeePerGas: approvalMaxFeePerGas,
        nonce: approvalNonce,
        commitment: approvalCommitment,
      } = approval
      if (!isWithinCumulativeSourceGasCap({ committedNativeGas, nextCommitment: approvalCommitment })) {
        throw new Error('Approval exceeds the approved source-native gas cap or current native balance')
      }
      committedNativeGas += approvalCommitment
      await options.checkpointStore.save({
        version: 1,
        owner: account.address,
        sourceChainId: arbitrum.id,
        destinationChainId: options.destinationChainId,
        committedNativeGas,
        approvalIntent: {
          nonce: approvalNonce,
          token: ARBITRUM_USDC,
          spender: SQUID_ROUTER,
          amount: preApprovalQuote.sourceAmount.toString(),
          gasLimit: approvalGasLimit.toString(),
          maxFeePerGas: approvalMaxFeePerGas.toString(),
        },
        requiredWallet: addDestinationAmounts(baseline, quotes.slice(0, evidence.length - priorEvidence.length)),
        evidence,
      })
      const approvalHash = await walletClient.writeContract({
        address: ARBITRUM_USDC,
        abi: ERC20_ALLOWANCE_ABI,
        functionName: 'approve',
        args: [SQUID_ROUTER, preApprovalQuote.sourceAmount],
        gas: approvalGasLimit,
        maxFeePerGas: approvalMaxFeePerGas,
        nonce: approvalNonce,
      })
      await options.checkpointStore.save({
        version: 1,
        owner: account.address,
        sourceChainId: arbitrum.id,
        destinationChainId: options.destinationChainId,
        committedNativeGas,
        approvalTransactionHash: approvalHash,
        requiredWallet: addDestinationAmounts(baseline, quotes.slice(0, evidence.length - priorEvidence.length)),
        evidence,
      })
      const approvalReceipt = await publicClient.waitForTransactionReceipt({ hash: approvalHash })
      if (approvalReceipt.status !== 'success') throw new Error('Source USDC approval transaction failed')
      await options.checkpointStore.save({
        version: 1,
        owner: account.address,
        sourceChainId: arbitrum.id,
        destinationChainId: options.destinationChainId,
        committedNativeGas,
        requiredWallet: addDestinationAmounts(baseline, quotes.slice(0, evidence.length - priorEvidence.length)),
        evidence,
      })
    }
    const refreshedQuote = await options.refreshQuote(preApprovalQuote)
    assertFixedInputRefresh(preApprovalQuote, refreshedQuote)
    const remainingNative = await publicClient.getBalance({ address: account.address })
    const pendingAllowance = await publicClient.readContract({
      address: ARBITRUM_USDC,
      abi: ERC20_ALLOWANCE_ABI,
      functionName: 'allowance',
      args: [account.address, SQUID_ROUTER],
    })
    if (pendingAllowance !== refreshedQuote.sourceAmount) {
      throw new Error('USDC allowance changed after approval; do not submit the source route')
    }
    const routeCommitment = refreshedQuote.value + refreshedQuote.gasLimit * refreshedQuote.maxFeePerGas
    const reservedRouteCommitment = routeCommitment + remainingCommitment
    if (
      !isWithinCumulativeSourceGasCap({
        committedNativeGas,
        nextCommitment: reservedRouteCommitment,
      }) ||
      remainingNative < reservedRouteCommitment
    ) {
      throw new Error(
        'Refreshed acquisition route exceeds the approved source-native gas cap or current native balance'
      )
    }
    committedNativeGas += routeCommitment
    const routeNonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' })
    await options.checkpointStore.save({
      version: 1,
      owner: account.address,
      sourceChainId: arbitrum.id,
      destinationChainId: options.destinationChainId,
      committedNativeGas,
      routeIntent: {
        nonce: routeNonce,
        quoteId: refreshedQuote.id,
        asset: refreshedQuote.asset,
        sourceAmount: refreshedQuote.sourceAmount.toString(),
        target: getAddress(refreshedQuote.target),
        dataHash: keccak256(refreshedQuote.data as Hex),
        value: refreshedQuote.value.toString(),
        gasLimit: refreshedQuote.gasLimit.toString(),
        maxFeePerGas: refreshedQuote.maxFeePerGas.toString(),
      },
      requiredWallet: addDestinationAmounts(baseline, quotes.slice(0, evidence.length - priorEvidence.length)),
      evidence,
    })
    assertRouteNotExpired(refreshedQuote)
    const sourceTransactionHash = await walletClient.sendTransaction({
      to: getAddress(refreshedQuote.target),
      data: refreshedQuote.data as Hex,
      value: refreshedQuote.value,
      gas: refreshedQuote.gasLimit,
      maxFeePerGas: refreshedQuote.maxFeePerGas,
      nonce: routeNonce,
    })
    evidence.push({
      asset: refreshedQuote.asset,
      quoteId: refreshedQuote.id,
      sourceAmount: refreshedQuote.sourceAmount.toString(),
      ...(refreshedQuote.requestId != null ? { requestId: refreshedQuote.requestId } : {}),
      sourceTransactionHash,
      estimatedRouteDurationSeconds: refreshedQuote.estimatedRouteDurationSeconds,
      status: 'submitted',
    })
    await options.checkpointStore.save({
      version: 1,
      owner: account.address,
      sourceChainId: arbitrum.id,
      destinationChainId: options.destinationChainId,
      committedNativeGas,
      requiredWallet: addDestinationAmounts(baseline, quotes.slice(0, evidence.length - priorEvidence.length)),
      evidence,
    })
    const sourceReceipt = await publicClient.waitForTransactionReceipt({ hash: sourceTransactionHash })
    if (sourceReceipt.status !== 'success') {
      const latestEvidence = evidence[evidence.length - 1]
      if (latestEvidence == null) throw new Error('Acquisition evidence was not recorded')
      evidence[evidence.length - 1] = { ...latestEvidence, status: 'failed' }
      await options.checkpointStore.save({
        version: 1,
        owner: account.address,
        sourceChainId: arbitrum.id,
        destinationChainId: options.destinationChainId,
        committedNativeGas,
        requiredWallet: addDestinationAmounts(baseline, quotes.slice(0, evidence.length - priorEvidence.length)),
        evidence,
      })
      throw new Error('Source acquisition transaction failed')
    }
    const latestEvidence = evidence[evidence.length - 1]
    if (latestEvidence == null) throw new Error('Acquisition evidence was not recorded')
    const providerStatus = await waitForSquidTerminalStatus({
      getStatus: () => options.getProviderStatus(evidence[evidence.length - 1] as AcquisitionEvidence),
      estimatedRouteDurationSeconds: refreshedQuote.estimatedRouteDurationSeconds,
    })
    if (providerStatus.status !== 'confirmed') {
      evidence[evidence.length - 1] = { ...latestEvidence, ...providerStatus, status: providerStatus.status }
      await options.checkpointStore.save({
        version: 1,
        owner: account.address,
        sourceChainId: arbitrum.id,
        destinationChainId: options.destinationChainId,
        committedNativeGas,
        requiredWallet: addDestinationAmounts(baseline, quotes.slice(0, evidence.length - priorEvidence.length)),
        evidence,
      })
      throw new Error(
        `Acquisition remains ${providerStatus.status}; do not resend the source transaction ${sourceTransactionHash}`
      )
    }
    evidence[evidence.length - 1] = { ...latestEvidence, ...providerStatus, status: 'confirmed' }
    await options.checkpointStore.save({
      version: 1,
      owner: account.address,
      sourceChainId: arbitrum.id,
      destinationChainId: options.destinationChainId,
      committedNativeGas,
      requiredWallet: addDestinationAmounts(baseline, quotes.slice(0, evidence.length - priorEvidence.length)),
      evidence,
    })
  }
  await options.waitForFilecoinArrival(addDestinationAmounts(baseline, quotes))
  await options.checkpointStore.clear()
  return evidence
}

/** Poll Filecoin balances with a fixed bound; a source receipt alone is not arrival proof. */
export async function waitForFilecoinWalletReadiness(options: {
  required: { fil: bigint; usdfc: bigint }
  getBalances: () => Promise<{ fil: bigint; usdfc: bigint }>
  attempts?: number
  wait?: (milliseconds: number) => Promise<void>
}): Promise<void> {
  const attempts = options.attempts ?? 3
  const wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const balances = await options.getBalances()
    if (balances.fil >= options.required.fil && balances.usdfc >= options.required.usdfc) return
    if (attempt + 1 < attempts) await wait(5_000)
  }
  throw new Error(
    'Provider confirmed acquisition, but Filecoin assets have not arrived; do not resend the source transaction'
  )
}

async function createSourcePublicClient(sourceRpcUrl: string | undefined): Promise<PublicClient> {
  if (sourceRpcUrl == null || sourceRpcUrl.trim() === '') {
    throw new Error('Acquisition requires --source-rpc-url or SOURCE_RPC_URL')
  }
  const client = createPublicClient({ chain: arbitrum, transport: http(sourceRpcUrl) })
  assertArbitrumSourceChain(await client.getChainId())
  return client
}

export function sourceAddressForPrivateKey(privateKey: Hex): Address {
  return privateKeyToAccount(privateKey).address
}
