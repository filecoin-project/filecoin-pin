import type { StorageContext } from '@filoz/synapse-sdk/storage'
import type { StorageContextWithDataSetId } from './types.js'

export function isStorageContextWithDataSetId(value: StorageContext): value is StorageContextWithDataSetId {
  return typeof value === 'object' && value !== null && 'dataSetId' in value && typeof value.dataSetId === 'number'
}
