import { calibration } from '@filoz/synapse-core/chains'
import { from as pieceFromCID } from '@filoz/synapse-core/piece'
import type { getPDPProvider } from '@filoz/synapse-core/sp-registry'
import type { DataSetInfo } from '@filoz/synapse-core/warm-storage'
import { Synapse } from '@filoz/synapse-sdk'
import { custom, decodeFunctionData, encodeFunctionResult, type Hex, multicall3Abi, stringToHex, toHex } from 'viem'
import { describe, expect, it } from 'vitest'
import { getDetailedDataSet } from '../../core/data-set/get-detailed-data-set.js'
import { listDataSets } from '../../core/data-set/list-data-sets.js'
import { PieceStatus } from '../../core/data-set/types.js'

const ADDRESS = '0x1111111111111111111111111111111111111111'
const PIECE = pieceFromCID('bafkzcibe2hzbcd4t6clvsb3mfrezyxl75gl3gzcsqi42dd27gktq4nk75rr62ciuaq')
const ABI = [
  ...multicall3Abi,
  ...calibration.contracts.fwssView.abi,
  ...calibration.contracts.pdp.abi,
  ...calibration.contracts.serviceProviderRegistry.abi,
] as const

const DATA_SETS: DataSetInfo[] = [1n, 2n].map((id) => ({
  dataSetId: id,
  providerId: id,
  pdpRailId: id,
  cacheMissRailId: 0n,
  cdnRailId: 0n,
  payer: ADDRESS,
  payee: ADDRESS,
  serviceProvider: ADDRESS,
  commissionBps: 0n,
  clientDataSetId: id,
  pdpEndEpoch: 0n,
  pendingOneTimePayments: 0n,
  lifecycleReserveBalance: 0n,
}))

function providerResponse(providerId: bigint, removedProviderActive: boolean): getPDPProvider.ContractOutputType {
  const removed = providerId === 1n
  return {
    providerId,
    providerInfo: {
      serviceProvider: ADDRESS,
      payee: ADDRESS,
      name: removed ? 'Removed offering' : 'Healthy provider',
      description: '',
      isActive: removed ? removedProviderActive : true,
    },
    product: {
      productType: 0,
      isActive: !removed,
      capabilityKeys: removed
        ? []
        : [
            'serviceURL',
            'minPieceSizeInBytes',
            'maxPieceSizeInBytes',
            'storagePricePerTibPerDay',
            'minProvingPeriodInEpochs',
            'location',
            'paymentTokenAddress',
          ],
    },
    productCapabilityValues: removed
      ? []
      : [
          stringToHex('https://provider.example.com'),
          toHex(128n),
          toHex(1024n),
          toHex(1n),
          toHex(30n),
          stringToHex('US'),
          ADDRESS,
        ],
  }
}

function createTestSynapse(removedProviderActive: boolean): Synapse {
  // Mock only RPC responses: exercise the installed synapse-core enrichment and decoding.
  function answer(data: Hex): Hex {
    const call = decodeFunctionData({ abi: ABI, data })
    switch (call.functionName) {
      case 'aggregate3':
        return encodeFunctionResult({
          abi: multicall3Abi,
          functionName: call.functionName,
          result: call.args[0].map(({ callData }) => ({ success: true, returnData: answer(callData) })),
        })
      case 'getClientDataSets':
        return encodeFunctionResult({
          abi: calibration.contracts.fwssView.abi,
          functionName: call.functionName,
          result: DATA_SETS,
        })
      case 'getDataSet': {
        const dataSet = DATA_SETS.find(({ dataSetId }) => dataSetId === call.args[0])
        if (dataSet == null) throw new Error(`Unexpected dataset: ${call.args[0]}`)
        return encodeFunctionResult({
          abi: calibration.contracts.fwssView.abi,
          functionName: call.functionName,
          result: dataSet,
        })
      }
      case 'dataSetLive':
        return encodeFunctionResult({
          abi: calibration.contracts.pdp.abi,
          functionName: call.functionName,
          result: true,
        })
      case 'getDataSetListener':
        return encodeFunctionResult({
          abi: calibration.contracts.pdp.abi,
          functionName: call.functionName,
          result: calibration.contracts.fwss.address,
        })
      case 'getAllDataSetMetadata':
        return encodeFunctionResult({
          abi: calibration.contracts.fwssView.abi,
          functionName: call.functionName,
          result: [
            ['source', 'withIPFSIndexing'],
            ['filecoin-pin', ''],
          ],
        })
      case 'getDataSetLeafCount':
        return encodeFunctionResult({ abi: calibration.contracts.pdp.abi, functionName: call.functionName, result: 1n })
      case 'getScheduledRemovals':
        return encodeFunctionResult({ abi: calibration.contracts.pdp.abi, functionName: call.functionName, result: [] })
      case 'getActivePiecesByCursor':
        return encodeFunctionResult({
          abi: calibration.contracts.pdp.abi,
          functionName: call.functionName,
          result: [[{ data: PIECE.toHex() }], [0n], false],
        })
      case 'getProviderWithProduct':
        return encodeFunctionResult({
          abi: calibration.contracts.serviceProviderRegistry.abi,
          functionName: call.functionName,
          result: providerResponse(call.args[0], removedProviderActive),
        })
      default:
        throw new Error(`Unexpected contract call: ${call.functionName}`)
    }
  }

  return Synapse.create({
    chain: calibration,
    account: ADDRESS,
    source: 'filecoin-pin',
    pieceBatching: false,
    transport: custom({
      async request({ method, params }) {
        if (method !== 'eth_call') throw new Error(`Unexpected RPC method: ${method}`)
        return answer(params[0].data)
      },
    }),
  })
}

describe('listDataSets with real synapse-core', () => {
  it.each([
    { removed: 'provider registration', providerActive: false },
    { removed: 'PDP product', providerActive: true },
  ])('retains datasets after removal of their $removed', async ({ providerActive }) => {
    const dataSets = await listDataSets(createTestSynapse(providerActive))

    expect(dataSets.map(({ dataSetId }) => dataSetId)).toEqual([1n, 2n])
    expect(dataSets[0]).toMatchObject({
      providerId: 1n,
      isLive: true,
      hasActivePieces: true,
      createdWithFilecoinPin: true,
      metadata: { source: 'filecoin-pin', withIPFSIndexing: '' },
    })
    expect(dataSets[0]?.provider).toBeUndefined()
    expect(dataSets[1]?.provider).toMatchObject({ id: 2n, pdp: { serviceURL: 'https://provider.example.com' } })
  })

  it('retrieves on-chain pieces when the detailed dataset has no provider offering', async () => {
    const dataSet = await getDetailedDataSet(createTestSynapse(false), 1n)

    expect(dataSet.provider).toBeUndefined()
    expect(dataSet.pieces).toEqual([
      { pieceId: 0n, pieceCid: PIECE.toString(), status: PieceStatus.ACTIVE, size: PIECE.size },
    ])
    expect(dataSet.totalSizeBytes).toBe(BigInt(PIECE.size))
  })
})
