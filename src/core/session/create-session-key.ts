/**
 * Session key creation for delegated access to Synapse SDK
 *
 * This module provides functionality to create and authorize session keys
 * for use with the Synapse SDK, allowing delegated access without exposing
 * the main private key.
 */

import {
  ADD_PIECES_TYPEHASH,
  CONTRACT_ADDRESSES,
  CREATE_DATA_SET_TYPEHASH,
  getFilecoinNetworkType,
  RPC_URLS,
  WarmStorageService,
} from '@filoz/synapse-sdk'
import type { HDNodeWallet } from 'ethers'
import { Contract, JsonRpcProvider, Wallet } from 'ethers'

/**
 * Permission type hashes for the session key registry
 * Re-exported from synapse-sdk for convenience
 */
export const PERMISSION_TYPE_HASHES = {
  CREATE_DATA_SET: CREATE_DATA_SET_TYPEHASH,
  ADD_PIECES: ADD_PIECES_TYPEHASH,
} as const

export interface SessionKeyResult {
  /**
   * The newly generated session key wallet
   */
  sessionWallet: HDNodeWallet

  /**
   * The owner wallet used to authorize the session key
   */
  ownerWallet: Wallet

  /**
   * Unix timestamp when the session key expires
   */
  expiry: number

  /**
   * Number of days the session key is valid
   */
  validityDays: number

  /**
   * The registry contract address used
   */
  registryAddress: string

  /**
   * The RPC URL used
   */
  rpcUrl: string
}

export interface CreateSessionKeyOptions {
  /**
   * Private key of the wallet that will authorize the session key
   */
  privateKey: string

  /**
   * Number of days the session key should be valid (default: 10)
   */
  validityDays?: number

  /**
   * RPC URL to use (default: Calibration testnet)
   */
  rpcUrl?: string

  /**
   * Warm Storage contract address override (optional)
   * If not provided, uses the default for the detected network
   */
  warmStorageAddress?: string

  /**
   * Progress callback for logging/UI updates
   */
  onProgress?: (step: string, details?: Record<string, string>) => void
}

/**
 * Creates and authorizes a new session key for use with Synapse SDK
 *
 * This function:
 * 1. Generates a new random wallet (session key)
 * 2. Calculates the expiry timestamp based on validity days
 * 3. Calls the registry contract's login() function to authorize the session key
 * 4. Returns all relevant information for the user
 *
 * @param options - Configuration for session key creation
 * @returns Session key information including wallets, expiry, and contract details
 *
 * @example
 * ```typescript
 * const result = await createSessionKey({
 *   privateKey: '0x...',
 *   validityDays: 30,
 *   onProgress: (step, details) => console.log(step, details)
 * })
 *
 * console.log('Session key:', result.sessionWallet.privateKey)
 * console.log('Owner address:', result.ownerWallet.address)
 * ```
 */
export async function createSessionKey(options: CreateSessionKeyOptions): Promise<SessionKeyResult> {
  const { privateKey, validityDays = 10, rpcUrl = RPC_URLS.calibration.http, warmStorageAddress, onProgress } = options

  // Step 1: Generate new session key
  onProgress?.('Generating new session key...', {})
  const sessionWallet = Wallet.createRandom()
  onProgress?.('Generated session key', {
    address: sessionWallet.address,
    // Only show first 20 chars of private key for security
    privateKey: `${sessionWallet.privateKey.slice(0, 20)}...`,
  })

  // Step 2: Calculate expiry timestamp
  onProgress?.('Calculating expiry timestamp...', {})
  const currentTime = Math.floor(Date.now() / 1000)
  const expiry = currentTime + validityDays * 24 * 60 * 60
  const expiryDate = new Date(expiry * 1000).toISOString()
  onProgress?.('Calculated expiry', {
    expiry: expiryDate,
    validityDays: String(validityDays),
  })

  // Step 3: Initialize provider and wallet
  onProgress?.('Initializing wallet and discovering contract addresses...', {})
  const provider = new JsonRpcProvider(rpcUrl)
  const ownerWallet = new Wallet(privateKey, provider)
  onProgress?.('Owner wallet initialized', {
    address: ownerWallet.address,
  })

  // Step 4: Get the session key registry address from WarmStorage
  // Determine the warm storage address to use
  const network = await getFilecoinNetworkType(provider)
  const resolvedWarmStorageAddress = warmStorageAddress ?? CONTRACT_ADDRESSES.WARM_STORAGE[network]
  if (!resolvedWarmStorageAddress) {
    throw new Error(`No Warm Storage address configured for network: ${network}`)
  }

  const warmStorage = await WarmStorageService.create(provider, resolvedWarmStorageAddress)
  const registryAddress = warmStorage.getSessionKeyRegistryAddress()
  onProgress?.('Discovered session key registry', {
    registry: registryAddress,
    network,
  })

  // Step 5: Authorize session key on-chain
  onProgress?.('Authorizing session key on-chain (this may take a minute)...', {
    registry: registryAddress,
    rpcUrl,
  })

  // Use minimal ABI with 3-parameter login function (deployed contract version)
  // The full SDK ABI has 4 parameters but the deployed contract uses 3
  const registryAbi = [
    'function login(address signer, uint256 expiry, bytes32[] permissions) external',
    'function authorizationExpiry(address user, address signer, bytes32 permission) external view returns (uint256)',
  ]
  const registry = new Contract(registryAddress, registryAbi, ownerWallet)

  // Call login with both permission type hashes
  const typeHashes = [PERMISSION_TYPE_HASHES.CREATE_DATA_SET, PERMISSION_TYPE_HASHES.ADD_PIECES]

  // Contract methods are dynamically typed, so we use 'as any' for the call
  // login(address signer, uint256 expiry, bytes32[] permissions)
  const tx = await (registry as any).login(sessionWallet.address, expiry, typeHashes)
  onProgress?.('Transaction submitted', {
    txHash: tx.hash,
  })

  const receipt = await tx.wait()
  onProgress?.('Transaction confirmed', {
    txHash: receipt.hash,
    blockNumber: String(receipt.blockNumber),
  })

  return {
    sessionWallet,
    ownerWallet,
    expiry,
    validityDays,
    registryAddress,
    rpcUrl,
  }
}

/**
 * Formats session key result for display to the user
 *
 * @param result - The session key creation result
 * @returns Formatted string for console output
 */
export function formatSessionKeyOutput(result: SessionKeyResult): string {
  const expiryDate = new Date(result.expiry * 1000).toISOString().replace('T', ' ').split('.')[0]

  return `
==========================================
Session key created successfully!
==========================================
Validity: ${result.validityDays} days (expires: ${expiryDate})

Add these to your .env file:
------------------------------------------
WALLET_ADDRESS=${result.ownerWallet.address}
SESSION_KEY=${result.sessionWallet.privateKey}

Session key info (for debugging):
------------------------------------------
SESSION_KEY_ADDRESS=${result.sessionWallet.address}
OWNER_ADDRESS=${result.ownerWallet.address}
REGISTRY=${result.registryAddress}
EXPIRY=${result.expiry}
`.trim()
}
