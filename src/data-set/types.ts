import type { CLIAuthOptions } from '../utils/cli-auth.js'

export interface DataSetCommandOptions extends CLIAuthOptions {
  /**
   * Whether to wait for the transaction to be confirmed.
   */
  wait?: boolean
}

// Provider filtering is driven by `providerId?: string[]` inherited from CLIAuthOptions
// (the repeatable `--provider-id` flag).
export interface DataSetListCommandOptions extends CLIAuthOptions {
  /**
   * We filter out data sets that were not created with filecoin-pin by default. If you want to see all data sets, you can pass true here.
   * @default false
   */
  all?: boolean | undefined
  /**
   * Optional metadata filters applied to datasets when listing.
   */
  dataSetMetadata?: Record<string, string>
}
