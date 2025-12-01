import { createWriteStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { CarWriter } from '@ipld/car'
import { describe, expect, it } from 'vitest'
import { isCarFile } from '../../utils/car-detection.js'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'

describe('isCarFile', () => {
    const tempDir = process.cwd()
    const validCarPath = join(tempDir, 'valid.car')
    const invalidCarPath = join(tempDir, 'invalid.car')
    const textFilePath = join(tempDir, 'text.txt')

    it('should return true for a valid CAR file', async () => {
        // Create a valid CAR file
        const { out, writer } = await CarWriter.create([
            CID.create(1, raw.code, await sha256.digest(new Uint8Array([1, 2, 3])))
        ])
        const { Readable } = await import('node:stream')
        const stream = createWriteStream(validCarPath)
        await new Promise<void>((resolve, reject) => {
            Readable.from(out).pipe(stream)
            stream.on('error', reject)
            stream.on('finish', () => resolve())
            writer.close()
        })

        expect(await isCarFile(validCarPath)).toBe(true)
    })

    it('should return false for a text file', async () => {
        const stream = createWriteStream(textFilePath)
        stream.write('This is just a text file')
        stream.end()
        await new Promise<void>((resolve) => stream.on('finish', () => resolve()))

        expect(await isCarFile(textFilePath)).toBe(false)
    })

    it('should return false for a random binary file', async () => {
        const stream = createWriteStream(invalidCarPath)
        stream.write(Buffer.from([0, 1, 2, 3, 4, 5]))
        stream.end()
        await new Promise<void>((resolve) => stream.on('finish', () => resolve()))

        expect(await isCarFile(invalidCarPath)).toBe(false)
    })

    // Cleanup
    it('cleanup', async () => {
        try { await unlink(validCarPath) } catch { }
        try { await unlink(textFilePath) } catch { }
        try { await unlink(invalidCarPath) } catch { }
    })
})
