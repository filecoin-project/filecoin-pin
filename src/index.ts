/**
 * High-level API for filecoin-pin
 *
 * This file exports the most common functions and types for interacting with the filecoin-pin library in Node.js.
 * For more advanced use cases, you can import from the granular `./core/*` modules.
 */
import { createCarFromPath as createCarFromPathCore } from './core/unixfs/car-builder.js'
import * as browser from './index.browser.js'
import type { FilecoinPinAPI } from './index-types.js'

export * from './index-types.js'

const publicApi = {
  ...browser,
  createCarFromPath: createCarFromPathCore,
} satisfies FilecoinPinAPI

export const {
  getDataSetPieces,
  getDetailedDataSet,
  listDataSets,
  getPaymentStatus,
  validatePaymentCapacity,
  cleanupSynapseService,
  setupSynapse,
  createCarFromFile,
  createCarFromFiles,
  createCarFromPath,
  checkUploadReadiness,
  executeUpload,
} = publicApi
