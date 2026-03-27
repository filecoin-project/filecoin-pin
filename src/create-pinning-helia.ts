import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { bitswap } from '@helia/block-brokers'
import { identify } from '@libp2p/identify'
import { tcp } from '@libp2p/tcp'
import { type Multiaddr, multiaddr } from '@multiformats/multiaddr'
import { MemoryDatastore } from 'datastore-core'
import { createHelia, type Helia } from 'helia'
import { createLibp2p } from 'libp2p'
import type { CID } from 'multiformats/cid'
import type { Logger } from 'pino'
import { CARWritingBlockstore } from './core/car/index.js'
import type { Config } from './core/synapse/index.js'

/**
 * Deduplicate origin multiaddrs by target peer ID, picking one address per peer.
 * Prefers TCP direct connections since that is the only transport Helia has configured.
 * Addresses without a peer ID component are included as-is.
 */
function selectDialTargets(origins: string[], logger: Logger): Multiaddr[] {
  const parsed: Multiaddr[] = []
  for (const origin of origins) {
    try {
      parsed.push(multiaddr(origin))
    } catch {
      logger.warn({ origin }, 'Failed to parse origin multiaddr, skipping')
    }
  }

  // Group by the final /p2p/<peerId> component (the target peer, not an intermediate relay)
  const byPeerId = new Map<string, Multiaddr[]>()
  const noPeerId: Multiaddr[] = []

  for (const ma of parsed) {
    const p2pComponents = ma.getComponents().filter((c) => c.name === 'p2p')
    const targetPeerId = p2pComponents[p2pComponents.length - 1]?.value
    if (targetPeerId != null) {
      const group = byPeerId.get(targetPeerId) ?? []
      group.push(ma)
      byPeerId.set(targetPeerId, group)
    } else {
      noPeerId.push(ma)
    }
  }

  // For each peer, pick the best address: TCP direct > any direct > relay
  const selected: Multiaddr[] = []
  for (const [, addrs] of byPeerId) {
    const isTcpDirect = (ma: Multiaddr) => {
      const components = ma.getComponents()
      return components.some((c) => c.name === 'tcp') && !components.some((c) => c.name === 'p2p-circuit')
    }
    const isDirect = (ma: Multiaddr) => !ma.getComponents().some((c) => c.name === 'p2p-circuit')
    const best = addrs.find(isTcpDirect) ?? addrs.find(isDirect) ?? addrs[0]
    if (best != null) {
      selected.push(best)
    }
  }

  return [...selected, ...noPeerId]
}

const IDENTIFY_MAX_MESSAGE_SIZE = 1024 * 64

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

  // Deduplicate origins: one address per target peer, preferring TCP direct connections
  const dialTargets = selectDialTargets(origins, logger)

  const libp2p = await createLibp2p({
    addresses: {
      listen: ['/ip4/0.0.0.0/tcp/0'], // Random port
    },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify({ maxMessageSize: IDENTIFY_MAX_MESSAGE_SIZE }),
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
    logger.info({ origins: origins.length, dialTargets: dialTargets.length }, 'Connecting to origin nodes')

    for (const addr of dialTargets) {
      try {
        await helia.libp2p.dial(addr)
        logger.info({ addr: addr.toString() }, 'Connected to origin node')
      } catch (error) {
        logger.warn({ addr: addr.toString(), error }, 'Failed to connect to origin node')
      }
    }
  }

  return { helia, blockstore: carBlockstore }
}
