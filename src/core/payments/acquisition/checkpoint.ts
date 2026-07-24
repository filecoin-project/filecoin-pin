import type { FileHandle } from 'node:fs/promises'
import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import type { Address, Hex } from 'viem'
import type { AcquisitionEvidence } from './types.js'

export interface AcquisitionCheckpoint {
  version: 1
  owner: Address
  sourceChainId: number
  destinationChainId: number
  /** Sum of every approval/route maximum native-gas commitment ever signed for this acquisition. */
  committedNativeGas: bigint
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

interface StoredAcquisitionCheckpoint extends Omit<AcquisitionCheckpoint, 'requiredWallet' | 'committedNativeGas'> {
  requiredWallet: { fil: string; usdfc: string }
  committedNativeGas: string
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
  return {
    ...checkpoint,
    requiredWallet: {
      fil: checkpoint.requiredWallet.fil.toString(),
      usdfc: checkpoint.requiredWallet.usdfc.toString(),
    },
    committedNativeGas: checkpoint.committedNativeGas.toString(),
  }
}

function deserialize(stored: StoredAcquisitionCheckpoint): AcquisitionCheckpoint {
  if (stored.version !== 1 || !/^0x[0-9a-fA-F]{40}$/.test(stored.owner)) {
    throw new Error('Acquisition recovery state is invalid; do not submit another source route')
  }
  return {
    ...stored,
    owner: stored.owner as Address,
    requiredWallet: { fil: BigInt(stored.requiredWallet.fil), usdfc: BigInt(stored.requiredWallet.usdfc) },
    committedNativeGas: BigInt(stored.committedNativeGas),
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
        return deserialize(JSON.parse(await readFile(file, 'utf8')) as StoredAcquisitionCheckpoint)
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
