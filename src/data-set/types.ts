import type { CLIAuthOptions } from '../utils/cli-auth.js'

export interface DataSetCommandOptions extends CLIAuthOptions {}

export interface DataSetListCommandOptions extends CLIAuthOptions {
  /**
   * If you want to filter the data sets by provider ID, you can pass it here.
   */
  providerId?: string | undefined
}
