import type { AcquisitionExecution, AcquisitionLeg, AcquisitionQuote, WalletFundingPlan } from './types.js'

/**
 * Narrow internal boundary for optional wallet-acquisition adapters.
 * Implementations are responsible for quotes, transactions, and fallbacks.
 */
export interface AcquisitionProvider {
  quote(input: { plan: WalletFundingPlan; leg?: AcquisitionLeg; maxSpend?: bigint }): Promise<AcquisitionQuote>
  execute(input: { quote: AcquisitionQuote; maxSpend?: bigint }): Promise<AcquisitionExecution>
  getStatus(input: { executionId: string }): Promise<AcquisitionExecution>
  buildFallbackUrl(input: { plan: WalletFundingPlan; leg?: AcquisitionLeg }): string | undefined
}
