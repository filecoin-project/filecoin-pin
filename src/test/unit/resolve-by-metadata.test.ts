import { describe, expect, it, vi } from 'vitest'
import { resolveDataSetIdsByMetadata } from '../../core/data-set/resolve-by-metadata.js'

const mockListDataSets = vi.fn()

vi.mock('../../core/data-set/list-data-sets.js', () => ({
  listDataSets: (...args: unknown[]) => mockListDataSets(...args),
}))

const fakeSynapse = {} as any

function dataSet(id: bigint, metadata: Record<string, string>, isLive = true): any {
  return { dataSetId: id, isLive, metadata }
}

/**
 * Wire the mock to actually invoke the resolver-supplied filter callback against a
 * raw fixture list. Without this, `mockResolvedValueOnce([...])` returns a pre-filtered
 * array and the resolver's subset-matching logic never runs in the test.
 */
function withFixtures(fixtures: any[]): void {
  mockListDataSets.mockImplementationOnce(async (_synapse: unknown, opts: { filter?: (ds: any) => boolean }) => {
    if (opts?.filter == null) {
      return fixtures
    }
    return fixtures.filter(opts.filter)
  })
}

describe('resolveDataSetIdsByMetadata', () => {
  it('short-circuits without querying when requested metadata is empty', async () => {
    const result = await resolveDataSetIdsByMetadata(fakeSynapse, {}, { expectedCopies: 2 })
    expect(result).toEqual({ kind: 'no-match' })
    expect(mockListDataSets).not.toHaveBeenCalled()
  })

  it('returns matched when subset matches expected copy count', async () => {
    withFixtures([
      dataSet(13260n, { source: 'storacha-migration', 'space-did': 'did:key:abc', withIPFSIndexing: '' }),
      dataSet(13261n, { source: 'storacha-migration', 'space-did': 'did:key:abc', withIPFSIndexing: '' }),
      dataSet(99n, { source: 'storacha-migration', 'space-did': 'did:key:other', withIPFSIndexing: '' }),
      dataSet(100n, { source: 'filecoin-pin', withIPFSIndexing: '' }),
    ])

    const result = await resolveDataSetIdsByMetadata(
      fakeSynapse,
      { source: 'storacha-migration', 'space-did': 'did:key:abc' },
      { expectedCopies: 2 }
    )

    expect(result).toEqual({ kind: 'matched', dataSetIds: [13260n, 13261n] })
  })

  it('returns too-many-matches when more datasets match than expected', async () => {
    withFixtures([
      dataSet(1n, { source: 'storacha-migration' }),
      dataSet(2n, { source: 'storacha-migration' }),
      dataSet(3n, { source: 'storacha-migration' }),
      dataSet(4n, { source: 'storacha-migration' }),
      dataSet(5n, { source: 'filecoin-pin' }),
    ])

    const result = await resolveDataSetIdsByMetadata(
      fakeSynapse,
      { source: 'storacha-migration' },
      { expectedCopies: 2 }
    )

    expect(result).toEqual({ kind: 'too-many-matches', matchedIds: [1n, 2n, 3n, 4n], expected: 2 })
  })

  it('returns too-few-matches when fewer datasets match than expected', async () => {
    withFixtures([dataSet(1n, { source: 'storacha-migration' }), dataSet(2n, { source: 'filecoin-pin' })])

    const result = await resolveDataSetIdsByMetadata(
      fakeSynapse,
      { source: 'storacha-migration' },
      { expectedCopies: 2 }
    )

    expect(result).toEqual({ kind: 'too-few-matches', matchedIds: [1n], expected: 2 })
  })

  it('returns no-match when zero datasets match (lets SDK create new)', async () => {
    withFixtures([dataSet(1n, { source: 'filecoin-pin' }), dataSet(2n, { source: 'storacha-migration' })])

    const result = await resolveDataSetIdsByMetadata(fakeSynapse, { source: 'something-new' }, { expectedCopies: 2 })

    expect(result).toEqual({ kind: 'no-match' })
  })

  it('does not match datasets that lack the requested key (empty-string value gotcha)', async () => {
    /**
     * Without the `key in metadata` guard, the resolver would treat the missing
     * `customTag` as `''` and falsely match the second dataset.
     */
    withFixtures([
      dataSet(1n, { source: 'storacha-migration', customTag: '' }),
      dataSet(2n, { source: 'storacha-migration' }),
    ])

    const result = await resolveDataSetIdsByMetadata(
      fakeSynapse,
      { source: 'storacha-migration', customTag: '' },
      { expectedCopies: 1 }
    )

    expect(result).toEqual({ kind: 'matched', dataSetIds: [1n] })
  })

  it('skips non-live datasets even if metadata matches', async () => {
    withFixtures([
      dataSet(1n, { source: 'storacha-migration' }, false),
      dataSet(2n, { source: 'storacha-migration' }, true),
    ])

    const result = await resolveDataSetIdsByMetadata(
      fakeSynapse,
      { source: 'storacha-migration' },
      { expectedCopies: 1 }
    )

    expect(result).toEqual({ kind: 'matched', dataSetIds: [2n] })
  })
})
