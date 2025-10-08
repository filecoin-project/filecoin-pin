// Re-export payment types from the core module
export type { PaymentStatus, StorageAllowances } from '../core/payments/index.js'

export interface PaymentSetupOptions {
  auto: boolean
  privateKey?: string
  rpcUrl?: string
  deposit: string
  rateAllowance: string
}
