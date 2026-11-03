import { from as pieceCidFrom } from '@filoz/synapse-core/piece'
import type { Synapse } from '@filoz/synapse-sdk'
import { describe, expect, it } from 'vitest'
import { fetchAddPiecesEvent } from '../../migrate/pdp-verifier.js'

// A real calibnet receipt log: PDPVerifier 0x85e3..417C, tx 0xaeb81eb8..., one
// piece added to data set 0x5554 as piece 0x22b. The deployed contract emits
// PiecesAddedV2 (firstPieceId + packed CIDs) and never the legacy PiecesAdded.
const PDP = '0x85e366Cf9DD2c0aE37E963d9556F5f4718d6417C'
const V2_LOG = {
  address: PDP.toLowerCase(),
  topics: [
    '0xf940e16e56c59d7821a2d55055b93909607d378871e741e763798717d8924579',
    '0x0000000000000000000000000000000000000000000000000000000000005554',
  ],
  data:
    '0x000000000000000000000000000000000000000000000000000000000000022b' +
    '0000000000000000000000000000000000000000000000000000000000000040' +
    '0000000000000000000000000000000000000000000000000000000000000001' +
    '0000000000000000000000000000000000000000000001559120259cf8f70213' +
    '829ecafb70cab707967b9702f176bb35e2ed07adde5fc604d42a80f572fbbc17',
  blockNumber: 100n,
  transactionHash: '0xaeb81eb8ba3a43c66054978d5d7bf43e17ac9472383d03f9c9901b90b727e8b3',
  logIndex: 0,
  transactionIndex: 0,
  blockHash: '0x00',
  removed: false,
}

function synapseWith(logs: unknown[]): Synapse {
  return {
    chain: { contracts: { pdp: { address: PDP } } },
    client: { waitForTransactionReceipt: async () => ({ logs, blockNumber: 100n }) },
  } as unknown as Synapse
}

describe('fetchAddPiecesEvent', () => {
  it('decodes PiecesAddedV2: piece ids from firstPieceId, piece CIDs from the packed header and root', async () => {
    const event = await fetchAddPiecesEvent(synapseWith([V2_LOG]), V2_LOG.transactionHash, null)

    expect(event).toMatchObject({ dataSetId: 0x5554n, pieceIds: [0x22bn], blockNumber: 100n })
    const [cid] = event?.pieceCids ?? []
    expect(cid).toMatch(/^bafkzcib/)
    expect(pieceCidFrom(cid ?? '').toString()).toBe(cid)
  })

  it('matches on the data set id when one is known', async () => {
    await expect(fetchAddPiecesEvent(synapseWith([V2_LOG]), V2_LOG.transactionHash, '21844')).resolves.toMatchObject({
      dataSetId: 21844n,
    })
    await expect(fetchAddPiecesEvent(synapseWith([V2_LOG]), V2_LOG.transactionHash, '7')).resolves.toBeNull()
  })

  it('ignores the event from another contract', async () => {
    const other = { ...V2_LOG, address: '0x0000000000000000000000000000000000000001' }
    await expect(fetchAddPiecesEvent(synapseWith([other]), V2_LOG.transactionHash, null)).resolves.toBeNull()
  })
})
