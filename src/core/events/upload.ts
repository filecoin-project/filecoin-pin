import type { PaymentEvent } from './payment.js'

/**
 * Upload workflow initiated.
 */
export interface UploadStartEvent {
  type: 'upload:start'
  contextId?: string
  filePath?: string
}

/**
 * Upload progress update. Stage provides finer-grained milestones.
 */
export interface UploadProgressEvent {
  type: 'upload:progress'
  contextId?: string
  stage: 'piece-added' | 'piece-confirmed'
  index?: number
  total?: number
  transactionHash?: string
  pieceIds?: Array<string | number>
}

/**
 * Upload completed successfully.
 */
export interface UploadSuccessEvent {
  type: 'upload:success'
  contextId?: string
  pieceCid: string
  pieceId?: number
  dataSetId: string
  network: string
  downloadURL?: string
}

/**
 * Upload failed.
 */
export interface UploadFailedEvent {
  type: 'upload:failed'
  contextId?: string
  error: unknown
}

export type UploadEvent = UploadStartEvent | UploadProgressEvent | UploadSuccessEvent | UploadFailedEvent

export type CoreEvent = PaymentEvent | UploadEvent
