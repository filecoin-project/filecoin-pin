import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/**
 * Read cached metadata from cache directory
 * @param {string} cacheDir - Cache directory path
 * @returns {Object} Cached metadata
 */
export async function readCachedMetadata(cacheDir) {
  const metaPath = join(cacheDir, 'upload.json')
  const text = await fs.readFile(metaPath, 'utf8')
  return JSON.parse(text)
}

/**
 * Write metadata to cache directory
 * @param {string} cacheDir - Cache directory path
 * @param {Object} metadata - Metadata to cache
 */
export async function writeCachedMetadata(cacheDir, metadata) {
  await fs.mkdir(cacheDir, { recursive: true })
  const metaPath = join(cacheDir, 'upload.json')
  await fs.writeFile(metaPath, JSON.stringify(metadata, null, 2))
}

/**
 * Mirror metadata to standard cache location
 * @param {string} workspace - Workspace directory
 * @param {string} rootCid - Root CID for cache key
 * @param {string} metadataText - Metadata JSON text
 */
export async function mirrorToStandardCache(workspace, rootCid, metadataText) {
  try {
    const stdCacheDir = join(workspace, '.filecoin-pin-cache', rootCid)
    await fs.mkdir(stdCacheDir, { recursive: true })
    await fs.writeFile(join(stdCacheDir, 'upload.json'), metadataText)
  } catch (error) {
    console.warn('Failed to mirror metadata into .filecoin-pin-cache:', error?.message || error)
  }
}

/**
 * Create artifact directory and copy files
 * @param {string} workspace - Workspace directory
 * @param {string} carPath - Source CAR file path
 * @param {Object} metadata - Metadata to write
 * @returns {Object} Artifact paths
 */
export async function createArtifacts(workspace, carPath, metadata) {
  const artifactDir = join(workspace, 'filecoin-pin-artifacts')

  try {
    await fs.mkdir(artifactDir, { recursive: true })
  } catch (error) {
    console.error('Failed to create artifact directory:', error?.message || error)
    throw error
  }

  // Copy CAR to artifact directory with a simple name
  const artifactCarPath = join(artifactDir, 'upload.car')
  await fs.copyFile(carPath, artifactCarPath)

  // Write metadata JSON into artifact directory
  const metadataPath = join(artifactDir, 'upload.json')
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2))

  return {
    artifactDir,
    artifactCarPath,
    metadataPath,
  }
}
