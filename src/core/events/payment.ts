import type { PaymentCapacityCheck } from '../../synapse/payments.js'

/**
 * Baseline validation: emitted before checking FIL/USDFC requirements.
 */
export interface PaymentsValidationStartEvent {
  type: 'payments:validation:start'
}

/**
 * Baseline validation completed successfully.
 */
export interface PaymentsValidationSuccessEvent {
  type: 'payments:validation:success'
}

/**
 * Baseline validation failed. Carries user-facing messaging.
 */
export interface PaymentsValidationFailedEvent {
  type: 'payments:validation:failed'
  errorMessage: string
  helpMessage?: string
}

/**
 * Allowances workflow started.
 */
export interface PaymentsAllowancesStartEvent {
  type: 'payments:allowances:start'
  stage: 'checking'
}

/**
 * Allowances workflow progress. Stage indicates the ongoing step.
 */
export interface PaymentsAllowancesProgressEvent {
  type: 'payments:allowances:progress'
  stage: 'updating'
  transactionHash?: string
}

/**
 * Allowances workflow completed successfully.
 */
export interface PaymentsAllowancesSuccessEvent {
  type: 'payments:allowances:success'
  status: 'updated' | 'manual-required'
  transactionHash?: string
  reason?: string
}

/**
 * Allowances workflow failed due to an unexpected error.
 */
export interface PaymentsAllowancesFailedEvent {
  type: 'payments:allowances:failed'
  error: string
}

/**
 * Capacity evaluation started.
 */
export interface PaymentsCapacityStartEvent {
  type: 'payments:capacity:start'
}

/**
 * Capacity evaluation completed. Status communicates the outcome.
 */
export interface PaymentsCapacitySuccessEvent {
  type: 'payments:capacity:success'
  status: 'sufficient' | 'warning' | 'insufficient'
  availableDeposit?: bigint
  requiredDeposit?: bigint
  suggestions: string[]
  issues: PaymentCapacityCheck['issues']
}

/**
 * Capacity evaluation failed due to an unexpected error.
 */
export interface PaymentsCapacityFailedEvent {
  type: 'payments:capacity:failed'
  error: string
}

export type PaymentEvent =
  | PaymentsValidationStartEvent
  | PaymentsValidationSuccessEvent
  | PaymentsValidationFailedEvent
  | PaymentsAllowancesStartEvent
  | PaymentsAllowancesProgressEvent
  | PaymentsAllowancesSuccessEvent
  | PaymentsAllowancesFailedEvent
  | PaymentsCapacityStartEvent
  | PaymentsCapacitySuccessEvent
  | PaymentsCapacityFailedEvent
