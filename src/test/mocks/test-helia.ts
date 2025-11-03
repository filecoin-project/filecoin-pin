import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { tcp } from '@libp2p/tcp'
import { MemoryBlockstore } from 'blockstore-core'
import { MemoryDatastore } from 'datastore-core'
import { createHelia, type Helia } from 'helia'
import { createLibp2p } from 'libp2p'

/**
 * Creates a Helia node for testing with TCP-only transport.
 *
 * This configuration avoids UDP socket issues that can occur on Windows CI
 * by using only TCP transport and localhost binding.
 *
 * @returns A Helia instance configured for testing
 */
export async function createTestHelia(): Promise<Helia> {
  // Create libp2p with TCP-only configuration to avoid UDP socket issues on Windows CI
  const libp2p = await createLibp2p({
    addresses: {
      listen: ['/ip4/127.0.0.1/tcp/0'], // Localhost only, random port
    },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
    },
  })

  // Create Helia with memory-based storage for tests
  return await createHelia({
    libp2p,
    blockstore: new MemoryBlockstore(),
    datastore: new MemoryDatastore(),
  })
}
