import { CID } from 'multiformats/cid'
import { describe, expect, it, vi } from 'vitest'
import { performUpload } from '../../common/upload-flow.js'
import { createLogger } from '../../logger.js'

const mocks = vi.hoisted(() => ({
  executeUpload: vi.fn(),
}))

vi.mock('../../core/upload/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../core/upload/index.js')>('../../core/upload/index.js')
  return {
    ...actual,
    executeUpload: mocks.executeUpload,
  }
})

const TEST_CID = CID.parse('bafkreia5fn4rmshmb7cl7fufkpcw733b5anhuhydtqstnglpkzosqln5kq')

describe('performUpload', () => {
  it('updates the spinner with byte-level upload progress', async () => {
    const spinner = {
      start: vi.fn(),
      message: vi.fn(),
      stop: vi.fn(),
      clear: vi.fn(),
    }

    mocks.executeUpload.mockImplementation(async (_synapse, _data, _rootCid, options) => {
      options.onProgress?.({ type: 'onProgress', data: { bytesUploaded: 2 } })
      options.onProgress?.({
        type: 'onStored',
        data: {
          providerId: 1n,
          pieceCid: 'bafkzcibtest123',
        },
      })

      return {
        pieceCid: 'bafkzcibtest123',
        size: 4,
        requestedCopies: 1,
        complete: true,
        copies: [
          {
            providerId: 1n,
            dataSetId: 123n,
            pieceId: 456n,
            role: 'primary',
            retrievalUrl: 'https://provider.example/piece/test',
            isNewDataSet: false,
          },
        ],
        failedAttempts: [],
        network: 'calibration',
      }
    })

    await performUpload({ chain: { id: 314159, name: 'calibration' } } as any, new Uint8Array([1, 2, 3, 4]), TEST_CID, {
      contextType: 'add',
      fileSize: 4,
      logger: createLogger({ logLevel: 'info' }),
      spinner,
      skipIpniVerification: true,
    })

    expect(spinner.start).toHaveBeenCalledWith('Uploading to Filecoin...')
    expect(spinner.message).toHaveBeenCalledWith('Uploading to Filecoin... 2.0 B/4.0 B (50%)')
    expect(spinner.stop).toHaveBeenCalledWith(expect.stringContaining('Stored on provider 1'))
  })
})
