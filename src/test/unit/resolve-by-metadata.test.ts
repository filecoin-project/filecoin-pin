import { describe, expect, it, vi } from 'vitest'
import { resolveDataSetIdsByMetadata } from '../../core/data-set/resolve-by-metadata.js'

const mockListDataSets = vi.fn()

vi.mock('../../core/data-set/list-data-sets.js', () => ({
  listDataSets: (...args: unknown[]) => mockListDataSets(...args),
}))

const fakeSynapse = {} as any

function dataSet(id: bigint, metadata: Record<string, string>): any {
  return { dataSetId: id, isLive: true, metadata }
}

describe('resolveDataSetIdsByMetadata', () => {
  it('returns no-match when requested metadata is empty', async () => {
    const result = await resolveDataSetIdsByMetadata(fakeSynapse, {}, { expectedCopies: 2 })
    expect(result).toEqual({ kind: 'no-match' })
    expect(mockListDataSets).not.toHaveBeenCalled()
  })

  it('returns matched when subset matches expected copy count', async () => {
    mockListDataSets.mockResolvedValueOnce([
      dataSet(13260n, { source: 'storacha-migration', 'space-did': 'did:key:abc', withIPFSIndexing: '' }),
      dataSet(13261n, { source: 'storacha-migration', 'space-did': 'did:key:abc', withIPFSIndexing: '' }),
    ])

    const result = await resolveDataSetIdsByMetadata(
      fakeSynapse,
      { source: 'storacha-migration', 'space-did': 'did:key:abc' },
      { expectedCopies: 2 }
    )

    expect(result).toEqual({ kind: 'matched', dataSetIds: [13260n, 13261n] })
  })

  it('returns ambiguous when more datasets match than expected', async () => {
    mockListDataSets.mockResolvedValueOnce([
      dataSet(1n, { source: 'storacha-migration' }),
      dataSet(2n, { source: 'storacha-migration' }),
      dataSet(3n, { source: 'storacha-migration' }),
      dataSet(4n, { source: 'storacha-migration' }),
    ])

    const result = await resolveDataSetIdsByMetadata(
      fakeSynapse,
      { source: 'storacha-migration' },
      { expectedCopies: 2 }
    )

    expect(result).toEqual({ kind: 'ambiguous', matchedIds: [1n, 2n, 3n, 4n], expected: 2 })
  })

  it('returns no-match when zero datasets match (lets SDK create new)', async () => {
    mockListDataSets.mockResolvedValueOnce([])

    const result = await resolveDataSetIdsByMetadata(
      fakeSynapse,
      { source: 'something-new' },
      { expectedCopies: 2 }
    )

    expect(result).toEqual({ kind: 'no-match' })
  })
})
