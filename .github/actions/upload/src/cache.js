import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { getErrorMessage } from './errors.js'

/**
 * @typedef {import('./types.js').CombinedContext} CombinedContext
 */

/**
 * Read cached context from cache directory
 * @param {string} cacheDir - Cache directory path
 * @returns {Promise<CombinedContext>} Cached context
 */
export async function readCachedContext(cacheDir) {
  const metaPath = join(cacheDir, 'context.json')
  const text = await fs.readFile(metaPath, 'utf8')
  return JSON.parse(text)
}

/**
 * Write context to cache directory
 * @param {string} cacheDir - Cache directory path
 * @param {Object} context - Context to cache
 */
export async function writeCachedContext(cacheDir, context) {
  await fs.mkdir(cacheDir, { recursive: true })
  const metaPath = join(cacheDir, 'context.json')
  // Merge if exists
  try {
    const existing = JSON.parse(await fs.readFile(metaPath, 'utf8'))
    const merged = { ...existing, ...context }
    await fs.writeFile(metaPath, JSON.stringify(merged, null, 2))
  } catch {
    await fs.writeFile(metaPath, JSON.stringify(context, null, 2))
  }
}

/**
 * Mirror context to standard cache location
 * @param {string} workspace - Workspace directory
 * @param {string} ipfsRootCid - Root CID for cache key
 * @param {string} contextText - Context JSON text
 */
export async function mirrorToStandardCache(workspace, ipfsRootCid, contextText) {
  try {
    const ctxDir = join(workspace, 'action-context')
    await fs.mkdir(ctxDir, { recursive: true })
    const ctxPath = join(ctxDir, 'context.json')
    /** @type {CombinedContext} */
    let existing = {}
    try {
      existing = JSON.parse(await fs.readFile(ctxPath, 'utf8'))
    } catch {
      // Ignore if file doesn't exist
    }
    /** @type {any} */
    const contextData = JSON.parse(contextText)
    // Map common fields
    const mapped = {
      ipfsRootCid: contextData.ipfsRootCid || existing.ipfsRootCid || ipfsRootCid,
      pieceCid: contextData.pieceCid || existing.pieceCid,
      dataSetId: contextData.dataSetId || existing.dataSetId,
      provider: contextData.provider || existing.provider,
      carPath: contextData.carPath || existing.carPath,
    }
    const merged = { ...existing, ...mapped }
    await fs.writeFile(ctxPath, JSON.stringify(merged, null, 2))
  } catch (error) {
    console.warn('Failed to mirror context into action-context/context.json:', getErrorMessage(error))
  }
}
