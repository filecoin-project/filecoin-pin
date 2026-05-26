import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  executeUpload: vi.fn(),
}))

// Keep the real `calculateFilecoinPayFundingPlan`/`formatFundingReason` so a
// `handlePayments` test actually exercises the funding planner (and would catch
// missing required args like `minimumPricePerMonth`). Only the IO-bound helpers
// are mocked.
vi.mock('filecoin-pin/core/payments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('filecoin-pin/core/payments')>()
  return {
    ...actual,
    executeTopUp: vi.fn(),
    getPaymentStatus: vi.fn(),
    getServicePrice: vi.fn(),
    getStorageRunway: vi.fn(),
  }
})

vi.mock('filecoin-pin/core/unixfs', () => ({
  createUnixfsCarBuilder: vi.fn(),
}))

vi.mock('filecoin-pin/core/upload', () => ({
  executeUpload: mocks.executeUpload,
}))

vi.mock('filecoin-pin/core/utils', () => ({
  formatRunwaySummary: vi.fn(),
  formatUSDFC: vi.fn((value: bigint) => value.toString()),
}))

const TEST_CID = 'bafkreia5fn4rmshmb7cl7fufkpcw733b5anhuhydtqstnglpkzosqln5kq'
const inputsModulePath: string = '../../../upload-action/src/inputs.js'
const filecoinModulePath: string = '../../../upload-action/src/filecoin.js'
const commentsModulePath: string = '../../../upload-action/src/comments/comment.js'

interface ParseInputsModule {
  parseInputs: (phase?: string) => {
    walletPrivateKey?: string
    contentPath: string
    network: 'mainnet' | 'calibration'
    dryRun: boolean
  }
}

interface FilecoinModule {
  uploadCarToFilecoin: (
    synapse: unknown,
    carPath: string,
    ipfsRootCid: string,
    options: { withCDN: boolean; providerIds?: bigint[] },
    logger: unknown
  ) => Promise<{
    dataSetId: string
    pieceId: string
    provider: { id?: string; name?: string }
    previewUrl: string
    requestedCopies: number
    complete: boolean
  }>
}

interface CommentsModule {
  commentOnPR: (context: {
    ipfsRootCid: string
    dataSetId: string
    pieceCid: string
    dryRun?: boolean
    pr?: { number: number }
    uploadStatus?: string
  }) => Promise<void>
}

describe('upload action inputs', () => {
  const originalInputsJson = process.env.INPUTS_JSON

  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    if (originalInputsJson == null) {
      delete process.env.INPUTS_JSON
    } else {
      process.env.INPUTS_JSON = originalInputsJson
    }
  })

  it('allows dry-run uploads without a wallet private key', async () => {
    process.env.INPUTS_JSON = JSON.stringify({
      path: './dist',
      network: 'calibration',
      dryRun: true,
    })

    const { parseInputs } = (await import(inputsModulePath)) as ParseInputsModule

    expect(parseInputs('upload')).toMatchObject({
      walletPrivateKey: '',
      contentPath: './dist',
      network: 'calibration',
      dryRun: true,
    })
  })

  it('still requires a wallet private key for real uploads', async () => {
    process.env.INPUTS_JSON = JSON.stringify({
      path: './dist',
      network: 'calibration',
    })

    const { parseInputs } = (await import(inputsModulePath)) as ParseInputsModule

    expect(() => parseInputs('upload')).toThrow('walletPrivateKey is required')
  })
})

describe('upload action Filecoin upload', () => {
  let carPath: string

  beforeEach(async () => {
    vi.resetModules()
    mocks.executeUpload.mockReset()
    carPath = join(tmpdir(), `filecoin-pin-upload-action-${randomUUID()}.car`)
    await writeFile(carPath, new Uint8Array([1, 2, 3]))
  })

  afterEach(async () => {
    await rm(carPath, { force: true })
  })

  it('uses the first successful copy for outputs when the primary copy failed', async () => {
    mocks.executeUpload.mockResolvedValue({
      pieceCid: 'bafkzcibe2hzbcd4t6clvsb3mfrezyxl75gl3gzcsqi42dd27gktq4nk75rr62ciuaq',
      size: 3,
      requestedCopies: 2,
      complete: false,
      copies: [
        {
          providerId: 2n,
          dataSetId: 13018n,
          pieceId: 0n,
          role: 'secondary',
          retrievalUrl: 'https://calib2.ezpdpz.net/piece/test',
          isNewDataSet: true,
        },
      ],
      failedAttempts: [
        {
          providerId: 4n,
          role: 'primary',
          error: 'Commit failed',
          explicit: false,
        },
      ],
      network: 'calibration',
      ipniValidated: true,
    })

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { uploadCarToFilecoin } = (await import(filecoinModulePath)) as FilecoinModule

    const result = await uploadCarToFilecoin(
      {},
      carPath,
      TEST_CID,
      { withCDN: false },
      { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }
    )

    logSpy.mockRestore()

    expect(result).toMatchObject({
      dataSetId: '13018',
      pieceId: '0',
      provider: { id: '2' },
      previewUrl: 'https://calib2.ezpdpz.net/piece/test',
      requestedCopies: 2,
      complete: false,
    })
  })
})

describe('upload action payments', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('plans funding for a piece without throwing (passes minimumPricePerMonth)', async () => {
    const payments = (await import('filecoin-pin/core/payments')) as typeof import('filecoin-pin/core/payments')
    const utils = (await import('filecoin-pin/core/utils')) as typeof import('filecoin-pin/core/utils')

    const status = {
      network: 'calibration',
      chainId: 314159,
      address: '0x0000000000000000000000000000000000000000',
      filBalance: 1_000_000_000_000_000_000n,
      walletUsdfcBalance: 1_000_000_000_000_000_000n,
      filecoinPayBalance: 1_000_000_000_000_000_000n,
      currentAllowances: {
        isApproved: true,
        rateAllowance: 0n,
        lockupAllowance: 0n,
        lockupUsage: 0n,
        rateUsage: 0n,
        maxLockupPeriod: 30n * 2880n,
      },
    }

    vi.mocked(payments.getPaymentStatus).mockResolvedValue(status as never)
    vi.mocked(payments.getServicePrice).mockResolvedValue({ minimumPricePerMonth: 1_000_000n } as never)
    vi.mocked(payments.executeTopUp).mockResolvedValue({ success: true, deposited: 0n, message: '' } as never)
    vi.mocked(payments.getStorageRunway).mockResolvedValue({} as never)
    vi.mocked(utils.formatRunwaySummary).mockReturnValue({
      coverage: 'covered',
      runway: 'plenty',
    } as never)

    const synapse = {
      client: {},
      payments: {
        accountSummary: async () => ({
          funds: 1_000_000_000_000_000_000n,
          availableFunds: 1_000_000_000_000_000_000n,
          debt: 0n,
          totalLockup: 0n,
          lockupRatePerEpoch: 0n,
          runwayInEpochs: 0n,
          grossCoverageInEpochs: 0n,
        }),
      },
      storage: {
        getStorageInfo: async () => ({ pricing: { noCDN: { perTiBPerEpoch: 1_000_000n } } }),
        createContexts: async () => [],
      },
    }

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { handlePayments } = (await import(filecoinModulePath)) as {
      handlePayments: (synapse: unknown, options: unknown, logger: unknown) => Promise<unknown>
    }

    await expect(
      handlePayments(
        synapse,
        {
          minStorageDays: 30,
          filecoinPayBalanceLimit: 10_000_000_000_000_000_000n,
          pieceSizeBytes: 1_048_576,
          withCDN: false,
        },
        { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }
      )
    ).resolves.toBeDefined()

    logSpy.mockRestore()

    // The funding planner (real, not mocked) ran and required the service price.
    expect(payments.getServicePrice).toHaveBeenCalledWith(synapse.client)
  })
})

describe('upload action PR comments', () => {
  const originalRepository = process.env.GITHUB_REPOSITORY
  const originalRunId = process.env.GITHUB_RUN_ID
  const originalToken = process.env.GITHUB_TOKEN

  beforeEach(() => {
    vi.resetModules()
    process.env.GITHUB_REPOSITORY = 'filecoin-project/filecoin-pin'
    process.env.GITHUB_RUN_ID = '123'
    process.env.GITHUB_TOKEN = 'test-token'
  })

  afterEach(() => {
    if (originalRepository == null) {
      delete process.env.GITHUB_REPOSITORY
    } else {
      process.env.GITHUB_REPOSITORY = originalRepository
    }

    if (originalRunId == null) {
      delete process.env.GITHUB_RUN_ID
    } else {
      process.env.GITHUB_RUN_ID = originalRunId
    }

    if (originalToken == null) {
      delete process.env.GITHUB_TOKEN
    } else {
      process.env.GITHUB_TOKEN = originalToken
    }
  })

  it('does not fail the upload when GitHub rejects the PR comment', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number | string | null): never => {
      throw new Error('process.exit called')
    }) as typeof process.exit)

    try {
      vi.doMock('../../../upload-action/src/github.js', () => ({
        createOctokit: () => ({
          rest: {
            issues: {
              listComments: vi.fn().mockResolvedValue({ data: [] }),
              createComment: vi.fn().mockRejectedValue(new Error('Resource not accessible by integration')),
              updateComment: vi.fn(),
            },
          },
        }),
        getGitHubEnv: () => ({
          owner: 'filecoin-project',
          repo: 'filecoin-pin',
          repository: 'filecoin-project/filecoin-pin',
          token: 'test-token',
          sha: 'abc123',
        }),
      }))

      const { commentOnPR } = (await import(commentsModulePath)) as CommentsModule

      await expect(
        commentOnPR({
          ipfsRootCid: TEST_CID,
          dataSetId: '13018',
          pieceCid: 'bafkzcibe2hzbcd4t6clvsb3mfrezyxl75gl3gzcsqi42dd27gktq4nk75rr62ciuaq',
          pr: { number: 399 },
        })
      ).resolves.toBeUndefined()

      expect(exitSpy).not.toHaveBeenCalled()
    } finally {
      exitSpy.mockRestore()
      warnSpy.mockRestore()
      vi.doUnmock('../../../upload-action/src/github.js')
      vi.resetModules()
    }
  })
})
