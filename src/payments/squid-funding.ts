import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  type DestinationRequirement,
  executeSquidFunding,
  NATIVE_TOKEN_ADDRESS,
  planSquidFunding,
  type SourceToken,
  type SquidPublicClient,
  type SquidQuote,
  type SquidWalletClient,
} from '@filecoin-project/squid-evm-funding'
import type { Synapse } from '@filoz/synapse-sdk'
import { type Address, type Chain, createPublicClient, createWalletClient, getAddress, type Hex, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum, avalanche, base, bsc, mainnet as ethereum, filecoin, optimism, polygon } from 'viem/chains'
import { publicActionsL2 } from 'viem/op-stack'
import { CliIncomplete } from '../common/cli-errors.js'
import { createConfig } from '../config.js'
import { MIN_FIL_FOR_GAS } from '../core/payments/index.js'
import { mainnet as filecoinMainnet } from '../core/synapse/index.js'
import type { CLIAuthOptions } from '../utils/cli-auth.js'
import type { FundingSourceOptions } from './types.js'

const SQUID_ROUTER = getAddress('0xce16F69375520ab01377ce7B88f5BA8C48F8D666')
const FILECOIN_USDFC = filecoinMainnet.contracts.usdfc.address
const REQUEST_TIMEOUT_MS = 15_000
const SLIPPAGE_PERCENT = 1
const PRICE_DRIFT_HEADROOM_PERCENT = 1n

interface SourcePolicy {
  chain: Chain
  names: readonly string[]
  /** Maximum buffered native-fee commitments, not a guaranteed final debit. */
  maxNativeFee: bigint
  opStack?: boolean
}

const SOURCE_POLICIES: readonly SourcePolicy[] = [
  { chain: filecoin, names: ['filecoin', 'fil'], maxNativeFee: 30_000_000_000_000_000n },
  { chain: arbitrum, names: ['arbitrum', 'arb'], maxNativeFee: 3_000_000_000_000_000n },
  { chain: ethereum, names: ['ethereum', 'eth'], maxNativeFee: 30_000_000_000_000_000n },
  { chain: base, names: ['base'], maxNativeFee: 3_000_000_000_000_000n, opStack: true },
  { chain: optimism, names: ['optimism', 'op'], maxNativeFee: 3_000_000_000_000_000n, opStack: true },
  { chain: polygon, names: ['polygon', 'matic'], maxNativeFee: 10_000_000_000_000_000n },
  { chain: avalanche, names: ['avalanche', 'avax'], maxNativeFee: 10_000_000_000_000_000n },
  { chain: bsc, names: ['bnb', 'bsc', 'bnb-chain'], maxNativeFee: 5_000_000_000_000_000n },
]

interface PaymentAcquisitionSummary {
  source: SourceToken
  sourceChainName: string
  quotes: readonly SquidQuote[]
  maxSourceAmount: bigint
  maxNativeFee: bigint
  nativeCurrency: { symbol: string; decimals: number }
}

export interface AcquirePaymentShortfallsInput {
  synapse: Synapse
  owner: Address
  filShortfall: bigint
  usdfcShortfall: bigint
  /** Wallet USDFC reserved for the later Filecoin Pay deposit. */
  requiredWalletUsdfc: bigint
  options: FundingSourceOptions & Pick<CLIAuthOptions, 'privateKey' | 'walletAddress' | 'sessionKey' | 'viewAddress'>
  confirm: (summary: PaymentAcquisitionSummary) => Promise<void>
}

export function validateFundingSourceOptions(options: FundingSourceOptions): boolean {
  const requested = [options.fromChain, options.fromToken, options.maxSourceAmount, options.sourceRpcUrl].some(
    (value) => value != null && value.trim() !== ''
  )
  if (!requested) return false
  if (
    [options.fromChain, options.fromToken, options.maxSourceAmount, options.sourceRpcUrl].some(
      (value) => !value?.trim()
    )
  ) {
    throw new Error(
      'Source acquisition requires --from-chain, --from-token, --max-source-amount, and --source-rpc-url together'
    )
  }
  return true
}

function sourcePolicy(name: string | undefined): SourcePolicy {
  const normalized = name?.trim().toLowerCase()
  const policy = SOURCE_POLICIES.find((candidate) => candidate.names.includes(normalized ?? ''))
  if (policy == null) throw new Error(`Unsupported source chain: ${name ?? '(missing)'}`)
  return policy
}

function signingAccount(value: string | undefined, owner: Address) {
  if (value == null || value.trim() === '') throw new Error('Source acquisition requires owner private-key auth')
  const account = privateKeyToAccount((value.startsWith('0x') ? value : `0x${value}`) as Hex)
  if (account.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error('The source private key must control the Filecoin payment owner')
  }
  return account
}

function requirements(input: AcquirePaymentShortfallsInput, filFeeBuffer: bigint): DestinationRequirement[] {
  return [
    ...(input.filShortfall > 0n
      ? [
          {
            id: 'filecoin-fil',
            chainId: filecoinMainnet.id,
            token: NATIVE_TOKEN_ADDRESS,
            amount: input.filShortfall + filFeeBuffer,
            recipient: input.owner,
          },
        ]
      : []),
    ...(input.usdfcShortfall > 0n
      ? [
          {
            id: 'filecoin-usdfc',
            chainId: filecoinMainnet.id,
            token: FILECOIN_USDFC,
            amount: input.usdfcShortfall,
            recipient: input.owner,
          },
        ]
      : []),
  ]
}

function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const signal = init?.signal == null ? timeout : AbortSignal.any([init.signal, timeout])
  return fetch(input, { ...init, signal })
}

function safeMessage(error: unknown, secrets: readonly (string | undefined)[]): string {
  let message = error instanceof Error ? error.message : String(error)
  for (const secret of secrets) {
    if (secret != null && secret !== '') message = message.replaceAll(secret, '[redacted]')
  }
  return message.replace(/\b(?:https?|wss?):\/\/[^\s'"`<>]+/giu, '[redacted RPC URL]')
}

function markerPath(): string {
  return join(dirname(createConfig().databasePath), 'squid-funding.pending')
}

function pendingError(path: string): Error {
  return new Error(
    `A previous Squid funding attempt may still be pending. Verify the source and Filecoin transactions and balances, then delete ${path} before retrying.`
  )
}

function makeSourceClients(policy: SourcePolicy, rpcUrl: string, privateKey: string | undefined, owner: Address) {
  const account = signingAccount(privateKey, owner)
  const transport = http(rpcUrl, { timeout: REQUEST_TIMEOUT_MS })
  const baseClient = createPublicClient({ chain: policy.chain, transport })
  const publicClient = policy.opStack === true ? baseClient.extend(publicActionsL2()) : baseClient
  return {
    account,
    publicClient: publicClient as unknown as SquidPublicClient,
    walletClient: createWalletClient({ account, chain: policy.chain, transport }) as unknown as SquidWalletClient,
  }
}

/** Acquire only the positive FIL and USDFC shortfalls supplied by the existing payment planner. */
export async function acquirePaymentShortfalls(input: AcquirePaymentShortfallsInput): Promise<void> {
  if (input.filShortfall <= 0n && input.usdfcShortfall <= 0n) return
  validateFundingSourceOptions(input.options)
  if (input.synapse.chain.id !== filecoinMainnet.id) {
    throw new Error('Squid source acquisition is available only for Filecoin Mainnet')
  }
  if (input.options.walletAddress != null || input.options.sessionKey != null || input.options.viewAddress != null) {
    throw new Error('Squid source acquisition requires owner private-key auth')
  }

  const path = markerPath()
  const policy = sourcePolicy(input.options.fromChain)
  const filFeeBuffer = policy.chain.id === filecoinMainnet.id && input.filShortfall > 0n ? policy.maxNativeFee : 0n
  const destinationRequirements = requirements(input, filFeeBuffer)
  const sourceRpcUrl = input.options.sourceRpcUrl as string
  const integratorId = process.env.SQUID_INTEGRATOR_ID ?? ''
  if (integratorId.trim() === '') throw new Error('SQUID_INTEGRATOR_ID is required')
  const squid = { integratorId, fetch: fetchWithTimeout }

  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(
      path,
      JSON.stringify({
        owner: input.owner,
        sourceChain: policy.chain.id,
        sourceToken: input.options.fromToken,
        maxSourceAmount: input.options.maxSourceAmount,
        createdAt: new Date().toISOString(),
        targets: destinationRequirements.map((requirement) => ({
          token: requirement.token,
          amount: requirement.amount.toString(),
        })),
      }),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 }
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw pendingError(path)
    throw error
  }

  let executionStarted = false
  try {
    const clients = makeSourceClients(policy, sourceRpcUrl, input.options.privateKey, input.owner)
    const planned = await planSquidFunding(
      {
        owner: input.owner,
        sourceChainId: policy.chain.id,
        sourceToken: input.options.fromToken as string,
        requirements: destinationRequirements,
        maxSourceAmount: input.options.maxSourceAmount as string,
        slippage: SLIPPAGE_PERCENT,
      },
      squid
    )
    let availableHeadroom =
      planned.maxSourceAmount - planned.quotes.reduce((total, quote) => total + quote.sourceAmount, 0n)
    if (availableHeadroom < 0n) availableHeadroom = 0n
    const plan = {
      ...planned,
      quotes: planned.quotes.map((quote) => {
        let headroom = (quote.sourceAmount * PRICE_DRIFT_HEADROOM_PERCENT + 99n) / 100n
        if (headroom > availableHeadroom) headroom = availableHeadroom
        availableHeadroom -= headroom
        return { ...quote, sourceAmount: quote.sourceAmount + headroom }
      }),
    }
    let sourceBalanceFloor = 0n
    if (policy.chain.id === filecoinMainnet.id) {
      if (plan.source.token.toLowerCase() === FILECOIN_USDFC.toLowerCase()) {
        sourceBalanceFloor = input.requiredWalletUsdfc
      } else if (plan.source.token === NATIVE_TOKEN_ADDRESS) {
        sourceBalanceFloor = MIN_FIL_FOR_GAS
      }
    }
    const nativeBalanceFloor = policy.chain.id === filecoinMainnet.id && input.filShortfall <= 0n ? MIN_FIL_FOR_GAS : 0n

    await input.confirm({
      source: plan.source,
      sourceChainName: policy.chain.name,
      quotes: plan.quotes,
      maxSourceAmount: plan.maxSourceAmount,
      maxNativeFee: policy.maxNativeFee,
      nativeCurrency: policy.chain.nativeCurrency,
    })
    executionStarted = true
    await executeSquidFunding(
      {
        plan,
        maxNativeFee: policy.maxNativeFee,
        sourceBalanceFloor,
        nativeBalanceFloor,
        trustedTarget: SQUID_ROUTER,
        trustedSpender: SQUID_ROUTER,
        feeMode: policy.opStack === true ? 'op-stack' : 'standard',
        ...(policy.opStack === true ? { opStackFeeBuffer: (fee: bigint) => (fee * 5n + 3n) / 4n } : {}),
        maxPollAttempts: 120,
        pollIntervalMs: 5_000,
      },
      {
        publicClient: clients.publicClient,
        walletClient: clients.walletClient,
        destinationClient: input.synapse.client as unknown as SquidPublicClient,
        squid,
      }
    )
    await unlink(path)
  } catch (error) {
    if (!executionStarted) await unlink(path).catch(() => undefined)
    if (error instanceof CliIncomplete) throw error
    const privateKey = input.options.privateKey
    throw new Error(
      safeMessage(error, [
        sourceRpcUrl,
        privateKey?.startsWith('0x') ? undefined : `0x${privateKey}`,
        privateKey,
        integratorId,
      ])
    )
  }
}
