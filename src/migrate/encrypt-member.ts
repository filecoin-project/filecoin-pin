/**
 * `migrate --encrypt`: a verified member CAR becomes the plaintext of an `add --encrypt` envelope,
 * packed as `<source-cid>.car`, so `get <stored-cid>` restores the exact source CAR.
 */

import { createReadStream } from 'node:fs'
import { rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import type { WriteTarget } from '@filoz/keysmith'
import { encryptPath } from '../common/encryption.js'
import { newPieceKey } from '../common/group-key.js'
import { createCarFromPath } from '../core/unixfs/car-builder.js'
import { type StagedMember, verifyCarStream } from './verify-car.js'

const discard = { write: async () => undefined, end: async () => undefined }

/** Encrypt `member` under a fresh key from `target`; the plaintext member file is removed either way. */
export async function encryptMember(
  member: StagedMember,
  target: WriteTarget
): Promise<StagedMember & { storedCid: string }> {
  const dir = dirname(member.memberCarPath)
  const envelope = join(dir, `${member.cid}.fee.tmp`)
  let tempCar: string | undefined
  try {
    // ponytail: envelope and outer CAR are staged next to the member outside the budget, ~2x the member at peak
    const key = newPieceKey(target)
    await encryptPath(member.memberCarPath, envelope, key).finally(() => key.cek.fill(0))
    const { carPath, rootCid } = await createCarFromPath(envelope, { tempDir: dir })
    tempCar = carPath
    const verified = await verifyCarStream(
      Readable.toWeb(createReadStream(carPath)) as ReadableStream<Uint8Array>,
      rootCid,
      discard
    )
    const storedCid = rootCid.toString()
    const memberCarPath = join(dir, `${storedCid}.car`)
    await rename(carPath, memberCarPath)
    tempCar = undefined
    return {
      ...member,
      pieceCid: verified.pieceCid,
      rawSize: verified.rawSize,
      memberCarPath,
      memberSha256: verified.sha256,
      storedCid,
    }
  } finally {
    for (const path of [envelope, tempCar, member.memberCarPath]) {
      if (path != null) await unlink(path).catch(() => undefined)
    }
  }
}
