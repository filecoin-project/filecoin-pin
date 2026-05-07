import { asyncIterableReader, createDecoder } from '@ipld/car/decoder'

export const INPUT_IS_CAR = 'INPUT_IS_CAR'

/**
 * Returns true iff `source` begins with a valid CARv1 or CARv2 header.
 * Consumes only header bytes; the source is left partially drained and the
 * caller is expected to discard it.
 *
 * Accepts either an `AsyncIterable<Uint8Array>` (Node streams, async
 * generators) or a `ReadableStream<Uint8Array>` (Web streams). The
 * `ReadableStream` form covers browsers where `Symbol.asyncIterator` on
 * web streams is not yet universal.
 */
export async function isCar(source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>): Promise<boolean> {
  const iter =
    (source as any)[Symbol.asyncIterator] != null
      ? (source as AsyncIterable<Uint8Array>)
      : fromReadableStream(source as ReadableStream<Uint8Array>)
  try {
    await createDecoder(asyncIterableReader(iter)).header()
    return true
  } catch {
    return false
  }
}

export function carInputError(filePath?: string): Error & { code: typeof INPUT_IS_CAR } {
  const where = filePath ? `: ${filePath}` : ''
  const err = new Error(`Input appears to be a CAR file${where}. Use 'filecoin-pin import' to upload it as-is.`)
  return Object.assign(err, { code: INPUT_IS_CAR as typeof INPUT_IS_CAR })
}

async function* fromReadableStream(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      if (value) yield value
    }
  } finally {
    reader.releaseLock()
  }
}
