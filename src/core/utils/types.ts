export type AnyProgressEvent = { type: string; data?: unknown }

export type ProgressEvent<T extends string = string, D = undefined> = D extends undefined
  ? { type: T }
  : { type: T; data: D }

export type ProgressEventHandler<E extends AnyProgressEvent = AnyProgressEvent> = (event: E) => void

export interface Warning {
  /** Machine-readable warning code (e.g., 'METADATA_FETCH_FAILED') */
  code: string
  /** Human-readable warning message */
  message: string
  /** Additional context data (e.g., { pieceId: 123, dataSetId: 456 }) */
  context?: Record<string, unknown>
}
