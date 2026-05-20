import type { CLIAuthOptions } from '../utils/cli-auth.js'

export interface DataSetCommandOptions extends CLIAuthOptions {
  /**
   * Whether to wait for the transaction to be confirmed.
   */
  wait?: boolean
}

export interface DataSetListCommandOptions extends CLIAuthOptions {
  /**
   * If you want to filter the data sets by provider ID, you can pass it here.
   */
  providerId?: string | undefined
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
