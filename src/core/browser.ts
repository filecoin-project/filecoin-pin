/**
 * Browser-only exports for filecoin-pin
 *
 * This module provides comprehensive browser-compatible exports with NO Node.js dependencies.
 * It combines CAR and UnixFS functionality for browser-based file uploads and IPFS/Filecoin integration.
 *
 * Note: You can also import directly from 'filecoin-pin/core/unixfs' or 'filecoin-pin/core/car'
 * and modern bundlers will automatically resolve to the browser versions via conditional exports.
 *
 * @example
 * ```typescript
 * // Direct browser import (this file)
 * import { createCarFromFile } from 'filecoin-pin/core'
 *
 * // Or use the specific module (auto-resolves to browser version in browsers)
 * import { createCarFromFile } from 'filecoin-pin/core/unixfs'
 *
 * // From file input
 * const input = document.querySelector('input[type="file"]')
 * const file = input.files[0]
 *
 * const result = await createCarFromFile(file, {
 *   onProgress: ({ type, path, bytes }) => {
 *     console.log(`Processing ${path}: ${bytes} bytes`)
 *   }
 * })
 *
 * console.log('Root CID:', result.rootCid.toString())
 *
 * // Get as a Blob for uploading
 * const blob = await result.getBlob()
 * await fetch('/upload', { method: 'POST', body: blob })
 *
 * // Or use the ReadableStream directly
 * await fetch('/upload', {
 *   method: 'POST',
 *   body: result.carStream,
 *   headers: { 'Content-Type': 'application/vnd.ipld.car' }
 * })
 * ```
 */

export * from './car/browser.js'
export * from './unixfs/browser.js'
