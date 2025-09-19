// Re-export payment types from the synapse module
export type { PaymentStatus, StorageAllowances } from '../synapse/payments.js'

export interface PaymentSetupOptions {
  auto: boolean
  privateKey?: string
  rpcUrl?: string
  deposit: string
  rateAllowance: string
}
