import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseContextSelectionOptions } from '../../utils/cli-auth.js'

describe('parseContextSelectionOptions empty-list regression', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    delete process.env.PROVIDER_IDS
    delete process.env.DATA_SET_IDS
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  // Without this guard, callers in src/add/add.ts and src/import/import.ts set
  // autoFundOptions.copies = providerIds.length, which would silently become 0.
  it('throws on a comma-only provider list rather than returning []', () => {
    expect(() => parseContextSelectionOptions({ providerIds: [','] })).toThrow(/Invalid provider ID/)
  })

  it('throws on a comma-only data set list rather than returning []', () => {
    expect(() => parseContextSelectionOptions({ dataSetIds: [',,'] })).toThrow(/Invalid data set ID/)
  })
})

describe('parseContextSelectionOptions unified ID flags', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    delete process.env.PROVIDER_IDS
    delete process.env.DATA_SET_IDS
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('parses the canonical repeatable --provider-id flag', () => {
    expect(parseContextSelectionOptions({ providerIds: ['7', '9'] })).toEqual({ providerIds: [7n, 9n] })
  })

  it('parses the canonical repeatable --data-set-id flag', () => {
    expect(parseContextSelectionOptions({ dataSetIds: ['12', '34'] })).toEqual({ dataSetIds: [12n, 34n] })
  })

  it('accepts the deprecated comma-separated --provider-ids alias (merged into providerIds)', () => {
    expect(parseContextSelectionOptions({ providerIds: ['1,2,3'] })).toEqual({ providerIds: [1n, 2n, 3n] })
  })

  it('accepts the deprecated single-value --data-set alias (merged into dataSetIds)', () => {
    expect(parseContextSelectionOptions({ dataSetIds: ['42'] })).toEqual({ dataSetIds: [42n] })
  })

  it('reads PROVIDER_IDS from the environment', () => {
    process.env.PROVIDER_IDS = '5,6'
    expect(parseContextSelectionOptions()).toEqual({ providerIds: [5n, 6n] })
  })

  it('reads DATA_SET_IDS from the environment', () => {
    process.env.DATA_SET_IDS = '8'
    expect(parseContextSelectionOptions()).toEqual({ dataSetIds: [8n] })
  })

  it('rejects providing both provider and data set selection', () => {
    expect(() => parseContextSelectionOptions({ providerIds: ['1'], dataSetIds: ['2'] })).toThrow(/Cannot specify both/)
  })

  it('rejects duplicate IDs', () => {
    expect(() => parseContextSelectionOptions({ providerIds: ['1', '1'] })).toThrow(/Duplicate provider ID/)
  })

  it('returns an empty selection when nothing is provided', () => {
    expect(parseContextSelectionOptions({})).toEqual({})
  })
})
