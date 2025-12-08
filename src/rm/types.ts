import type { CLIAuthOptions } from '../utils/cli-auth.js'

export interface RmPieceOptions extends CLIAuthOptions {
  piece: string
  dataSet: string
  waitForConfirmation?: boolean
}

export interface RmPieceResult {
  pieceCid: string
  dataSetId: number
  transactionHash: string
  confirmed: boolean
}
