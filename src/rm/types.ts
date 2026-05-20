import type { PieceRemovalResult } from '../core/piece/remove-all-pieces.js'
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

export interface RmAllPiecesOptions extends CLIAuthOptions {
  dataSet: string
  all: true
  force?: boolean
  waitForConfirmation?: boolean
}

export interface RmAllPiecesResult {
  dataSetId: number
  totalPieces: number
  removedCount: number
  failedCount: number
  transactions: PieceRemovalResult[]
}
