/**
 * UnixFS to CAR conversion functionality
 *
 * This module provides utilities to create CAR files from regular files
 * using @helia/unixfs and CARWritingBlockstore.
 */

import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import { unixfs } from '@helia/unixfs'
import { CarWriter } from '@ipld/car'
import { CID } from 'multiformats/cid'
import type { Logger } from 'pino'
import { CARWritingBlockstore } from '../car-blockstore.js'

// Placeholder CID used during CAR creation (will be replaced with actual root)
const PLACEHOLDER_CID = CID.parse('bafyaaiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')

export interface CreateCarOptions {
  logger?: Logger
  bare?: boolean
}

export interface CreateCarResult {
  carPath: string
  rootCid: CID
}

/**
 * Create a CAR file from a regular file using UnixFS encoding
 *
 * @param filePath - Path to the file to encode
 * @param options - Optional logger and bare flag
 * @returns Path to temporary CAR file and root CID
 */
export async function createCarFromFile(filePath: string, options: CreateCarOptions = {}): Promise<CreateCarResult> {
  const { logger, bare = false } = options

  // Generate temp file path
  const tempCarPath = join(tmpdir(), `filecoin-pin-add-${Date.now()}-${randomBytes(8).toString('hex')}.car`)

  const mode = bare ? 'bare' : 'with directory wrapper'
  logger?.info({ filePath, tempCarPath, mode }, `Creating CAR from file ${mode}`)

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

  // Add file to UnixFS - method depends on bare flag
  let rootCid: CID

  const fileStream = createReadStream(filePath)
  const webStream = Readable.toWeb(fileStream) as ReadableStream<Uint8Array>

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

  logger?.info({ rootCid: rootCid.toString() }, `File added to UnixFS ${mode}`)

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
    `CAR file created successfully ${mode}`
  )

  return { carPath: tempCarPath, rootCid }
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
