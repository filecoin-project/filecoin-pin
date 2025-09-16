import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { bitswap } from '@helia/block-brokers'
import { identify } from '@libp2p/identify'
import { tcp } from '@libp2p/tcp'
import { multiaddr } from '@multiformats/multiaddr'
import { MemoryDatastore } from 'datastore-core'
import { createHelia, type Helia } from 'helia'
import { createLibp2p } from 'libp2p'
import type { CID } from 'multiformats/cid'
import type { Logger } from 'pino'
import { CARWritingBlockstore } from './car-blockstore.js'
import type { Config } from './config.js'

export interface PinningHeliaOptions {
  config: Config
  logger: Logger
  rootCID: CID
  outputPath: string
  origins?: string[] // Multiaddrs to connect to for content
}

/**
 * Create a Helia node with CAR-writing blockstore for a specific pin operation
 * This combines the server and CAR Helia functionality into one instance
 */
export async function createPinningHeliaNode(options: PinningHeliaOptions): Promise<{
  helia: Helia
  blockstore: CARWritingBlockstore
}> {
  const { logger, rootCID, outputPath, origins = [] } = options

  // Parse origins into multiaddrs
  const dialTargets = origins
    .map((origin) => {
      try {
        return multiaddr(origin)
      } catch (error) {
        logger.warn({ origin, error }, 'Failed to parse origin multiaddr')
        return null
      }
    })
    .filter((addr) => addr != null)

  const libp2p = await createLibp2p({
    addresses: {
      listen: ['/ip4/0.0.0.0/tcp/0'], // Random port
    },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
    },
    // No bootstrap or mdns - we'll connect directly to origins
  })

  // Create CAR-writing blockstore
  const carBlockstore = new CARWritingBlockstore({
    rootCID,
    outputPath,
    logger,
  })

  // Set up event handlers for monitoring
  carBlockstore.on('block:stored', (data) => {
    logger.debug({ cid: data.cid.toString(), size: data.size }, 'Block stored to CAR file')
  })

  carBlockstore.on('block:missing', (data) => {
    logger.warn({ cid: data.cid.toString() }, 'Block not found during fetch')
  })

  const helia = await createHelia({
    libp2p,
    blockstore: carBlockstore,
    datastore: new MemoryDatastore(),
    blockBrokers: [bitswap()],
  })

  logger.info(`Pinning Helia node started with peer ID: ${helia.libp2p.peerId.toString()}`)
  logger.info(`Writing blocks to CAR file: ${outputPath}`)

  // Connect to origin nodes if provided
  if (dialTargets.length > 0) {
    logger.info({ origins: dialTargets.length }, 'Connecting to origin nodes')

    for (const addr of dialTargets) {
      try {
        if (addr != null) {
          await helia.libp2p.dial(addr)
          logger.info({ addr: addr.toString() }, 'Connected to origin node')
        }
      } catch (error) {
        logger.warn({ addr: addr?.toString(), error }, 'Failed to connect to origin node')
      }
    }
  }

  return { helia, blockstore: carBlockstore }
}
