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

import type { Account, Chain } from 'viem'

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

async function loadAdapter(): Promise<OwsViemAdapter> {
  try {
    return (await import('@open-wallet-standard/adapters/viem')) as unknown as OwsViemAdapter
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(
      'OpenWallet Standard is not available on this platform. ' +
        '@open-wallet-standard/core ships napi-rs prebuilt binaries for linux-x64-gnu, ' +
        'linux-arm64-gnu, darwin-x64, and darwin-arm64 only (no Windows or musl/Alpine artifact today). ' +
        'Use --private-key / PRIVATE_KEY instead, or run on a supported platform.\n' +
        `Underlying load error: ${reason}`
    )
  }
}

const EVM_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/

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
  return account
}
