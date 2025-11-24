/**
 * High-level API for filecoin-pin
 *
 * This file exports the most common functions and types for interacting with the filecoin-pin library.
 * For more advanced use cases, you can import from the granular `./core/*` modules.
 */

import * as dataSet from './core/data-set/index.js'
import * as payments from './core/payments/index.js'
import * as synapse from './core/synapse/index.js'
import * as browserCar from './core/unixfs/browser-car-builder.js'
import * as car from './core/unixfs/car-builder.js'
import * as upload from './core/upload/index.js'
import type { FilecoinPinAPI } from './index-types.js'

export * from './index-types.js'

const publicApi = {
  getDataSetPieces: dataSet.getDataSetPieces,
  getDetailedDataSet: dataSet.getDetailedDataSet,
  listDataSets: dataSet.listDataSets,
  getPaymentStatus: payments.getPaymentStatus,
  setMaxAllowances: payments.setMaxAllowances,
  validatePaymentCapacity: payments.validatePaymentCapacity,
  cleanupSynapseService: synapse.cleanupSynapseService,
  initializeSynapse: synapse.initializeSynapse,
  setupSynapse: synapse.setupSynapse,
  createCarFromFile: browserCar.createCarFromFile,
  createCarFromFiles: browserCar.createCarFromFiles,
  createCarFromPath: car.createCarFromPath,
  checkUploadReadiness: upload.checkUploadReadiness,
  executeUpload: upload.executeUpload,
} satisfies FilecoinPinAPI

export default publicApi

export const {
  getDataSetPieces,
  getDetailedDataSet,
  listDataSets,
  getPaymentStatus,
  setMaxAllowances,
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
