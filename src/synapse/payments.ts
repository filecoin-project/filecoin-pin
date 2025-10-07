/**
 * Synapse SDK Payment Operations
 *
 * This module demonstrates comprehensive payment operations using the Synapse SDK,
 * providing patterns for interacting with the Filecoin Onchain Cloud payment
 * system (Filecoin Pay).
 *
 * Key concepts demonstrated:
 * - Native FIL balance checking for gas fees
 * - ERC20 token (USDFC) balance management
 * - Two-step deposit process (approve + deposit)
 * - Service approval configuration for storage operators
 * - Storage capacity calculations from pricing
 *
 * @module synapse/payments
 */
export type {
  PaymentCapacityCheck,
  PaymentStatus,
  ServiceApprovalStatus,
  StorageAllowances,
} from '../core/payments/index.js'

export {
  BUFFER_DENOMINATOR,
  BUFFER_NUMERATOR,
  calculateActualCapacity,
  calculateDepositCapacity,
  calculateRequiredAllowances,
  calculateStorageAllowances,
  calculateStorageFromUSDFC,
  calculateStorageRunway,
  checkAllowances,
  checkAndSetAllowances,
  checkFILBalance,
  checkUSDFCBalance,
  computeAdjustmentForExactDays,
  computeAdjustmentForExactDeposit,
  computeTopUpForDuration,
  depositUSDFC,
  getPaymentStatus,
  getStorageScale,
  STORAGE_SCALE_MAX,
  setMaxAllowances,
  setServiceApprovals,
  USDFC_DECIMALS,
  validatePaymentCapacity,
  withBuffer,
  withdrawUSDFC,
  withoutBuffer,
} from '../core/payments/index.js'
