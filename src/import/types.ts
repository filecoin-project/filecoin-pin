export interface ImportOptions {
  filePath: string
  privateKey?: string
  rpcUrl?: string
}

export interface ImportResult {
  filePath: string
  fileSize: number
  rootCid: string
  pieceCid: string
  pieceId?: number | undefined
  dataSetId: string
  transactionHash?: string | undefined
  providerInfo?:
    | {
        id: number
        name: string
        serviceURL: string
        downloadURL: string
      }
    | undefined
}
