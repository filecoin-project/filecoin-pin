import { createReadStream } from 'node:fs'
import { asyncIterableReader, createDecoder } from '@ipld/car/decoder'

export async function isCarFile(filePath: string): Promise<boolean> {
  let stream: ReturnType<typeof createReadStream> | undefined

  try {
    stream = createReadStream(filePath)
    const reader = asyncIterableReader(stream)
    const decoder = createDecoder(reader)
    const header = await decoder.header()
    return !!(header && header.version === 1 && header.roots)
  } catch (error) {
    return false
  } finally {
    if (stream) {
      stream.destroy()
    }
  }
}