/** CLI option shape for `login`. */

export interface LoginOptions {
  network?: string | undefined
  rpcUrl?: string | undefined
  /** Comma-separated scope ids; defaults to createDataSet,addPieces. */
  scopes?: string | undefined
  /** Generate a new key even when a saved one exists. */
  fresh?: boolean | undefined
}
