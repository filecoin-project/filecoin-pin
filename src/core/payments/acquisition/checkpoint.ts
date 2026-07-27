import type { FileHandle } from 'node:fs/promises'
import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import type { Address, Hex } from 'viem'
import type { SourceRouteIdentity } from './source-execution.js'
import type { AcquisitionEvidence } from './types.js'

export interface AcquisitionCheckpoint {
  /** Version 2 binds recovery to exact selected-token identity and both caps. */
  version: 1 | 2
  owner: Address
  sourceChainId: number
  destinationChainId: number
  /** Sum of approval/route gas plus ERC-20 provider-required native route values ever signed. */
  committedNativeGas: bigint
  /** Required for v2 recovery; v1 checkpoints are never reinterpreted as another source. */
  source?: SourceRouteIdentity
  /** Original invocation-wide source cap, in source.decimals base units. */
  maxSourceAmount?: bigint
  /** Explicit selected-chain native ceiling used by this invocation. */
  maxNativeGas?: bigint
  /** Intent is durably recorded before approval broadcast; a hash is added only after broadcast returns. */
  approvalIntent?: {
    nonce: number
    token: Address
    spender: Address
    amount: string
    gasLimit: string
    maxFeePerGas: string
  }
  /** Approval hash retained before receipt confirmation so a restart never races its nonce. */
  approvalTransactionHash?: string
  /** Intent is durably recorded before a route broadcast; recovery never guesses or resubmits it. */
  routeIntent?: {
    nonce: number
    quoteId: string
    asset: 'fil' | 'usdfc'
    sourceAmount: string
    target: Address
    dataHash: Hex
    value: string
    gasLimit: string
    maxFeePerGas: string
  }
  requiredWallet: { fil: bigint; usdfc: bigint }
  evidence: AcquisitionEvidence[]
}

export interface AcquisitionCheckpointStore {
  load: () => Promise<AcquisitionCheckpoint | undefined>
  save: (checkpoint: AcquisitionCheckpoint) => Promise<void>
  clear: () => Promise<void>
}

export interface StoredAcquisitionCheckpoint
  extends Omit<AcquisitionCheckpoint, 'requiredWallet' | 'committedNativeGas' | 'maxSourceAmount' | 'maxNativeGas'> {
  requiredWallet: { fil: string; usdfc: string }
  committedNativeGas: string
  maxSourceAmount?: string
  maxNativeGas?: string
}

function acquisitionDataDirectory(): string {
  const home = homedir()
  if (platform() === 'linux') return process.env.XDG_DATA_HOME ?? join(home, '.local', 'share', 'filecoin-pin')
  if (platform() === 'darwin') return join(home, 'Library', 'Application Support', 'filecoin-pin')
  if (platform() === 'win32') return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'filecoin-pin')
  return join(home, '.filecoin-pin')
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error != null && 'code' in error && error.code === 'ENOENT'
}

function serialize(checkpoint: AcquisitionCheckpoint): StoredAcquisitionCheckpoint {
  const { maxSourceAmount, maxNativeGas, ...rest } = checkpoint
  return {
    ...rest,
    requiredWallet: {
      fil: checkpoint.requiredWallet.fil.toString(),
      usdfc: checkpoint.requiredWallet.usdfc.toString(),
    },
    committedNativeGas: checkpoint.committedNativeGas.toString(),
    ...(maxSourceAmount != null ? { maxSourceAmount: maxSourceAmount.toString() } : {}),
    ...(maxNativeGas != null ? { maxNativeGas: maxNativeGas.toString() } : {}),
  }
}

export function deserializeAcquisitionCheckpoint(stored: unknown): AcquisitionCheckpoint {
  const invalid = () => new Error('Acquisition recovery state is invalid; do not submit another source route')
  const isBaseUnit = (value: unknown): value is string => typeof value === 'string' && /^\d+$/.test(value)
  if (typeof stored !== 'object' || stored == null || Array.isArray(stored)) throw invalid()
  const checkpoint = stored as StoredAcquisitionCheckpoint
  if (
    (checkpoint.version !== 1 && checkpoint.version !== 2) ||
    !/^0x[0-9a-fA-F]{40}$/.test(checkpoint.owner) ||
    checkpoint.requiredWallet == null ||
    !isBaseUnit(checkpoint.requiredWallet.fil) ||
    !isBaseUnit(checkpoint.requiredWallet.usdfc) ||
    !isBaseUnit(checkpoint.committedNativeGas) ||
    (checkpoint.maxSourceAmount != null && !isBaseUnit(checkpoint.maxSourceAmount)) ||
    (checkpoint.maxNativeGas != null && !isBaseUnit(checkpoint.maxNativeGas))
  ) {
    throw invalid()
  }
  const { maxSourceAmount, maxNativeGas, ...rest } = checkpoint
  return {
    ...rest,
    owner: checkpoint.owner as Address,
    requiredWallet: { fil: BigInt(checkpoint.requiredWallet.fil), usdfc: BigInt(checkpoint.requiredWallet.usdfc) },
    committedNativeGas: BigInt(checkpoint.committedNativeGas),
    ...(maxSourceAmount != null ? { maxSourceAmount: BigInt(maxSourceAmount) } : {}),
    ...(maxNativeGas != null ? { maxNativeGas: BigInt(maxNativeGas) } : {}),
  }
}

/** A legacy checkpoint lacks the selected token/cap semantics and cannot be resumed safely. */
export function assertCheckpointSourceCompatibility(
  checkpoint: AcquisitionCheckpoint,
  source: SourceRouteIdentity,
  maxSourceAmount: bigint,
  maxNativeGas: bigint,
  requiredWallet?: { fil: bigint; usdfc: bigint }
): void {
  if (
    checkpoint.version !== 2 ||
    checkpoint.source == null ||
    checkpoint.maxSourceAmount == null ||
    checkpoint.maxNativeGas == null ||
    checkpoint.source.chainId !== source.chainId ||
    checkpoint.source.token.toLowerCase() !== source.token.toLowerCase() ||
    checkpoint.source.symbol !== source.symbol ||
    checkpoint.source.decimals !== source.decimals ||
    checkpoint.source.native !== source.native ||
    checkpoint.maxSourceAmount !== maxSourceAmount ||
    checkpoint.maxNativeGas !== maxNativeGas ||
    (requiredWallet != null &&
      (checkpoint.requiredWallet.fil < requiredWallet.fil || checkpoint.requiredWallet.usdfc < requiredWallet.usdfc))
  ) {
    throw new Error(
      'Acquisition recovery state is incompatible with the selected source identity, caps, or destination target; do not submit another route'
    )
  }
}

/** Strict v2 checkpoints carry selected-source base units and must never enter legacy USDC recovery. */
export function assertLegacyCheckpointVersion(checkpoint: AcquisitionCheckpoint): void {
  if (checkpoint.version !== 1) {
    throw new Error(
      'Strict acquisition recovery state requires the exact selected source; do not resume it through legacy USDC execution'
    )
  }
}

export interface AcquisitionLock {
  release: () => Promise<void>
}

/**
 * Serialize all planning, checkpoint, and broadcast work for one source owner.
 * A stale lock is intentionally never removed automatically: an operator must
 * inspect it first, which is safer than allowing a second process to broadcast.
 */
export async function acquireAcquisitionLock(
  owner: Address,
  options: { directory?: string } = {}
): Promise<AcquisitionLock> {
  const directory = options.directory ?? join(acquisitionDataDirectory(), 'acquisitions')
  const file = join(directory, `${owner.toLowerCase()}.lock`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  let handle: FileHandle
  try {
    handle = await open(file, 'wx', 0o600)
  } catch (error) {
    if (typeof error === 'object' && error != null && 'code' in error && error.code === 'EEXIST') {
      throw new Error(
        'Another acquisition is already active for this wallet; wait for it to finish or inspect the existing lock before retrying'
      )
    }
    throw error
  }
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`
  try {
    await handle.writeFile(token, 'utf8')
    await handle.chmod(0o600)
  } finally {
    await handle.close()
  }
  return {
    async release(): Promise<void> {
      try {
        if ((await readFile(file, 'utf8')) !== token) {
          throw new Error('Acquisition lock ownership changed; refusing to remove it')
        }
        await unlink(file)
      } catch (error) {
        if (!isMissingFile(error)) throw error
      }
    },
  }
}

/** Durable, non-secret recovery state prevents a rerun from duplicating a submitted source route. */
export function createAcquisitionCheckpointStore(owner: Address): AcquisitionCheckpointStore {
  const directory = join(acquisitionDataDirectory(), 'acquisitions')
  const file = join(directory, `${owner.toLowerCase()}.json`)
  return {
    async load(): Promise<AcquisitionCheckpoint | undefined> {
      try {
        return deserializeAcquisitionCheckpoint(JSON.parse(await readFile(file, 'utf8')) as StoredAcquisitionCheckpoint)
      } catch (error) {
        if (isMissingFile(error)) return undefined
        throw error
      }
    },
    async save(checkpoint: AcquisitionCheckpoint): Promise<void> {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await chmod(directory, 0o700)
      const temporary = `${file}.tmp`
      await writeFile(temporary, JSON.stringify(serialize(checkpoint)), { mode: 0o600 })
      await chmod(temporary, 0o600)
      await rename(temporary, file)
      await chmod(file, 0o600)
    },
    async clear(): Promise<void> {
      try {
        await unlink(file)
      } catch (error) {
        if (!isMissingFile(error)) throw error
      }
    },
  }
}
