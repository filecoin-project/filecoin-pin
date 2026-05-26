/**
 * Browser-compatible UnixFS to CAR conversion functionality
 *
 * This module provides utilities to create CAR files from browser Files
 * using @helia/unixfs and BrowserCARBlockstore.
 */

import { unixfs } from '@helia/unixfs'
import { CarReader, CarWriter } from '@ipld/car'
import toBuffer from 'it-to-buffer'
import { CID } from 'multiformats/cid'
import { CARWritingBlockstore } from '../car/browser-car-blockstore.js'
import { carInputError, isCar } from '../car/is-car.js'
import { importerOptions } from './importer-options.js'

// Placeholder CID used during CAR creation (will be replaced with actual root)
const PLACEHOLDER_CID = CID.parse('bafyaaiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')

export interface CreateCarOptions {
  onProgress?: (bytesProcessed: number, totalBytes: number) => void
}

export interface CreateCarResult {
  carBytes: Uint8Array
  rootCid: CID
  /** Basename of the source, or `null` when none is available. Useful for piece metadata. */
  name: string | null
}

/**
 * Create a CAR file from a File using UnixFS encoding
 *
 * Files are encoded without a parent-directory wrapper (IPIP-499
 * conformance). The basename is exposed via CreateCarResult so callers
 * can route it into piece metadata.
 *
 * @param file - Browser File object to encode
 * @param options - Optional progress callback
 * @returns CAR bytes, root CID, and source name
 */
export async function createCarFromFile(file: File, options: CreateCarOptions = {}): Promise<CreateCarResult> {
  // Refuse to wrap an existing CAR in a new UnixFS DAG. `Blob.stream()`
  // returns a fresh stream on each call, so the upload path below is
  // unaffected by the sniff.
  if (await isCar(file.stream())) {
    throw carInputError(file.name)
  }

  const onProgress = options.onProgress
  let bytesProcessed = 0
  const totalBytes = file.size

  return createCar({ name: file.name }, async (fs) => {
    // Create async iterable from file stream
    async function* fileContent() {
      const reader = file.stream().getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) {
            bytesProcessed += value.length
            onProgress?.(bytesProcessed, totalBytes)
            yield value
          }
        }
      } finally {
        reader.releaseLock()
      }
    }

    return fs.addByteStream(fileContent(), importerOptions)
  })
}

/**
 * Multi-file uploads without a `webkitRelativePath` have no meaningful
 * basename, so `name` is returned as `null` and no `name` piece metadata is
 * attached (see `withDerivedNameMetadata`).
 */
export async function createCarFromFiles(files: File[], options: CreateCarOptions = {}): Promise<CreateCarResult> {
  if (files.length === 0) {
    throw new Error('At least one file is required')
  }

  if (files.length === 1 && files[0] != null) {
    return createCarFromFile(files[0], options)
  }

  return createCar({ name: null }, async (fs) => {
    // Convert files to addAll format
    async function* fileGenerator() {
      for (const file of files) {
        // Create async iterable from file stream
        async function* fileContent() {
          const reader = file.stream().getReader()
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              if (value) yield value
            }
          } finally {
            reader.releaseLock()
          }
        }

        yield {
          path: file.name,
          content: fileContent(),
        }
      }
    }

    // Add all entries using addAll
    const entries = []
    for await (const entry of fs.addAll(fileGenerator(), importerOptions)) {
      entries.push(entry)
    }

    // The last entry should be the root directory
    const rootCid = entries[entries.length - 1]?.cid
    if (!rootCid) {
      // Empty - create a single empty directory block
      const emptyDirCid = await fs.addDirectory(undefined, importerOptions)
      return emptyDirCid
    }

    return rootCid
  })
}

/**
 * Create a CAR file from Files with directory structure preserved
 * Handles webkitRelativePath for directory uploads
 *
 * @param files - Array of browser File objects with potential webkitRelativePath
 * @param options - Optional progress callback
 * @returns CAR bytes and root CID
 */
export async function createCarFromFileList(files: File[], options: CreateCarOptions = {}): Promise<CreateCarResult> {
  if (files.length === 0) {
    throw new Error('At least one file is required')
  }

  // Check if files have webkitRelativePath (directory upload)
  const hasDirectoryStructure = files.some((f) => (f as any).webkitRelativePath)

  if (!hasDirectoryStructure) {
    // No directory structure, treat as regular files
    return createCarFromFiles(files, options)
  }

  // Top-level directory name is the first segment of any webkitRelativePath.
  const sample = (files.find((f) => (f as any).webkitRelativePath) as any)?.webkitRelativePath as string | undefined
  const dirName = sample?.split('/')[0] ?? null

  // Has directory structure - preserve it
  return createCar({ name: dirName }, async (fs) => {
    // Convert files to addAll format with paths
    async function* fileGenerator() {
      for (const file of files) {
        const path = (file as any).webkitRelativePath || file.name

        // Create async iterable from file stream
        async function* fileContent() {
          const reader = file.stream().getReader()
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              if (value) yield value
            }
          } finally {
            reader.releaseLock()
          }
        }

        yield {
          path,
          content: fileContent(),
        }
      }
    }

    // Add all entries using addAll
    const entries = []
    for await (const entry of fs.addAll(fileGenerator(), importerOptions)) {
      entries.push(entry)
    }

    // The last entry should be the root directory
    const rootCid = entries[entries.length - 1]?.cid
    if (!rootCid) {
      // Empty - create a single empty directory block
      const emptyDirCid = await fs.addDirectory(undefined, importerOptions)
      return emptyDirCid
    }

    return rootCid
  })
}

/**
 * Common CAR creation logic
 *
 * @param meta - Source name surfaced on CreateCarResult
 * @param addContent - Function that adds content to UnixFS and returns the root CID
 * @returns CAR bytes, root CID, and source name
 */
async function createCar(
  meta: { name: string | null },
  addContent: (fs: any) => Promise<CID>
): Promise<CreateCarResult> {
  // Create blockstore with placeholder CID
  const blockstore = new CARWritingBlockstore({
    rootCID: PLACEHOLDER_CID,
  })

  // Initialize blockstore (writes CAR header with placeholder)
  await blockstore.initialize()

  // Create UnixFS instance with our blockstore
  const fs = unixfs({ blockstore })

  // Add content using the provided function
  const rootCid = await addContent(fs)

  // Finalize CAR (close writer, flush to memory)
  await blockstore.finalize()

  // Get the CAR bytes
  let carBytes = blockstore.getCarBytes()

  // Update the root CID in the CAR bytes
  carBytes = await updateRootCidInCar(carBytes, rootCid)

  return { carBytes, rootCid, name: meta.name }
}

/**
 * Update the root CID in CAR bytes
 * This creates a new CAR with the correct root CID
 */
async function updateRootCidInCar(carBytes: Uint8Array, rootCid: CID): Promise<Uint8Array> {
  // We need to replace the placeholder CID with the actual root CID
  // The easiest way is to re-read the CAR and write a new one with the correct root

  const reader = await CarReader.fromBytes(carBytes)

  // Create new CAR writer with correct root
  const { writer, out } = CarWriter.create([rootCid])

  // Collect new CAR chunks
  const newChunks: Uint8Array[] = []
  ;(async () => {
    for await (const chunk of out) {
      newChunks.push(chunk)
    }
  })()

  // Copy all blocks from old CAR to new CAR
  for await (const { cid, bytes } of reader.blocks()) {
    await writer.put({ cid, bytes })
  }

  // Close writer
  await writer.close()

  // Combine chunks
  return toBuffer(newChunks)
}
