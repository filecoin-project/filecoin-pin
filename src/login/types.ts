/** CLI option shape for `login`. */

export interface LoginOptions {
  network?: string | undefined
  rpcUrl?: string | undefined
  /** Comma-separated scope ids; defaults to createDataSet,addPieces. */
  scopes?: string | undefined
  /** Generate a new key even when a saved one exists. */
  fresh?: boolean | undefined
  /** False (`--no-browser`) prints the link without opening it. */
  browser?: boolean | undefined
  /** False (`--no-wait`) exits right after printing the link instead of watching for the grant. */
  wait?: boolean | undefined
  /** Seconds to wait for the grant; defaults to five minutes. */
  timeout?: number | undefined
}
