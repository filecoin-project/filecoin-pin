/**
 * OpenWallet Standard (OWS) integration for filecoin-pin
 *
 * Resolves an OWS-managed wallet into a viem `Account` that the Synapse SDK
 * can sign with directly. Private keys never leave the OWS core; this module
 * just hands Synapse a signing surface (signMessage / signTransaction /
 * signTypedData) backed by the OWS adapter.
 *
 * @module core/ows
 */

import { owsToViemAccount } from '@open-wallet-standard/adapters/viem'
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

/**
 * Build a viem `Account` backed by an OWS wallet.
 *
 * The returned account is a `LocalAccount` from viem's perspective; signing
 * calls are delegated to the OWS native core, so the private key never
 * materializes in the Node process.
 */
export function getOwsAccount(options: OwsAccountOptions): Account {
  const chainId = `eip155:${options.chain.id}`
  const adapterOptions: Parameters<typeof owsToViemAccount>[1] = { chain: chainId }
  if (options.passphrase != null) adapterOptions.passphrase = options.passphrase
  if (options.index != null) adapterOptions.index = options.index
  if (options.vaultPath != null) adapterOptions.vaultPath = options.vaultPath
  return owsToViemAccount(options.walletId, adapterOptions)
}
