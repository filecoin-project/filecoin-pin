import type { DataSetSummary } from '../core/data-set/types.js'
import type { CLIAuthOptions } from '../utils/cli-auth.js'

export interface DataSetSummaryForCLI extends DataSetSummary {
  warnings: string[]
}

export interface DataSetInspectionContext {
  address: string
  network: string
  dataSets: DataSetSummaryForCLI[]
}

export interface DataSetCommandOptions extends CLIAuthOptions {
  ls?: boolean
}
