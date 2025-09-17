export interface PaymentSetupOptions {
  auto: boolean
  privateKey?: string
  rpcUrl?: string
  deposit: string
  rateAllowance: string
}

export interface PaymentStatus {
  network: 'mainnet' | 'calibration'
  address: string
  filBalance: bigint
  usdfcBalance: bigint
  depositedAmount: bigint
  currentAllowances: {
    rateAllowance: bigint
    lockupAllowance: bigint
    rateUsed: bigint
    lockupUsed: bigint
  }
}

export interface StorageAllowances {
  ratePerEpoch: bigint
  lockupAmount: bigint
  tibPerMonth: number
}
