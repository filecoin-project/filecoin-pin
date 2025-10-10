/**
 * UnixFS to CAR conversion functionality
 *
 * This module provides utilities to create CAR files from files and directories
 * using @helia/unixfs and CARWritingBlockstore.
 */

import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { globSource, unixfs } from '@helia/unixfs'
import { CarWriter } from '@ipld/car'
import { CID } from 'multiformats/cid'
import type { Logger } from 'pino'
import { CARWritingBlockstore } from '../car/index.js'

// Spinner type for progress reporting
type Spinner = {
  start(msg: string): void
  stop(msg: string): void
  message(msg: string): void
}

// Placeholder CID used during CAR creation (will be replaced with actual root)
const PLACEHOLDER_CID = CID.parse('bafyaaiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')

// Whether to include hidden files (starting with .) when adding directories
const INCLUDE_HIDDEN_FILES = true

export interface CreateCarOptions {
  logger?: Logger
  bare?: boolean
  spinner?: Spinner
  isDirectory?: boolean
}

export interface CreateCarResult {
  carPath: string
  rootCid: CID
}

/**
 * Create a CAR file from a file or directory using UnixFS encoding
 *
 * @param path - Path to the file or directory to encode
 * @param options - Optional logger, bare flag, and directory flag
 * @returns Path to temporary CAR file, root CID, and entry count
 */
export async function createCarFromPath(path: string, options: CreateCarOptions = {}): Promise<CreateCarResult> {
  const { bare = false, isDirectory = false } = options

  // Determine if path is a directory if not explicitly specified
  let pathIsDirectory = isDirectory
  if (!pathIsDirectory) {
    const stats = await stat(path)
    pathIsDirectory = stats.isDirectory()
  }

  // Handle directory
  if (pathIsDirectory) {
    if (bare) {
      throw new Error('--bare flag is not supported for directories')
    }
    return createCarFromDirectory(path, options)
  }

  // Handle file
  return createCarFromSingleFile(path, options)
}

/**
 * Common CAR creation logic
 *
 * @param contentPath - Path to the content to encode
 * @param options - Options including logger and type
 * @param addContent - Function that adds content to UnixFS and returns the root CID
 * @returns CAR file path and root CID
 */
async function createCar(
  contentPath: string,
  options: CreateCarOptions & { type: 'file' | 'directory' },
  addContent: (fs: any) => Promise<CID>
): Promise<CreateCarResult> {
  const { logger, type } = options

  // Generate temp file path
  const tempCarPath = join(tmpdir(), `filecoin-pin-add-${Date.now()}-${randomBytes(8).toString('hex')}.car`)

  logger?.info({ path: contentPath, tempCarPath, type }, `Creating CAR from ${type}`)
  logger?.debug({ placeholderCID: PLACEHOLDER_CID.toString() }, 'Using placeholder CID')

  // Create blockstore with placeholder CID
  const blockstoreOptions: any = {
    rootCID: PLACEHOLDER_CID,
    outputPath: tempCarPath,
  }
  if (logger) {
    blockstoreOptions.logger = logger
  }
  const blockstore = new CARWritingBlockstore(blockstoreOptions)

  // Initialize blockstore (writes CAR header with placeholder)
  await blockstore.initialize()

  // Create UnixFS instance with our blockstore
  const fs = unixfs({ blockstore })

  // Add content using the provided function
  const rootCid = await addContent(fs)

  logger?.info({ rootCid: rootCid.toString() }, `Content added to UnixFS`)

  // Finalize CAR (close writer, flush to disk)
  await blockstore.finalize()

  // Update the root CID in the CAR file
  logger?.debug('Updating root CID in CAR file')
  const fd = await open(tempCarPath, 'r+')
  try {
    await CarWriter.updateRootsInFile(fd, [rootCid])
  } finally {
    await fd.close()
  }

  logger?.info(
    {
      carPath: tempCarPath,
      rootCid: rootCid.toString(),
      stats: blockstore.getStats(),
    },
    `CAR file created successfully`
  )

  return { carPath: tempCarPath, rootCid }
}

/**
 * Create a CAR file from a single file
 *
 * @param filePath - Path to the file to encode
 * @param options - Options including logger and bare flag
 * @returns CAR file path and root CID
 */
async function createCarFromSingleFile(filePath: string, options: CreateCarOptions = {}): Promise<CreateCarResult> {
  const { logger, bare = false } = options

  return createCar(filePath, { ...options, type: 'file' }, async (fs) => {
    const fileStream = createReadStream(filePath)
    const webStream = Readable.toWeb(fileStream) as ReadableStream<Uint8Array>

    let rootCid: CID
    if (bare) {
      // Bare mode: add file directly as byte stream without any wrapper
      logger?.info({ filePath }, 'Adding file to UnixFS (bare mode)')
      rootCid = await fs.addByteStream(webStream)
    } else {
      // Directory wrapper mode: use addFile which automatically creates a directory wrapper
      const fileName = basename(filePath)
      logger?.info({ filePath, fileName }, 'Adding file to UnixFS with directory wrapper')
      rootCid = await fs.addFile({
        path: fileName,
        content: webStream,
      })
    }

    return rootCid
  })
}

/**
 * Create a CAR file from a directory
 *
 * @param dirPath - Path to the directory to encode
 * @param options - Options including logger and spinner
 * @returns CAR file path and root CID
 */
async function createCarFromDirectory(dirPath: string, options: CreateCarOptions = {}): Promise<CreateCarResult> {
  const { logger, spinner } = options

  return createCar(dirPath, { ...options, type: 'directory' }, async (fs) => {
    logger?.info({ dirPath }, 'Streaming directory contents to UnixFS')

    // Resolve to absolute path to handle cases like '.' or relative paths
    const absolutePath = resolve(dirPath)
    const parentDir = dirname(absolutePath)
    const dirName = basename(absolutePath)

    // Use globSource with the parent directory as base and include the directory name in the pattern
    // This ensures the directory name is part of the UnixFS structure
    // We match only the directory contents (/**/*), not the directory itself
    // addAll will automatically create the root directory entry with proper links
    const pattern = `${dirName}/**/*`
    logger?.info({ absolutePath, parentDir, dirName, pattern }, 'Directory structure for UnixFS')

    const candidates = globSource(parentDir, pattern, {
      hidden: INCLUDE_HIDDEN_FILES,
    })

    // Track progress
    let fileCount = 0
    async function* trackProgress(source: AsyncIterable<any>) {
      for await (const entry of source) {
        fileCount++
        spinner?.message(`Adding: ${entry.path}`)
        logger?.debug({ path: entry.path, hasContent: !!entry.content }, 'Processing entry')
        yield entry
      }
    }

    // Add all entries using addAll
    const entries = []
    for await (const entry of fs.addAll(trackProgress(candidates))) {
      logger?.debug({ path: entry.path || '(root)', cid: entry.cid.toString() }, 'Entry added to CAR')
      entries.push(entry)
    }

    // The last entry should be the root directory
    // For empty directories, addAll might still yield a root entry
    const rootCid = entries[entries.length - 1]?.cid
    if (!rootCid) {
      // Empty directory - create a single empty directory block
      const emptyDirCid = await fs.addDirectory()
      return emptyDirCid
    }

    logger?.info({ fileCount, rootCid: rootCid.toString() }, 'Directory added to UnixFS')
    return rootCid
  })
}

/**
 * Clean up temporary CAR file
 *
 * @param carPath - Path to the temporary CAR file to delete
 * @param logger - Optional logger
 */
export async function cleanupTempCar(carPath: string, logger?: Logger): Promise<void> {
  try {
    await unlink(carPath)
    logger?.debug({ carPath }, 'Cleaned up temporary CAR file')
  } catch (error) {
    // Log but don't throw - best effort cleanup
    logger?.warn({ carPath, error }, 'Failed to cleanup temporary CAR file')
    console.warn(`Failed to cleanup temp CAR file: ${carPath}`, error)
  }
}
