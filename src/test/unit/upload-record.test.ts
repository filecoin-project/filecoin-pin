import { appendFileSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PieceMetadata } from '@filoz/keysmith'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findEncryptedUpload, recordEncryptedUpload, UPLOAD_RECORD_FILE } from '../../common/upload-record.js'

const labels = (salt: string): PieceMetadata => ({
  'foc/v': 1,
  'foc/own': '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  'foc/ks': '0x02ca08cf7e0222c8432adc159232b7eb',
  'foc/salt': salt as `0x${string}`,
})

describe('upload record', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'upload-record-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('finds a recorded upload by its root CID, owner-only, and the latest record wins', () => {
    expect(findEncryptedUpload('bafyroot', dir)).toBeUndefined()
    recordEncryptedUpload({ rootCid: 'bafyroot', pieceCid: 'bafkold', labels: labels('0x01') }, dir)
    recordEncryptedUpload({ rootCid: 'bafyother', pieceCid: 'bafkother', labels: labels('0x02') }, dir)
    recordEncryptedUpload({ rootCid: 'bafyroot', pieceCid: 'bafknew', labels: labels('0x03') }, dir)
    expect(findEncryptedUpload('bafyroot', dir)).toEqual({
      rootCid: 'bafyroot',
      pieceCid: 'bafknew',
      labels: labels('0x03'),
    })
    expect(statSync(join(dir, UPLOAD_RECORD_FILE)).mode & 0o777).toBe(0o600)
  })

  it('skips damaged or incomplete lines rather than failing', () => {
    recordEncryptedUpload({ rootCid: 'bafyroot', pieceCid: 'bafkgood', labels: labels('0x01') }, dir)
    const file = join(dir, UPLOAD_RECORD_FILE)
    appendFileSync(file, '{"v":1,"rootCid":"bafyroot","pieceCid":"bafkbad"\n') // cut off mid-write
    appendFileSync(file, `${JSON.stringify({ v: 1, rootCid: 'bafyroot', pieceCid: 'bafknolabels' })}\n`)
    appendFileSync(
      file,
      `${JSON.stringify({ v: 2, rootCid: 'bafyroot', pieceCid: 'bafkv2', labels: labels('0x09') })}\n`
    )
    expect(findEncryptedUpload('bafyroot', dir)?.pieceCid).toBe('bafkgood')
  })
})
