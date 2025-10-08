/**
 * Deprecated shim: Synapse helpers now reside in `src/core/synapse`.
 *
 * Kept for backwards compatibility with early alpha releases. New code should
 * depend on `../core/synapse/index.js` directly.
 */
export type {
  SynapseService,
  SynapseSetupConfig,
} from '../core/synapse/index.js'

export {
  cleanupProvider,
  cleanupSynapseService,
  createStorageContext,
  getDefaultStorageContextConfig,
  getSynapseService,
  initializeSynapse,
  resetSynapseService,
  setupSynapse,
} from '../core/synapse/index.js'
