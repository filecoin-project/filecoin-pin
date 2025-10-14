/**
 * Node.js CAR Blockstore that writes blocks to a file on disk.
 */

import { EventEmitter } from 'node:events'
import type { CID } from 'multiformats/cid'
import type { Logger } from 'pino'
import { CARBlockstoreBase, type CARBlockstoreStats } from './car-blockstore-base.js'
import { CARFileBackend } from './car-file-backend.js'

export type { CARBlockstoreStats }

export interface CARBlockstoreOptions {
  rootCID: CID
  outputPath: string
  logger?: Logger
}

/**
 * A blockstore that writes blocks directly to a CAR file as they arrive.
 * This eliminates the need for redundant storage during IPFS pinning operations.
 */
export class CARWritingBlockstore extends CARBlockstoreBase {
  private readonly fileBackend: CARFileBackend
  private readonly eventEmitter: EventEmitter

  constructor(options: CARBlockstoreOptions) {
    const backend = new CARFileBackend(options.outputPath, options.logger)
    const eventEmitter = new EventEmitter()
    super(options.rootCID, backend, eventEmitter)
    this.fileBackend = backend
    this.eventEmitter = eventEmitter

    // Forward events from backend to our event emitter
    this.fileBackend.on('initialized', (data) => this.eventEmitter.emit('initialized', data))
    this.fileBackend.on('block:stored', (data) => this.eventEmitter.emit('block:stored', data))
    this.fileBackend.on('finalized', (data) => this.eventEmitter.emit('finalized', data || this.stats))
    this.fileBackend.on('cleanup', () => this.eventEmitter.emit('cleanup'))
    this.fileBackend.on('error', (error) => this.eventEmitter.emit('error', error))
  }

  // Expose event emitter methods for consumers
  on(event: string, listener: (...args: any[]) => void): this {
    this.eventEmitter.on(event, listener)
    return this
  }

  emit(event: string, ...args: any[]): boolean {
    return this.eventEmitter.emit(event, ...args)
  }
}
