/**
 * @typedef {import('./types.js').CombinedContext} CombinedContext
 */

/**
 * @type {Partial<CombinedContext>} globalContext
 */
let globalContext = {}

export function getGlobalContext() {
  return globalContext
}

/**
 * Merge the given partial context into existing context and save it.
 * @param {Partial<CombinedContext>} partial
 * @returns {CombinedContext}
 */
export function mergeAndSaveContext(partial) {
  globalContext = { ...globalContext, ...partial }
  return globalContext
}
