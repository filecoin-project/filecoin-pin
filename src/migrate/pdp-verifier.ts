/**
 * Read-only PDPVerifier access for reconciling a migrate run's on-chain
 * state. The ABI and contract address come from the connected chain via
 * `@filoz/synapse-core`.
 */

import { pdp as PDP_ABI } from '@filoz/synapse-core/abis'
import { findPieceIdsByCid } from '@filoz/synapse-core/pdp-verifier'
import { from as pieceCidFrom } from '@filoz/synapse-core/piece'
import type { Synapse } from '@filoz/synapse-sdk'
import { type Hash, type Hex, parseEventLogs, TransactionReceiptNotFoundError } from 'viem'

/**
 * The on-chain PiecesAdded event parsed from an AddPieces tx receipt.
 * PDPVerifier emits one event per AddPieces call carrying parallel arrays of
 * pieceIds + pieceCids (event `PiecesAdded(uint256 indexed setId, uint256[]
 * pieceIds, struct Cids.Cid[] pieceCids)`); `dataSetId` is the event's own
 * setId, so a caller that lost track of its data set can recover it from
 * the receipt.
 */
export interface AddPiecesEvent {
  dataSetId: bigint
  blockNumber: bigint
  pieceIds: bigint[]
  pieceCids: string[]
}

/**
 * The on-chain piece id of `pieceCid` in `dataSetId`, or null when the data
 * set does not contain it. One contract read; used to resolve an
 * add_unconfirmed row that never captured its transaction hash. `dataSetId`
 * stays a string end to end: on-chain set ids are uint256 and `Number`
 * would silently truncate.
 */
export async function dataSetPieceId(synapse: Synapse, dataSetId: string, pieceCid: string): Promise<string | null> {
  const ids = await findPieceIdsByCid(synapse.client as never, {
    dataSetId: BigInt(dataSetId),
    pieceCid: pieceCidFrom(pieceCid),
  })
  const first = ids[0]
  return first == null ? null : String(first)
}

/**
 * Whether a transaction landed successfully on chain (receipt status
 * success). Only a definitive missing receipt maps to false; any other
 * error (RPC 5xx, rate limit, timeout) propagates, because callers make
 * re-add decisions on a false and a transient blip must not look like a
 * dead transaction.
 */
export async function txLanded(synapse: Synapse, txHash: string): Promise<boolean> {
  try {
    const receipt = await synapse.client.getTransactionReceipt({ hash: txHash as Hash })
    return receipt.status === 'success'
  } catch (err) {
    if (err instanceof TransactionReceiptNotFoundError) return false
    throw err
  }
}

/**
 * Fetch and parse the PiecesAdded event out of an AddPieces tx receipt.
 * When `dataSetId` is known it must match the event's setId; when null (a
 * crash before the first commit of a new data set recorded one) any
 * PDPVerifier-emitted event in the receipt matches and its setId is
 * returned. Returns null when the receipt carries no matching event (a
 * reverted inner call leaves no PiecesAdded log even when the tx itself
 * succeeded).
 */
export async function fetchAddPiecesEvent(
  synapse: Synapse,
  txHash: string,
  dataSetId: string | null
): Promise<AddPiecesEvent | null> {
  const pdpAddress = synapse.chain.contracts.pdp.address
  const receipt = await synapse.client.waitForTransactionReceipt({ hash: txHash as Hash })
  const events = parseEventLogs({
    abi: PDP_ABI,
    eventName: 'PiecesAdded',
    logs: receipt.logs,
  })
  const target = dataSetId == null ? null : BigInt(dataSetId)
  const match = events.find(
    (ev) => ev.address.toLowerCase() === pdpAddress.toLowerCase() && (target == null || ev.args.setId === target)
  )
  if (match == null) return null
  const pieceCids = match.args.pieceCids.map((p: { data: Hex }) => pieceCidFrom(p.data).toString())
  return {
    dataSetId: match.args.setId,
    blockNumber: receipt.blockNumber,
    pieceIds: [...match.args.pieceIds],
    pieceCids,
  }
}
