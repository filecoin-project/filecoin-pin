/**
 * High-level API for filecoin-pin
 *
 * This file exports the most common functions and types for interacting with the filecoin-pin library in the browser.
 * For more advanced use cases, you can import from the granular `./core/*` modules.
 */

import * as dataSet from './core/data-set/index.js'
import * as payments from './core/payments/index.js'
import * as synapse from './core/synapse/index.js'
import * as browserCar from './core/unixfs/browser-car-builder.js'
import type { CreateCarOptions } from './core/unixfs/car-builder.js'
import * as upload from './core/upload/index.js'
import type { FilecoinPinAPI } from './index-types.js'

export * from './index-types.js'

const publicApi = {
  getDataSetPieces: dataSet.getDataSetPieces,
  getDetailedDataSet: dataSet.getDetailedDataSet,
  listDataSets: dataSet.listDataSets,
  getPaymentStatus: payments.getPaymentStatus,
  validatePaymentCapacity: payments.validatePaymentCapacity,
  cleanupSynapseService: synapse.cleanupSynapseService,
  initializeSynapse: synapse.initializeSynapse,
  setupSynapse: synapse.setupSynapse,
  createCarFromFile: browserCar.createCarFromFile,
  createCarFromFiles: browserCar.createCarFromFiles,
  /**
   * Not available in the browser; use createCarFromFile or createCarFromFiles.
   *
   * @remarks Node-only helper; preserved for API parity with the Node entrypoint.
   * @throws Always throws in browser builds.
   */
  createCarFromPath: (_path: string, _options?: CreateCarOptions): never => {
    throw new Error('Function not available in the browser.')
  },
  checkUploadReadiness: upload.checkUploadReadiness,
  executeUpload: upload.executeUpload,
} satisfies FilecoinPinAPI

export const {
  getDataSetPieces,
  getDetailedDataSet,
  listDataSets,
  getPaymentStatus,
  validatePaymentCapacity,
  cleanupSynapseService,
  initializeSynapse,
  setupSynapse,
  createCarFromFile,
  createCarFromFiles,
  createCarFromPath,
  checkUploadReadiness,
  executeUpload,
} = publicApi
