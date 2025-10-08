// Re-export payment types from the synapse module
export type { PaymentStatus, StorageAllowances } from '../synapse/payments.js'

export interface PaymentSetupOptions {
  auto: boolean
  privateKey?: string
  rpcUrl?: string
  deposit: string
  rateAllowance: string
}

export type FundMode = 'exact' | 'minimum'

export interface FundOptions {
  privateKey?: string
  rpcUrl?: string
  days?: number
  amount?: string
  /**
   * Mode to use for funding (default: exact)
   *
   *
   * exact: Adjust funds to exactly match a target runway (days) or a target deposited amount.
   * minimum: Adjust funds to match a minimum runway (days) or a minimum deposited amount.
   */
  mode?: FundMode
}
