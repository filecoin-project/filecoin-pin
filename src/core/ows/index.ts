/**
 * OpenWallet Standard (OWS) integration for filecoin-pin
 *
 * Resolves an OWS-managed wallet into a viem `Account` that the Synapse SDK
 * can sign with directly. Private keys never leave the OWS core; this module
 * just hands Synapse a signing surface (signMessage / signTransaction /
 * signTypedData) backed by the OWS adapter.
 *
 * The adapter is loaded via dynamic `import()` because
 * `@open-wallet-standard/core` is a napi-rs native binding without prebuilt
 * artifacts for Windows or musl. A static import would crash CLI startup on
 * those platforms even when the user never asks for OWS auth.
 *
 * @module core/ows
 */

import type { Account, Chain, TypedDataDefinition } from 'viem'
import { getTypesForEIP712Domain } from 'viem'

export interface OwsAccountOptions {
  /** Wallet name or ID registered with the `ows` CLI / OWS core */
  walletId: string
  /** Target Filecoin chain (used to derive CAIP-2 chain ID) */
  chain: Chain
  /** Optional passphrase for keystore-encrypted wallets */
  passphrase?: string
  /** Optional account index within the wallet (defaults to 0) */
  index?: number
  /** Optional override for OWS vault path */
  vaultPath?: string
}

interface OwsViemAdapter {
  owsToViemAccount: (
    walletNameOrId: string,
    options?: { chain?: string; passphrase?: string; index?: number; vaultPath?: string }
  ) => Account
}

interface OwsCore {
  signTypedData: (
    wallet: string,
    chain: string,
    typedDataJson: string,
    passphrase?: string | undefined,
    index?: number | undefined,
    vaultPath?: string | undefined
  ) => { signature: string }
}

const UNAVAILABLE_MESSAGE =
  'OpenWallet Standard is not available on this platform. ' +
  '@open-wallet-standard/core ships napi-rs prebuilt binaries for linux-x64-gnu, ' +
  'linux-arm64-gnu, darwin-x64, and darwin-arm64 only (no Windows or musl/Alpine artifact today). ' +
  'Use --private-key / PRIVATE_KEY instead, or run on a supported platform.'

function unavailable(err: unknown): Error {
  const reason = err instanceof Error ? err.message : String(err)
  return new Error(`${UNAVAILABLE_MESSAGE}\nUnderlying load error: ${reason}`)
}

async function loadAdapter(): Promise<OwsViemAdapter> {
  try {
    return (await import('@open-wallet-standard/adapters/viem')) as unknown as OwsViemAdapter
  } catch (err) {
    throw unavailable(err)
  }
}

async function loadCore(): Promise<OwsCore> {
  try {
    return (await import('@open-wallet-standard/core')) as unknown as OwsCore
  } catch (err) {
    throw unavailable(err)
  }
}

const EVM_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/

/**
 * Encode a bigint as the OWS core's EIP-712 parser expects a uint value.
 *
 * The parser enforces two constraints:
 * - Decimal uint values above 2^128 are rejected ("exceeds u128 range; use hex
 *   encoding"). synapse-sdk's `clientDataSetId` and `nonce` are `randU256()`,
 *   uniform over the full uint256 range, so hex is required in the general case.
 * - Hex values must have an even number of digits ("bad uint hex: Odd number of
 *   digits"), so `0x0` and `0x1ab` are not valid.
 *
 * Even-length hex satisfies both and produces signatures identical to viem
 * across 0, 2^128 - 1, 2^128, and 2^256 - 1.
 *
 * Negative values fall back to decimal. synapse-sdk uses only uint EIP-712
 * fields; the hex form here is unsigned.
 */
function bigintToOwsHex(value: bigint): string {
  if (value < 0n) return value.toString()
  const hex = value.toString(16)
  return `0x${hex.length % 2 === 1 ? `0${hex}` : hex}`
}

/**
 * Build a viem `Account` backed by an OWS wallet.
 *
 * filecoin-pin signs via FEVM (Filecoin EVM), so we always request an
 * `eip155:*` account from OWS. OWS wallets typically also expose a native
 * Filecoin (`fil:*`, f1/f3 address) account derived from the same seed —
 * that one is not used here, since synapse-sdk targets FEVM via viem.
 *
 * The returned account is a `LocalAccount` from viem's perspective; signing
 * calls are delegated to the OWS native core, so the private key never
 * materializes in the Node process.
 */
export async function getOwsAccount(options: OwsAccountOptions): Promise<Account> {
  const { owsToViemAccount } = await loadAdapter()
  const chainId = `eip155:${options.chain.id}`
  const adapterOptions: Parameters<typeof owsToViemAccount>[1] = { chain: chainId }
  if (options.passphrase != null) adapterOptions.passphrase = options.passphrase
  if (options.index != null) adapterOptions.index = options.index
  if (options.vaultPath != null) adapterOptions.vaultPath = options.vaultPath
  const account = owsToViemAccount(options.walletId, adapterOptions)
  if (!EVM_ADDRESS_REGEX.test(account.address)) {
    throw new Error(
      `OWS returned a non-EVM address (${account.address}) for wallet "${options.walletId}". ` +
        'filecoin-pin signs via FEVM and requires an eip155 account. ' +
        'Check that the wallet has an eip155:* entry in `ows wallet list`.'
    )
  }

  const core = await loadCore()

  /**
   * Sign EIP-712 typed data through the OWS core, which takes the payload as a
   * JSON string. Every typed-data message synapse-sdk signs carries bigints
   * (`clientDataSetId`, `nonce`, `pieceIndex`, permit `value`/`deadline`), and
   * viem hands a local account its message with those bigints intact (only its
   * JSON-RPC path serializes). So this override does the serialization the core
   * needs: encode bigints as even-length hex (see `bigintToOwsHex`) and include
   * the `EIP712Domain` type. Only `signTypedData` needs this shaping;
   * `signMessage` and `signTransaction` from the adapter encode their own input.
   */
  const signTypedData = async (typedData: TypedDataDefinition): Promise<`0x${string}`> => {
    // viem's signTypedData action adds EIP712Domain to `types` before an account
    // sees the payload; a direct account.signTypedData() call does not. Add it
    // here so the core resolves the domain type ("unknown type: EIP712Domain"
    // otherwise). A caller-supplied EIP712Domain wins via the spread order.
    const withDomain = {
      ...typedData,
      types: {
        EIP712Domain: getTypesForEIP712Domain({ domain: typedData.domain }),
        ...typedData.types,
      },
    }
    const serialized = JSON.stringify(withDomain, (_key, value) =>
      typeof value === 'bigint' ? bigintToOwsHex(value) : value
    )
    const result = core.signTypedData(
      options.walletId,
      chainId,
      serialized,
      options.passphrase,
      options.index,
      options.vaultPath
    )
    const signature = result.signature
    return (signature.startsWith('0x') ? signature : `0x${signature}`) as `0x${string}`
  }

  return { ...account, signTypedData } as Account
}
