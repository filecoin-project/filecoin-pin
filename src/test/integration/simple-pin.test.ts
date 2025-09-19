import { rm, stat } from 'node:fs/promises'
import { createHelia } from 'helia'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConfig } from '../../config.js'
import { FilecoinPinStore } from '../../filecoin-pin-store.js'
import { createLogger } from '../../logger.js'
import { MockSynapse, mockProviderInfo } from '../mocks/synapse-mocks.js'

// Mock the Synapse SDK - vi.mock requires async import for ES modules
vi.mock('@filoz/synapse-sdk', async () => await import('../mocks/synapse-sdk.js'))

describe('Simple Pin Test', () => {
  let pinStore: FilecoinPinStore
  let contentOriginHelia: any
  let testCID: CID
  let testBlock: Uint8Array
  const testOutputDir = './test-simple-car-output'

  beforeEach(async () => {
    // Create test data
    testBlock = new TextEncoder().encode('Simple test block')
    const hash = await sha256.digest(testBlock)
    testCID = CID.create(1, raw.code, hash)

    // Create test config with test private key
    const config = {
      ...createConfig(),
      carStoragePath: testOutputDir,
      privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001', // Fake test key
    }
    const logger = createLogger(config)

    // Create a Helia node to serve content
    contentOriginHelia = await createHelia()
    await contentOriginHelia.blockstore.put(testCID, testBlock)

    // Create mock Synapse service
    const mockSynapse = new MockSynapse()
    const mockStorage = await mockSynapse.storage.createContext()
    const synapseService = { synapse: mockSynapse as any, storage: mockStorage, providerInfo: mockProviderInfo }

    // Create Filecoin pin store with mock Synapse
    pinStore = new FilecoinPinStore({
      config,
      logger,
      synapseService,
    })

    await pinStore.start()
  })

  afterEach(async () => {
    await pinStore.stop()
    if (contentOriginHelia != null) {
      await contentOriginHelia.stop()
    }
    try {
      await stat(testOutputDir)
      await rm(testOutputDir, { recursive: true, force: true })
    } catch {
      // Directory doesn't exist, nothing to clean up
    }
  })

  it('should pin content and create CAR file', async () => {
    // Get origin multiaddr
    const originAddrs = contentOriginHelia.libp2p.getMultiaddrs()
    const origins = originAddrs.map((addr: any) => addr.toString())

    console.log('Test: Creating pin with origins:', origins)
    console.log('Test: Number of origins:', origins.length)

    const pinResult = await pinStore.pin({ id: 'test-user', name: 'Test User' }, testCID, {
      name: 'Simple Test',
      origins,
    })

    console.log('Test: Pin created:', pinResult.id, pinResult.status)

    // Wait for background processing - increased timeout to allow for block fetch
    await new Promise((resolve) => setTimeout(resolve, 15000))

    // Check final status
    const finalStatus = await pinStore.get({ id: 'test-user', name: 'Test User' }, pinResult.id)

    console.log('Test: Final status:', finalStatus?.status)
    console.log('Test: CAR file path:', finalStatus?.filecoin?.carFilePath)
    const fileExists = await stat(finalStatus?.filecoin?.carFilePath ?? '')
      .then(() => true)
      .catch(() => false)
    console.log('Test: CAR file exists:', fileExists)

    expect(finalStatus?.status).toBe('pinned')
    expect(finalStatus?.filecoin?.carFilePath).toBeDefined()
    expect(fileExists).toBe(true)
  }, 30000)
})
