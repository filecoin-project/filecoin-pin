/** A single explicitly selected asset that a later provider may acquire from. */
export interface FundingSource {
  chainId: number
  token: string
  symbol: string
  decimals?: number
  native?: boolean
}

/** The provider-independent action needed to make the Filecoin wallet ready. */
export type WalletFundingPath = 'ready' | 'acquire-fil' | 'acquire-usdfc' | 'acquire-both' | 'unsupported'

/** A single required destination asset. Wallet assets are never implicitly combined. */
export interface AcquisitionLeg {
  asset: 'fil' | 'usdfc'
  amount: bigint
  source?: FundingSource
}

/** Exact wallet readiness result. No provider transaction is represented here. */
export interface WalletFundingPlan {
  path: WalletFundingPath
  requiredUsdfc: bigint
  usdfcShortfall: bigint
  requiredFilReserve: bigint
  filShortfall: bigint
  source?: FundingSource
  legs: AcquisitionLeg[]
}

/** A provider's non-binding acquisition estimate. */
export interface AcquisitionQuote {
  id: string
  sourceAmount: bigint
  destinationAmount: bigint
  expiresAt?: number
}

/** An approved, executable provider route. This is intentionally internal. */
export interface PlannedAcquisitionQuote extends AcquisitionQuote {
  asset: AcquisitionLeg['asset']
  requestId?: string
  target: string
  data: string
  value: bigint
  gasLimit: bigint
  maxFeePerGas: bigint
  expiresAt: number
  /** Provider estimate used only to bound status polling; it never authorizes spend. */
  estimatedRouteDurationSeconds: number
  /** Exact source selected during planning, retained through refresh and recovery. */
  source?: { chainId: number; token: string; symbol: string; decimals: number; native: boolean }
  /** Route target and ERC-20 spender are independently trusted per source chain. */
  approvalSpender?: string
}

export interface AcquisitionEvidence {
  asset: AcquisitionLeg['asset']
  quoteId: string
  /** Fixed source-token input retained for recovery cap accounting. */
  sourceAmount?: string
  requestId?: string
  sourceTransactionHash?: string
  sourceTransactionUrl?: string
  destinationTransactionHash?: string
  destinationTransactionUrl?: string
  providerExplorerUrl?: string
  /** Retained so recovery keeps the original provider polling deadline. */
  estimatedRouteDurationSeconds?: number
  /** Provider failure classification retained for recovery and operator remediation. */
  errorCode?: AcquisitionErrorCode
  status: AcquisitionExecutionStatus
}

export type AcquisitionExecutionStatus = 'submitted' | 'confirmed' | 'failed' | 'partial' | 'refunded'

/** Provider execution state; providers own any transaction-specific details. */
export interface AcquisitionExecution {
  id: string
  status: AcquisitionExecutionStatus
  errorCode?: AcquisitionErrorCode
}

/** Errors that callers can handle without knowing a concrete provider. */
export type AcquisitionErrorCode =
  | 'unsupported-source'
  | 'insufficient-source-gas'
  | 'max-spend-exceeded'
  | 'quote-failed'
  | 'execution-failed'
  | 'timed-out'
  | 'partial-success'
  | 'refund-failed'
