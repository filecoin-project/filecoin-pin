/**
 * Browser-compatible UnixFS to CAR conversion functionality
 *
 * This module provides utilities to create CAR files from browser Files
 * using @helia/unixfs and BrowserCARBlockstore.
 */

import { unixfs } from '@helia/unixfs'
import { CarReader, CarWriter } from '@ipld/car'
import { CID } from 'multiformats/cid'
import { CARWritingBlockstore } from '../car/browser-car-blockstore.js'

// Placeholder CID used during CAR creation (will be replaced with actual root)
const PLACEHOLDER_CID = CID.parse('bafyaaiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')

export interface CreateCarOptions {
  bare?: boolean
  onProgress?: (bytesProcessed: number, totalBytes: number) => void
}

export interface CreateCarResult {
  carBytes: Uint8Array
  rootCid: CID
}

/**
 * Create a CAR file from a File using UnixFS encoding
 *
 * @param file - Browser File object to encode
 * @param options - Optional bare flag and progress callback
 * @returns CAR bytes and root CID
 */
export async function createCarFromFile(file: File, options: CreateCarOptions = {}): Promise<CreateCarResult> {
  const { bare = false } = options

  const onProgress = options.onProgress
  let bytesProcessed = 0
  const totalBytes = file.size

  return createCar(async (fs) => {
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

    let rootCid: CID
    if (bare) {
      // Bare mode: add file directly as byte stream without any wrapper
      rootCid = await fs.addByteStream(fileContent())
    } else {
      // Directory wrapper mode: use addFile which automatically creates a directory wrapper
      rootCid = await fs.addFile({
        path: file.name,
        content: fileContent(),
      })
    }

    return rootCid
  })
}

/**
 * Create a CAR file from multiple Files using UnixFS encoding
 *
 * @param files - Array of browser File objects to encode
 * @param options - Optional progress callback
 * @returns CAR bytes and root CID
 */
export async function createCarFromFiles(files: File[], options: CreateCarOptions = {}): Promise<CreateCarResult> {
  if (files.length === 0) {
    throw new Error('At least one file is required')
  }

  // If bare mode is requested with multiple files, throw error
  if (options.bare && files.length > 1) {
    throw new Error('--bare flag is not supported for multiple files')
  }

  // Single file with bare mode
  if (options.bare && files.length === 1 && files[0] != null) {
    return createCarFromFile(files[0], options)
  }

  return createCar(async (fs) => {
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
    for await (const entry of fs.addAll(fileGenerator())) {
      entries.push(entry)
    }

    // The last entry should be the root directory
    const rootCid = entries[entries.length - 1]?.cid
    if (!rootCid) {
      // Empty - create a single empty directory block
      const emptyDirCid = await fs.addDirectory()
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

  // Has directory structure - preserve it
  return createCar(async (fs) => {
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
    for await (const entry of fs.addAll(fileGenerator())) {
      entries.push(entry)
    }

    // The last entry should be the root directory
    const rootCid = entries[entries.length - 1]?.cid
    if (!rootCid) {
      // Empty - create a single empty directory block
      const emptyDirCid = await fs.addDirectory()
      return emptyDirCid
    }

    return rootCid
  })
}

/**
 * Common CAR creation logic
 *
 * @param content - File or Files to encode
 * @param options - Options including type
 * @param addContent - Function that adds content to UnixFS and returns the root CID
 * @returns CAR bytes and root CID
 */
async function createCar(
  // content: File | File[],
  // options: CreateCarOptions & { type: 'file' | 'directory' },
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

  return { carBytes, rootCid }
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
  const totalLength = newChunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of newChunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }

  return result
}
