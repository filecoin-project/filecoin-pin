/**
 * Validation utility for core financial calculations.
 * Keeps pricing inputs non-zero and positive.
 *
 * @param pricePerTiBPerEpoch - Current pricing from storage service
 */

export function assertPriceNonZero(pricePerTiBPerEpoch: bigint): void {
  if (pricePerTiBPerEpoch <= 0n) {
    throw new Error('Invalid pricePerTiBPerEpoch: must be positive non-zero value')
  }
}
