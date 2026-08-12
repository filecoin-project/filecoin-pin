/**
 * Migration manifest: one JSON document mapping every source CID to the piece
 * it migrated into, with the on-chain coordinates (data set ids, tx hashes)
 * and run info. The manifest is imported through the UnixFS/CAR path so it
 * has a retrievable root CID of its own, then uploaded as a final piece
 * tagged `migrationManifest: 'true'`.
 */

import { mkdtemp, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CID } from 'multiformats/cid'
import { cleanupTempCar, createCarFromPath } from '../core/unixfs/index.js'
import type { MigrationDB } from './db.js'
import type { DirectUploadDeps, DirectUploadSummary, UploadContextLike } from './direct-upload.js'
import { log } from './util.js'

/** Piece metadata key marking the manifest piece in the data set. */
export const MANIFEST_PIECE_METADATA = { migrationManifest: 'true' } as const

export interface ManifestPieceEntry {
  pieceCid: string
  /** Source CIDs packed into this piece, in canonical order. */
  members: string[]
  uploads: Array<{
    providerId: string
    role: string
    status: string
    dataSetId: string | null
    pieceId: string | null
    txHash: string | null
  }>
}

export interface MigrationManifest {
  version: 1
  network: string
  createdAt: string
  /** Source CID -> the piece CID it was packed into. */
  sources: Record<string, string>
  /** Source CIDs that failed the commP pass, with their recorded errors. */
  failures: Array<{ cid: string; error: string; category: string }>
  pieces: ManifestPieceEntry[]
  summary: DirectUploadSummary
}

/** Assemble the manifest document from the state DB. */
export function buildManifest(db: MigrationDB, summary: DirectUploadSummary, createdAt: string): MigrationManifest {
  const sources: Record<string, string> = {}
  const pieces: ManifestPieceEntry[] = []
  for (const sub of db.subPiecesByStatus('built')) {
    const members = db.subPieceMemberCids(sub.subPieceCid)
    for (const member of members) {
      sources[member] = sub.subPieceCid
    }
    pieces.push({
      pieceCid: sub.subPieceCid,
      members,
      uploads: db.uploadsForSubPiece(sub.subPieceCid).map((u) => ({
        providerId: u.providerId,
        role: u.role,
        status: u.status,
        dataSetId: u.dataSetId,
        pieceId: u.pieceId,
        txHash: u.txHash,
      })),
    })
  }
  return {
    version: 1,
    network: db.network,
    createdAt,
    sources,
    failures: db.failures(),
    pieces,
    summary,
  }
}

export interface ManifestUploadResult {
  /** IPFS root CID of the manifest file (retrievable by CID). */
  rootCid: string
  /** PieceCID v2 of the manifest CAR as stored on the providers. */
  pieceCid: string
  /** Per-provider commit tx hashes. */
  txHashes: string[]
}

/**
 * Import the manifest through the UnixFS/CAR path (so it has a retrievable
 * root CID), store it on every context, and commit it immediately as one
 * piece tagged `migrationManifest: 'true'`. One piece is well under any batch
 * threshold, so the commit is not deferred to the GC-window scheduler.
 */
export async function uploadManifest(
  manifest: MigrationManifest,
  contexts: UploadContextLike[],
  deps: Pick<DirectUploadDeps, 'openCar'>
): Promise<ManifestUploadResult> {
  const [primary, ...secondaries] = contexts
  if (primary == null) throw new Error('no storage context for the manifest upload')

  const dir = await mkdtemp(join(tmpdir(), 'filecoin-pin-manifest-'))
  const jsonPath = join(dir, 'migration-manifest.json')
  await writeFile(jsonPath, `${JSON.stringify(manifest, null, 2)}\n`)

  const { carPath, rootCid } = await createCarFromPath(jsonPath)
  try {
    const stored = await primary.store(deps.openCar(carPath), {})
    const pieceCid = String(stored.pieceCid)
    log(`manifest stored on primary ${primary.providerId} (piece ${pieceCid}, root ${rootCid.toString()})`)

    for (const secondary of secondaries) {
      try {
        const extraData = await secondary.presignForCommit([{ pieceCid: CID.parse(pieceCid) }])
        await secondary.pull({
          pieces: [CID.parse(pieceCid)],
          from: (pc) => primary.getPieceUrl(pc),
          extraData,
        })
      } catch (err) {
        log(`warn: secondary ${secondary.providerId} failed to pull the manifest: ${(err as Error).message}`)
      }
    }

    const txHashes: string[] = []
    for (const ctx of contexts) {
      try {
        const result = await ctx.commit({
          pieces: [{ pieceCid: CID.parse(pieceCid), pieceMetadata: { ...MANIFEST_PIECE_METADATA } }],
        })
        txHashes.push(result.txHash)
        log(`manifest committed on provider ${ctx.providerId} (data set ${result.dataSetId}, tx ${result.txHash})`)
      } catch (err) {
        log(`warn: manifest commit failed on provider ${ctx.providerId}: ${(err as Error).message}`)
      }
    }

    return { rootCid: rootCid.toString(), pieceCid, txHashes }
  } finally {
    await cleanupTempCar(carPath)
    await unlink(jsonPath).catch(() => undefined)
  }
}
