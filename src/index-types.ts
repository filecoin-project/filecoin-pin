import type { getDataSetPieces, getDetailedDataSet, listDataSets } from './core/data-set/index.js'
import type { getPaymentStatus, setMaxAllowances, validatePaymentCapacity } from './core/payments/index.js'
import type { cleanupSynapseService, setupSynapse } from './core/synapse/index.js'
import type { createCarFromFile, createCarFromFiles } from './core/unixfs/browser-car-builder.js'
import type { createCarFromPath } from './core/unixfs/car-builder.js'
import type { checkUploadReadiness, executeUpload } from './core/upload/index.js'

export interface FilecoinPinAPI {
  getDataSetPieces: typeof getDataSetPieces
  getDetailedDataSet: typeof getDetailedDataSet
  listDataSets: typeof listDataSets
  getPaymentStatus: typeof getPaymentStatus
  setMaxAllowances: typeof setMaxAllowances
  validatePaymentCapacity: typeof validatePaymentCapacity
  cleanupSynapseService: typeof cleanupSynapseService
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
  PieceStatus,
} from './core/data-set/index.js'
export type {
  PaymentCapacityCheck,
  PaymentStatus,
  SetMaxAllowancesResult,
} from './core/payments/index.js'
export type {
  ServiceApprovalStatus,
  StorageAllowances,
} from './core/payments/types.js'
export type {
  CreateStorageContextOptions,
  DatasetOptions,
  PrivateKeyConfig,
  SessionKeyConfig,
  SignerConfig,
  SynapseService,
  SynapseSetupConfig,
} from './core/synapse/index.js'
export type { Spinner } from './core/unixfs/car-builder.js'
export type {
  SynapseUploadOptions,
  SynapseUploadResult,
  UploadExecutionOptions,
  UploadExecutionResult,
  UploadProgressEvents,
  UploadReadinessOptions,
  UploadReadinessProgressEvents,
  UploadReadinessResult,
} from './core/upload/index.js'
export type {
  AnyProgressEvent,
  ProgressEvent,
  ProgressEventHandler,
  Warning,
} from './core/utils/types.js'
export type {
  ValidateIPNIProgressEvents,
  WaitForIpniProviderResultsOptions,
} from './core/utils/validate-ipni-advertisement.js'
