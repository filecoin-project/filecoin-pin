import type { getDataSetPieces, getDetailedDataSet, listDataSets } from './core/data-set/index.js'
import type { getPaymentStatus, validatePaymentCapacity } from './core/payments/index.js'
import type { cleanupSynapseService, initializeSynapse, setupSynapse } from './core/synapse/index.js'
import type { createCarFromFile, createCarFromFiles } from './core/unixfs/browser-car-builder.js'
import type { createCarFromPath } from './core/unixfs/car-builder.js'
import type { checkUploadReadiness, executeUpload } from './core/upload/index.js'

export interface FilecoinPinAPI {
  getDataSetPieces: typeof getDataSetPieces
  getDetailedDataSet: typeof getDetailedDataSet
  listDataSets: typeof listDataSets
  getPaymentStatus: typeof getPaymentStatus
  validatePaymentCapacity: typeof validatePaymentCapacity
  cleanupSynapseService: typeof cleanupSynapseService
  initializeSynapse: typeof initializeSynapse
  setupSynapse: typeof setupSynapse
  createCarFromFile: typeof createCarFromFile
  createCarFromFiles: typeof createCarFromFiles
  createCarFromPath: typeof createCarFromPath
  checkUploadReadiness: typeof checkUploadReadiness
  executeUpload: typeof executeUpload
}

export type { ProviderInfo } from '@filoz/synapse-sdk'
export type {
  DataSetPiecesResult,
  DataSetSummary,
  GetDataSetPiecesOptions,
  ListDataSetsOptions,
  PieceInfo,
  Warning as DataSetWarning,
} from './core/data-set/index.js'
export type { PaymentCapacityCheck, PaymentStatus } from './core/payments/index.js'
export type {
  CreateStorageContextOptions,
  DatasetOptions,
  SynapseService,
  SynapseSetupConfig,
} from './core/synapse/index.js'
export type { CreateCarOptions, CreateCarResult } from './core/unixfs/car-builder.js'
export type {
  SynapseUploadOptions,
  SynapseUploadResult,
  UploadExecutionOptions,
  UploadExecutionResult,
  UploadProgressEvents,
  UploadReadinessOptions,
  UploadReadinessResult,
} from './core/upload/index.js'
