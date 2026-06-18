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
// missing required args like `priceList`). Only the IO-bound helpers are mocked.
vi.mock('filecoin-pin/core/payments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('filecoin-pin/core/payments')>()
  return {
    ...actual,
    executeTopUp: vi.fn(),
    getPaymentStatus: vi.fn(),
    getStorageRunway: vi.fn(),
  }
})

/** Minimal on-chain `getPriceList` shape for the funding planner under test. */
function makePriceList() {
  return {
    token: '0x0000000000000000000000000000000000000000',
    rates: {
      storagePerTibPerMonth: 1_000_000n * 86_400n,
      datasetFeePerMonth: 1_000_000n,
      cdnEgressPerTib: 0n,
      cacheMissEgressPerTib: 0n,
    },
    fees: {
      createDataSetFee: 100_000_000_000_000_000n,
      addPiecesBaseFee: 0n,
      addPiecesPerPieceFee: 0n,
      schedulePieceRemovalsFee: 0n,
      terminateFee: 0n,
    },
    lockups: {
      lifecycleReserveTarget: 0n,
      replenishThreshold: 0n,
      defaultLockupPeriod: 86_400n,
      cdnLockupAmount: 1_000_000_000_000_000_000n,
      cacheMissLockupAmount: 0n,
      cdnLockupPeriod: 0n,
    },
  }
}

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
const githubModulePath: string = '../../../upload-action/src/github.js'
const buildModulePath: string = '../../../upload-action/src/build.js'
const uploadModulePath: string = '../../../upload-action/src/upload.js'

interface ParseInputsModule {
  parseInputs: (phase?: string) => {
    walletPrivateKey?: string
    contentPath: string
    network: 'mainnet' | 'calibration'
    dryRun: boolean
    dataSetIds?: bigint[]
  }
}

interface FilecoinModule {
  uploadCarToFilecoin: (
    synapse: unknown,
    carPath: string,
    ipfsRootCid: string,
    options: { withCDN: boolean; providerIds?: bigint[]; dataSetIds?: bigint[] },
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

interface GitHubModule {
  evaluateUploadProvenance: (event: unknown, eventName?: string) => { trusted: boolean; reason?: string }
}

interface BuildModule {
  runBuild: () => Promise<{ uploadStatus?: string; ipfsRootCid?: string }>
}

interface UploadModule {
  runUpload: (context?: Record<string, unknown>) => Promise<{ uploadStatus?: string }>
}

describe('upload action event provenance', () => {
  it('blocks fork pull requests', async () => {
    const { evaluateUploadProvenance } = (await import(githubModulePath)) as GitHubModule

    expect(
      evaluateUploadProvenance(
        {
          pull_request: {
            head: { repo: { full_name: 'contributor/filecoin-pin' } },
            base: { repo: { full_name: 'filecoin-project/filecoin-pin' } },
          },
        },
        'pull_request'
      )
    ).toMatchObject({ trusted: false, reason: expect.stringContaining('fork') })
  })

  it('blocks fork pull_request_target events', async () => {
    const { evaluateUploadProvenance } = (await import(githubModulePath)) as GitHubModule

    expect(
      evaluateUploadProvenance(
        {
          pull_request: {
            head: { repo: { full_name: 'contributor/filecoin-pin' } },
            base: { repo: { full_name: 'filecoin-project/filecoin-pin' } },
          },
        },
        'pull_request_target'
      )
    ).toMatchObject({ trusted: false, reason: expect.stringContaining('fork') })
  })

  it('blocks workflow runs originating from fork repositories', async () => {
    const { evaluateUploadProvenance } = (await import(githubModulePath)) as GitHubModule

    expect(
      evaluateUploadProvenance(
        {
          workflow_run: {
            head_repository: { full_name: 'contributor/filecoin-pin' },
            repository: { full_name: 'filecoin-project/filecoin-pin' },
          },
        },
        'workflow_run'
      )
    ).toMatchObject({ trusted: false, reason: expect.stringContaining('fork') })
  })

  it('allows workflow runs originating from the same repository', async () => {
    const { evaluateUploadProvenance } = (await import(githubModulePath)) as GitHubModule

    expect(
      evaluateUploadProvenance(
        {
          workflow_run: {
            head_repository: { full_name: 'filecoin-project/filecoin-pin' },
            repository: { full_name: 'filecoin-project/filecoin-pin' },
          },
        },
        'workflow_run'
      )
    ).toEqual({ trusted: true })
  })

  it('fails closed when workflow run repository provenance is incomplete', async () => {
    const { evaluateUploadProvenance } = (await import(githubModulePath)) as GitHubModule

    expect(
      evaluateUploadProvenance(
        { workflow_run: { repository: { full_name: 'filecoin-project/filecoin-pin' } } },
        'workflow_run'
      )
    ).toMatchObject({ trusted: false, reason: expect.stringContaining('incomplete') })
  })
})

describe('upload action fork enforcement', () => {
  const originalEventName = process.env.GITHUB_EVENT_NAME
  const originalEventPath = process.env.GITHUB_EVENT_PATH
  const originalInputsJson = process.env.INPUTS_JSON
  let eventPath: string | undefined

  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(async () => {
    if (eventPath) await rm(eventPath, { force: true })
    eventPath = undefined

    if (originalEventName == null) delete process.env.GITHUB_EVENT_NAME
    else process.env.GITHUB_EVENT_NAME = originalEventName

    if (originalEventPath == null) delete process.env.GITHUB_EVENT_PATH
    else process.env.GITHUB_EVENT_PATH = originalEventPath

    if (originalInputsJson == null) delete process.env.INPUTS_JSON
    else process.env.INPUTS_JSON = originalInputsJson
  })

  it('marks fork workflow runs as blocked during the build phase', async () => {
    eventPath = join(tmpdir(), `filecoin-pin-upload-event-${randomUUID()}.json`)
    await writeFile(
      eventPath,
      JSON.stringify({
        workflow_run: {
          head_repository: { full_name: 'contributor/filecoin-pin' },
          repository: { full_name: 'filecoin-project/filecoin-pin' },
        },
      })
    )
    process.env.GITHUB_EVENT_NAME = 'workflow_run'
    process.env.GITHUB_EVENT_PATH = eventPath
    process.env.INPUTS_JSON = JSON.stringify({ path: 'dist', network: 'mainnet' })

    const unixfs = await import('filecoin-pin/core/unixfs')
    vi.mocked(unixfs.createUnixfsCarBuilder).mockReturnValue({
      buildCar: vi.fn().mockResolvedValue({
        carPath: '/tmp/fork-content.car',
        rootCid: TEST_CID,
        size: 3,
      }),
    } as never)

    const logSpies = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ]

    try {
      const { runBuild } = (await import(buildModulePath)) as BuildModule
      await expect(runBuild()).resolves.toMatchObject({
        uploadStatus: 'fork-pr-blocked',
        ipfsRootCid: TEST_CID,
      })
    } finally {
      for (const spy of logSpies) spy.mockRestore()
    }
  })

  it('returns blocked status before requiring upload inputs or a wallet key', async () => {
    delete process.env.INPUTS_JSON

    const logSpies = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ]

    try {
      const { runUpload } = (await import(uploadModulePath)) as UploadModule
      await expect(
        runUpload({
          uploadStatus: 'fork-pr-blocked',
          pr: { number: 6 },
        })
      ).resolves.toMatchObject({ uploadStatus: 'fork-pr-blocked' })
    } finally {
      for (const spy of logSpies) spy.mockRestore()
    }
  })
})

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

  it('parses a comma-separated dataSetIds input into bigints', async () => {
    process.env.INPUTS_JSON = JSON.stringify({
      path: './dist',
      network: 'calibration',
      dryRun: true,
      dataSetIds: '13260,13261',
    })

    const { parseInputs } = (await import(inputsModulePath)) as ParseInputsModule

    expect(parseInputs('upload')).toMatchObject({
      dataSetIds: [13260n, 13261n],
    })
  })

  it('leaves dataSetIds undefined when the input is omitted', async () => {
    process.env.INPUTS_JSON = JSON.stringify({
      path: './dist',
      network: 'calibration',
      dryRun: true,
    })

    const { parseInputs } = (await import(inputsModulePath)) as ParseInputsModule

    const result = parseInputs('upload')
    expect(result.dataSetIds).toBeUndefined()
  })

  it('rejects a non-numeric dataSetIds value with a clear error', async () => {
    process.env.INPUTS_JSON = JSON.stringify({
      path: './dist',
      network: 'calibration',
      dryRun: true,
      dataSetIds: '13260,abc',
    })

    const { parseInputs } = (await import(inputsModulePath)) as ParseInputsModule

    expect(() => parseInputs('upload')).toThrow(/Invalid dataSetIds.*abc.*positive integer/)
  })

  it('rejects dataSetIds when PROVIDER_IDS env is also set', async () => {
    process.env.INPUTS_JSON = JSON.stringify({
      path: './dist',
      network: 'calibration',
      dryRun: true,
      dataSetIds: '13260',
    })
    process.env.PROVIDER_IDS = '1'

    try {
      const { parseInputs } = (await import(inputsModulePath)) as ParseInputsModule
      expect(() => parseInputs('upload')).toThrow(/Cannot specify both dataSetIds and PROVIDER_IDS/)
    } finally {
      delete process.env.PROVIDER_IDS
    }
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

    const uploadData = mocks.executeUpload.mock.calls[0]?.[1]

    expect(result).toMatchObject({
      dataSetId: '13018',
      pieceId: '0',
      provider: { id: '2' },
      previewUrl: 'https://calib2.ezpdpz.net/piece/test',
      requestedCopies: 2,
      complete: false,
    })
    expect(uploadData).toBeInstanceOf(ReadableStream)
  })

  it('logs byte-level upload progress from executeUpload callbacks', async () => {
    mocks.executeUpload.mockImplementation(async (_synapse, _data, _cid, options) => {
      options.onProgress?.({ type: 'uploadProgress', data: { bytesUploaded: 2 } })
      return {
        pieceCid: 'bafkzcibe2hzbcd4t6clvsb3mfrezyxl75gl3gzcsqi42dd27gktq4nk75rr62ciuaq',
        size: 3,
        requestedCopies: 1,
        complete: true,
        copies: [
          {
            providerId: 2n,
            dataSetId: 13018n,
            pieceId: 1n,
            role: 'primary',
            retrievalUrl: 'https://calib2.ezpdpz.net/piece/test',
            isNewDataSet: false,
          },
        ],
        failedAttempts: [],
        network: 'calibration',
        ipniValidated: true,
      }
    })

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { uploadCarToFilecoin } = (await import(filecoinModulePath)) as FilecoinModule

    await uploadCarToFilecoin(
      {},
      carPath,
      TEST_CID,
      { withCDN: false },
      { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }
    )

    expect(logSpy).toHaveBeenCalledWith('Upload progress: 66% (2.0 B/3.0 B)')

    logSpy.mockRestore()
  })

  it('forwards dataSetIds to executeUpload', async () => {
    mocks.executeUpload.mockResolvedValue({
      pieceCid: 'bafkzcibe2hzbcd4t6clvsb3mfrezyxl75gl3gzcsqi42dd27gktq4nk75rr62ciuaq',
      size: 3,
      requestedCopies: 1,
      complete: true,
      copies: [
        {
          providerId: 2n,
          dataSetId: 13260n,
          pieceId: 1n,
          role: 'primary',
          retrievalUrl: 'https://calib2.ezpdpz.net/piece/test',
          isNewDataSet: false,
        },
      ],
      failedAttempts: [],
      network: 'calibration',
      ipniValidated: true,
    })

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { uploadCarToFilecoin } = (await import(filecoinModulePath)) as FilecoinModule

    await uploadCarToFilecoin(
      {},
      carPath,
      TEST_CID,
      { withCDN: false, dataSetIds: [13260n, 13261n] },
      { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }
    )

    logSpy.mockRestore()

    const executeUploadOptions = mocks.executeUpload.mock.calls[0]?.[3]
    expect(executeUploadOptions).toMatchObject({ dataSetIds: [13260n, 13261n] })
  })
})

describe('upload action payments', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('plans funding for a piece without throwing (reads the on-chain price list)', async () => {
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
        getStorageInfo: vi.fn(async () => ({
          pricing: { noCDN: { perTiBPerEpoch: 1_000_000n }, priceList: makePriceList() },
        })),
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

    // The funding planner (real, not mocked) ran and read the on-chain price
    // list via getStorageInfo().
    expect(synapse.storage.getStorageInfo).toHaveBeenCalled()
  })

  it('forwards dataSetIds to createContexts', async () => {
    const payments = (await import('filecoin-pin/core/payments')) as typeof import('filecoin-pin/core/payments')
    const utils = (await import('filecoin-pin/core/utils')) as typeof import('filecoin-pin/core/utils')

    vi.mocked(payments.getPaymentStatus).mockResolvedValue({
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
    } as never)
    vi.mocked(payments.executeTopUp).mockResolvedValue({ success: true, deposited: 0n, message: '' } as never)
    vi.mocked(payments.getStorageRunway).mockResolvedValue({} as never)
    vi.mocked(utils.formatRunwaySummary).mockReturnValue({ coverage: 'covered', runway: 'plenty' } as never)

    const createContexts = vi.fn().mockResolvedValue([])
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
        getStorageInfo: async () => ({
          pricing: { noCDN: { perTiBPerEpoch: 1_000_000n }, priceList: makePriceList() },
        }),
        createContexts,
      },
    }

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { handlePayments } = (await import(filecoinModulePath)) as {
      handlePayments: (synapse: unknown, options: unknown, logger: unknown) => Promise<unknown>
    }

    await handlePayments(
      synapse,
      { minStorageDays: 0, withCDN: false, dataSetIds: [13260n, 13261n] },
      { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }
    )

    logSpy.mockRestore()

    expect(createContexts).toHaveBeenCalledWith(expect.objectContaining({ dataSetIds: [13260n, 13261n] }))
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
