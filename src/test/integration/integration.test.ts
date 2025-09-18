import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { unixfs } from '@helia/unixfs'
import { CarReader } from '@ipld/car'
import * as dagCbor from '@ipld/dag-cbor'
import { identify } from '@libp2p/identify'
import { tcp } from '@libp2p/tcp'
import { MemoryBlockstore } from 'blockstore-core'
import { MemoryDatastore } from 'datastore-core'
import { createHelia } from 'helia'
import { createLibp2p } from 'libp2p'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConfig } from '../../config.js'
import { createFilecoinPinningServer } from '../../filecoin-pinning-server.js'
import { createLogger } from '../../logger.js'

// Mock the Synapse SDK - vi.mock requires async import for ES modules
vi.mock('@filoz/synapse-sdk', async () => await import('../mocks/synapse-sdk.js'))

// Type for API responses
interface PinResponse {
  requestid: string
  status: string
  pin: {
    cid: string
    name?: string
  }
  info?: any
}

interface ListResponse {
  count: number
  results: PinResponse[]
}

describe('End-to-End Pinning Service', () => {
  let clientHelia: any
  let pinningServer: any
  let pinStore: any
  let serverAddress: string
  const testOutputDir = './test-e2e-cars'

  beforeEach(async () => {
    // Create test config with test private key
    const config = {
      ...createConfig(),
      carStoragePath: testOutputDir,
      port: 0, // Use random port
      privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001', // Fake test key
    }
    const logger = createLogger(config)

    // Create client Helia node (content provider)
    const libp2p = await createLibp2p({
      addresses: {
        listen: ['/ip4/127.0.0.1/tcp/0'], // Random port on localhost
      },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: {
        identify: identify(),
      },
    })

    clientHelia = await createHelia({
      libp2p,
      blockstore: new MemoryBlockstore(),
      datastore: new MemoryDatastore(),
    })

    // Create pinning server
    const serviceInfo = { service: 'filecoin-pin', version: '0.1.0' }
    const serverResult = await createFilecoinPinningServer(config, logger, serviceInfo)
    pinningServer = serverResult.server
    pinStore = serverResult.pinStore

    // Get the actual server address
    const address = pinningServer.server.address()
    const port = typeof address === 'string' ? address : address?.port
    serverAddress = `http://localhost:${port as string | number}`
  }, 30000)

  afterEach(async () => {
    if (pinningServer != null) {
      await pinningServer.close()
    }
    if (pinStore != null) {
      await pinStore.stop()
    }
    if (clientHelia != null) {
      await clientHelia.stop()
    }

    // Clean up test files
    if (existsSync(testOutputDir)) {
      await rm(testOutputDir, { recursive: true, force: true })
    }
  }, 15000)

  describe('HTTP API End-to-End', () => {
    it('should accept pin requests via HTTP API and create CAR files', async () => {
      // 1. Create content on client node
      const testData = new TextEncoder().encode('Hello, E2E testing!')
      const hash = await sha256.digest(testData)
      const testCID = CID.create(1, raw.code, hash)

      // Add content to client node
      await clientHelia.blockstore.put(testCID, testData)

      // Get client multiaddr for origin
      const clientAddrs = clientHelia.libp2p.getMultiaddrs()
      const origins = clientAddrs.map((addr: any) => addr.toString())

      // 2. Make HTTP pin request to server
      const pinResponse = await fetch(`${serverAddress}/pins`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify({
          cid: testCID.toString(),
          name: 'E2E Test Pin',
          origins,
          meta: { test: 'e2e', source: 'http-api' },
        }),
      })

      expect(pinResponse.status).toBe(202)
      const pinResult = (await pinResponse.json()) as PinResponse

      expect(pinResult).toBeDefined()
      expect(pinResult.requestid).toBeDefined()
      expect(pinResult.pin.cid).toBe(testCID.toString())
      expect(pinResult.pin.name).toBe('E2E Test Pin')

      // 3. Wait for processing and check status
      let pinStatus: PinResponse | undefined
      let attempts = 0
      do {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const statusResponse = await fetch(`${serverAddress}/pins/${pinResult.requestid}`, {
          headers: { Authorization: 'Bearer test-token' },
        })
        pinStatus = (await statusResponse.json()) as PinResponse
        attempts++
      } while (pinStatus.status !== 'pinned' && pinStatus.status !== 'failed' && attempts < 10)

      expect(pinStatus.status).toBe('pinned')

      // 4. Verify CAR file was created and contains correct data
      if (pinStatus.info?.car_file_path != null) {
        expect(existsSync(pinStatus.info.car_file_path)).toBe(true)

        const carBytes = await readFile(pinStatus.info.car_file_path)
        const reader = await CarReader.fromBytes(carBytes)

        // Check roots
        const roots = await reader.getRoots()
        expect(roots).toHaveLength(1)
        expect(roots[0]?.toString()).toBe(testCID.toString())

        // Check blocks
        const blocks = []
        for await (const { cid, bytes } of reader.blocks()) {
          blocks.push({ cid: cid.toString(), bytes: new Uint8Array(bytes) })
        }

        expect(blocks).toHaveLength(1)
        expect(blocks[0]?.cid).toBe(testCID.toString())
        expect(blocks[0]?.bytes).toEqual(testData)
      }
    }, 30000)

    it('should handle DAG-CBOR multi-block structures', async () => {
      // 1. Create a multi-block DAG using DAG-CBOR
      const leaf1Data = { type: 'leaf', content: 'This is leaf 1', data: new Uint8Array(1024).fill(1) }
      const leaf1Bytes = dagCbor.encode(leaf1Data)
      const leaf1Hash = await sha256.digest(leaf1Bytes)
      const leaf1CID = CID.create(1, dagCbor.code, leaf1Hash)
      await clientHelia.blockstore.put(leaf1CID, leaf1Bytes)

      const leaf2Data = { type: 'leaf', content: 'This is leaf 2', data: new Uint8Array(1024).fill(2) }
      const leaf2Bytes = dagCbor.encode(leaf2Data)
      const leaf2Hash = await sha256.digest(leaf2Bytes)
      const leaf2CID = CID.create(1, dagCbor.code, leaf2Hash)
      await clientHelia.blockstore.put(leaf2CID, leaf2Bytes)

      const leaf3Data = { type: 'leaf', content: 'This is leaf 3', data: new Uint8Array(1024).fill(3) }
      const leaf3Bytes = dagCbor.encode(leaf3Data)
      const leaf3Hash = await sha256.digest(leaf3Bytes)
      const leaf3CID = CID.create(1, dagCbor.code, leaf3Hash)
      await clientHelia.blockstore.put(leaf3CID, leaf3Bytes)

      // Create intermediate node that references two leaves
      const intermediateData = {
        type: 'intermediate',
        name: 'branch-node',
        children: [leaf1CID, leaf2CID],
      }
      const intermediateBytes = dagCbor.encode(intermediateData)
      const intermediateHash = await sha256.digest(intermediateBytes)
      const intermediateCID = CID.create(1, dagCbor.code, intermediateHash)
      await clientHelia.blockstore.put(intermediateCID, intermediateBytes)

      // Create root node that references intermediate and leaf3
      const rootData = {
        type: 'root',
        name: 'test-dag',
        left: intermediateCID,
        right: leaf3CID,
        metadata: { created: new Date().toISOString() },
      }
      const rootBytes = dagCbor.encode(rootData)
      const rootHash = await sha256.digest(rootBytes)
      const rootCID = CID.create(1, dagCbor.code, rootHash)
      await clientHelia.blockstore.put(rootCID, rootBytes)

      // Get client multiaddr for origin
      const clientAddrs = clientHelia.libp2p.getMultiaddrs()
      const origins = clientAddrs.map((addr: any) => addr.toString())

      // 2. Pin via HTTP API
      const pinResponse = await fetch(`${serverAddress}/pins`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify({
          cid: rootCID.toString(),
          name: 'DAG-CBOR Multi-block Test',
          origins,
          meta: { type: 'dag-cbor', blocks: '5' },
        }),
      })

      expect(pinResponse.status).toBe(202)
      const pinResult = (await pinResponse.json()) as PinResponse

      // 3. Wait for completion
      let pinStatus: PinResponse | undefined
      let attempts = 0
      do {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const statusResponse = await fetch(`${serverAddress}/pins/${pinResult.requestid}`, {
          headers: { Authorization: 'Bearer test-token' },
        })
        pinStatus = (await statusResponse.json()) as PinResponse
        attempts++
      } while (pinStatus.status !== 'pinned' && pinStatus.status !== 'failed' && attempts < 10)

      expect(pinStatus.status).toBe('pinned')

      // Should have exactly 5 blocks (root + intermediate + 3 leaves)
      const blocksWritten = parseInt(pinStatus.info?.blocks_written ?? '0', 10)
      expect(blocksWritten).toBe(5)

      // 4. Verify CAR file contains all blocks
      if (pinStatus.info?.car_file_path != null) {
        const carBytes = await readFile(pinStatus.info.car_file_path)
        const reader = await CarReader.fromBytes(carBytes)

        const blocks = new Map<string, Uint8Array>()
        for await (const { cid, bytes } of reader.blocks()) {
          blocks.set(cid.toString(), new Uint8Array(bytes))
        }

        // Verify all expected blocks are present
        expect(blocks.has(rootCID.toString())).toBe(true)
        expect(blocks.has(intermediateCID.toString())).toBe(true)
        expect(blocks.has(leaf1CID.toString())).toBe(true)
        expect(blocks.has(leaf2CID.toString())).toBe(true)
        expect(blocks.has(leaf3CID.toString())).toBe(true)

        // Verify root
        const roots = await reader.getRoots()
        expect(roots[0]?.toString()).toBe(rootCID.toString())
      }
    }, 30000)

    it('should handle UnixFS multi-block files with unique data', async () => {
      // Test that UnixFS properly chunks unique data into multiple blocks
      const fs = unixfs(clientHelia)

      // Create 10MB of random data
      const dataSize = 10 * 1024 * 1024 // 10MB
      const randomData = new Uint8Array(dataSize)

      // Fill with random bytes
      for (let i = 0; i < dataSize; i++) {
        randomData[i] = Math.floor(Math.random() * 256)
      }

      // Add using addBytes
      const fileCID = await fs.addBytes(randomData)

      // Get client multiaddr for origin
      const clientAddrs = clientHelia.libp2p.getMultiaddrs()
      const origins = clientAddrs.map((addr: any) => addr.toString())

      // Pin via HTTP API
      const pinResponse = await fetch(`${serverAddress}/pins`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify({
          cid: fileCID.toString(),
          name: 'UnixFS Random Data File',
          origins,
          meta: { type: 'unixfs-random', size: '10MB' },
        }),
      })

      expect(pinResponse.status).toBe(202)
      const pinResult = (await pinResponse.json()) as PinResponse

      // Wait for completion
      let pinStatus: PinResponse | undefined
      let attempts = 0
      do {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        const statusResponse = await fetch(`${serverAddress}/pins/${pinResult.requestid}`, {
          headers: { Authorization: 'Bearer test-token' },
        })
        pinStatus = (await statusResponse.json()) as PinResponse
        attempts++
      } while (pinStatus.status !== 'pinned' && pinStatus.status !== 'failed' && attempts < 15)

      expect(pinStatus.status).toBe('pinned')

      // Should have ~10 blocks for 10MB with 1MB chunks
      const blocksWritten = parseInt(pinStatus.info?.blocks_written ?? '0', 10)
      expect(blocksWritten).toBeGreaterThanOrEqual(10) // Should be 11 (10 data + 1 metadata)

      // Verify CAR file
      if (pinStatus.info?.car_file_path != null) {
        const carBytes = await readFile(pinStatus.info.car_file_path)
        const reader = await CarReader.fromBytes(carBytes)

        let rawBlockCount = 0
        let dagPbBlockCount = 0

        for await (const { cid } of reader.blocks()) {
          if (cid.code === 0x55) {
            // raw
            rawBlockCount++
          } else if (cid.code === 0x70) {
            // dag-pb
            dagPbBlockCount++
          }
        }

        // Should have 10 raw blocks and 1 dag-pb block
        expect(rawBlockCount).toBe(10)
        expect(dagPbBlockCount).toBe(1)

        // Verify root
        const roots = await reader.getRoots()
        expect(roots[0]?.toString()).toBe(fileCID.toString())
      }
    }, 45000)

    it('should handle UnixFS deduplication correctly in CAR files', async () => {
      // Test that deduplicated blocks are only written once to CAR files
      const fs = unixfs(clientHelia)

      // Create 10MB of repeated data (all zeros)
      const dataSize = 10 * 1024 * 1024 // 10MB
      const repeatedData = new Uint8Array(dataSize) // All zeros

      // Add using addBytes
      const fileCID = await fs.addBytes(repeatedData)

      // Get client multiaddr for origin
      const clientAddrs = clientHelia.libp2p.getMultiaddrs()
      const origins = clientAddrs.map((addr: any) => addr.toString())

      // Pin via HTTP API
      const pinResponse = await fetch(`${serverAddress}/pins`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify({
          cid: fileCID.toString(),
          name: 'UnixFS Repeated Data File',
          origins,
          meta: { type: 'unixfs-zeros', size: '10MB' },
        }),
      })

      expect(pinResponse.status).toBe(202)
      const pinResult = (await pinResponse.json()) as PinResponse

      // Wait for completion
      let pinStatus: PinResponse | undefined
      let attempts = 0
      do {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        const statusResponse = await fetch(`${serverAddress}/pins/${pinResult.requestid}`, {
          headers: { Authorization: 'Bearer test-token' },
        })
        pinStatus = (await statusResponse.json()) as PinResponse
        attempts++
      } while (pinStatus.status !== 'pinned' && pinStatus.status !== 'failed' && attempts < 15)

      expect(pinStatus.status).toBe('pinned')

      // Should have only 2 blocks due to deduplication!
      const blocksWritten = parseInt(pinStatus.info?.blocks_written ?? '0', 10)
      expect(blocksWritten).toBe(2) // Just 1 data block (repeated) + 1 metadata

      // CRITICAL: Verify the total size is ~1MB, not ~10MB
      // This ensures we're not writing the same block 10 times
      const totalSize = parseInt(pinStatus.info?.total_size ?? '0', 10)
      expect(totalSize).toBeLessThan(1.2 * 1024 * 1024) // Should be ~1MB + metadata, not 10MB
      expect(totalSize).toBeGreaterThan(1 * 1024 * 1024) // But at least 1MB

      // Verify CAR file
      if (pinStatus.info?.car_file_path != null) {
        const carBytes = await readFile(pinStatus.info.car_file_path)
        const reader = await CarReader.fromBytes(carBytes)

        let rawBlockCount = 0
        let dagPbBlockCount = 0
        const uniqueBlocks = new Set<string>()

        for await (const { cid } of reader.blocks()) {
          uniqueBlocks.add(cid.toString())
          if (cid.code === 0x55) {
            // raw
            rawBlockCount++
          } else if (cid.code === 0x70) {
            // dag-pb
            dagPbBlockCount++
          }
        }

        // Due to deduplication, all chunks point to the same block
        expect(rawBlockCount).toBe(1) // Only 1 unique data block
        expect(dagPbBlockCount).toBe(1) // 1 metadata block
        expect(uniqueBlocks.size).toBe(2) // Only 2 unique blocks in CAR

        // Verify CAR file size matches the expected ~1MB + overhead
        expect(carBytes.length).toBeLessThan(1.2 * 1024 * 1024)

        // Verify root
        const roots = await reader.getRoots()
        expect(roots[0]?.toString()).toBe(fileCID.toString())
      }
    }, 30000)

    it('should handle multiple concurrent pin requests', async () => {
      // 1. Create multiple pieces of content
      const contents = []
      for (let i = 0; i < 3; i++) {
        const data = new TextEncoder().encode(`Concurrent test content ${i}`)
        const hash = await sha256.digest(data)
        const cid = CID.create(1, raw.code, hash)
        await clientHelia.blockstore.put(cid, data)
        contents.push({ cid, data })
      }

      // Get client multiaddr for origin
      const clientAddrs = clientHelia.libp2p.getMultiaddrs()
      const origins = clientAddrs.map((addr: any) => addr.toString())

      // 2. Submit multiple pin requests concurrently
      const pinPromises = contents.map(async (content, index) => {
        const response = await fetch(`${serverAddress}/pins`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-token',
          },
          body: JSON.stringify({
            cid: content.cid.toString(),
            name: `Concurrent Pin ${index}`,
            origins,
            meta: { index: index.toString() },
          }),
        })
        return await response.json()
      })

      const pinResults = await Promise.all(pinPromises)
      expect(pinResults).toHaveLength(3)

      // 3. Wait for all pins to complete
      const finalStatuses = []
      for (const pinResult of pinResults) {
        let pinStatus: PinResponse | undefined
        let attempts = 0
        do {
          await new Promise((resolve) => setTimeout(resolve, 1000))
          const statusResponse = await fetch(`${serverAddress}/pins/${(pinResult as PinResponse).requestid}`, {
            headers: { Authorization: 'Bearer test-token' },
          })
          pinStatus = (await statusResponse.json()) as PinResponse
          attempts++
        } while (pinStatus.status !== 'pinned' && pinStatus.status !== 'failed' && attempts < 10)

        finalStatuses.push(pinStatus)
      }

      // 4. Verify all pins completed successfully
      for (let i = 0; i < finalStatuses.length; i++) {
        const status = finalStatuses[i]
        expect(status?.status).toBe('pinned')
        expect(status?.pin.name).toBe(`Concurrent Pin ${i}`)

        // Verify CAR file
        if (status?.info?.car_file_path != null) {
          expect(existsSync(status.info.car_file_path)).toBe(true)

          const carBytes = await readFile(status.info.car_file_path)
          const reader = await CarReader.fromBytes(carBytes)

          const blocks = []
          for await (const { cid, bytes } of reader.blocks()) {
            blocks.push({ cid: cid.toString(), bytes: new Uint8Array(bytes) })
          }

          expect(blocks).toHaveLength(1)
          expect(blocks[0]?.bytes).toEqual(contents[i]?.data)
        }
      }
    }, 30000)

    it('should list pins via HTTP API', async () => {
      // 1. Create and pin some content
      const testData = new TextEncoder().encode('List test content')
      const hash = await sha256.digest(testData)
      const testCID = CID.create(1, raw.code, hash)
      await clientHelia.blockstore.put(testCID, testData)

      // Get client multiaddr for origin
      const clientAddrs = clientHelia.libp2p.getMultiaddrs()
      const origins = clientAddrs.map((addr: any) => addr.toString())

      const pinResponse = await fetch(`${serverAddress}/pins`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify({
          cid: testCID.toString(),
          name: 'List Test Pin',
          origins,
        }),
      })

      const pinResult = (await pinResponse.json()) as PinResponse

      // 2. List pins
      const listResponse = await fetch(`${serverAddress}/pins`, {
        headers: { Authorization: 'Bearer test-token' },
      })

      expect(listResponse.status).toBe(200)
      const listResult = (await listResponse.json()) as ListResponse

      expect(listResult.count).toBeGreaterThanOrEqual(1)
      expect(listResult.results).toBeDefined()

      const ourPin = listResult.results.find((pin: any) => pin.requestid === pinResult.requestid)
      expect(ourPin).toBeDefined()
      expect(ourPin?.pin.cid).toBe(testCID.toString())
      expect(ourPin?.pin.name).toBe('List Test Pin')
    }, 20000)

    it('should handle pin cancellation via HTTP API', async () => {
      // 1. Create content and start pin
      const testData = new TextEncoder().encode('Cancel test content')
      const hash = await sha256.digest(testData)
      const testCID = CID.create(1, raw.code, hash)
      await clientHelia.blockstore.put(testCID, testData)

      // Get client multiaddr for origin
      const clientAddrs = clientHelia.libp2p.getMultiaddrs()
      const origins = clientAddrs.map((addr: any) => addr.toString())

      const pinResponse = await fetch(`${serverAddress}/pins`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify({
          cid: testCID.toString(),
          name: 'Cancel Test Pin',
          origins,
        }),
      })

      const pinResult = (await pinResponse.json()) as PinResponse

      // 2. Cancel the pin
      const cancelResponse = await fetch(`${serverAddress}/pins/${String(pinResult.requestid)}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer test-token' },
      })

      expect(cancelResponse.status).toBe(202)

      // 3. Verify pin is no longer accessible
      const getResponse = await fetch(`${serverAddress}/pins/${String(pinResult.requestid)}`, {
        headers: { Authorization: 'Bearer test-token' },
      })

      expect(getResponse.status).toBe(404)
    }, 15000)
  })

  describe('Block Transfer Verification', () => {
    it('should successfully transfer blocks between nodes and verify in CAR', async () => {
      // 1. Create a DAG with multiple connected blocks
      const blocks = []
      const leafData1 = new TextEncoder().encode('Leaf block 1')
      const leafHash1 = await sha256.digest(leafData1)
      const leafCID1 = CID.create(1, raw.code, leafHash1)
      blocks.push({ cid: leafCID1, data: leafData1 })

      const leafData2 = new TextEncoder().encode('Leaf block 2')
      const leafHash2 = await sha256.digest(leafData2)
      const leafCID2 = CID.create(1, raw.code, leafHash2)
      blocks.push({ cid: leafCID2, data: leafData2 })

      // Create root block that references the leaves
      const rootData = new TextEncoder().encode(
        `Root block referencing ${leafCID1.toString()} and ${leafCID2.toString()}`
      )
      const rootHash = await sha256.digest(rootData)
      const rootCID = CID.create(1, raw.code, rootHash)
      blocks.push({ cid: rootCID, data: rootData })

      // 2. Add all blocks to client node
      for (const block of blocks) {
        await clientHelia.blockstore.put(block.cid, block.data)
      }

      // Get client multiaddr for origin
      const clientAddrs = clientHelia.libp2p.getMultiaddrs()
      const origins = clientAddrs.map((addr: any) => addr.toString())

      // 3. Pin the root CID (should pull all referenced blocks)
      const pinResponse = await fetch(`${serverAddress}/pins`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify({
          cid: rootCID.toString(),
          name: 'DAG Transfer Test',
          origins,
        }),
      })

      const pinResult = (await pinResponse.json()) as PinResponse

      // 4. Wait for completion
      let pinStatus: PinResponse | undefined
      let attempts = 0
      do {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const statusResponse = await fetch(`${serverAddress}/pins/${pinResult.requestid}`, {
          headers: { Authorization: 'Bearer test-token' },
        })
        pinStatus = (await statusResponse.json()) as PinResponse
        attempts++
      } while (pinStatus.status !== 'pinned' && pinStatus.status !== 'failed' && attempts < 10)

      expect(pinStatus.status).toBe('pinned')

      // 5. Verify CAR file contains all blocks we expect
      if (pinStatus.info?.car_file_path != null) {
        const carBytes = await readFile(pinStatus.info.car_file_path)
        const reader = await CarReader.fromBytes(carBytes)

        const carBlocks = new Map()
        for await (const { cid, bytes } of reader.blocks()) {
          carBlocks.set(cid.toString(), new Uint8Array(bytes))
        }

        // Should have at least the root block
        expect(carBlocks.has(rootCID.toString())).toBe(true)
        expect(carBlocks.get(rootCID.toString())).toEqual(rootData)
      }
    }, 25000)
  })
})
