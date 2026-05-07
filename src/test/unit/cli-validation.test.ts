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
    expect(() => parseContextSelectionOptions({ providerIds: ',' })).toThrow(/Invalid provider ID/)
  })

  it('throws on a comma-only data set list rather than returning []', () => {
    expect(() => parseContextSelectionOptions({ dataSetIds: ',,' })).toThrow(/Invalid data set ID/)
  })
})
