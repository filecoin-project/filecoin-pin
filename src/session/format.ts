/**
 * Display helpers for session-key CLI output.
 */

import type {
  AuthorizeSessionResult,
  CreateSessionKeyResult,
  RevokeSessionResult,
  SessionKeypair,
} from '../core/session/index.js'

function formatExpiry(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace('T', ' ').split('.')[0] ?? ''
}

/**
 * Output for `session create` (single-party). Includes the session private key.
 */
export function formatCreateSessionKeyOutput(result: CreateSessionKeyResult): string {
  return `
==========================================
Session key created and authorized!
==========================================
Validity: ${result.validityDays} days (expires: ${formatExpiry(result.expiry)})
Chain id: ${result.chainId}

Save to your .env file:
------------------------------------------
WALLET_ADDRESS=${result.ownerAddress}
SESSION_KEY=${result.sessionPrivateKey}

Authorization details:
------------------------------------------
SESSION_ADDRESS=${result.sessionAddress}
REGISTRY=${result.registryAddress}
TX_HASH=${result.txHash}
BLOCK=${result.blockNumber}
EXPIRY=${result.expiry}
`.trim()
}

/**
 * Output for `session authorize <addr>` (two-party owner side). No session
 * private key, since the owner never had it.
 */
export function formatAuthorizeSessionOutput(result: AuthorizeSessionResult): string {
  return `
==========================================
Session address authorized on-chain!
==========================================
Validity: ${result.validityDays} days (expires: ${formatExpiry(result.expiry)})
Chain id: ${result.chainId}

Share with the session-key holder:
------------------------------------------
WALLET_ADDRESS=${result.ownerAddress}

Authorization details:
------------------------------------------
SESSION_ADDRESS=${result.sessionAddress}
REGISTRY=${result.registryAddress}
TX_HASH=${result.txHash}
BLOCK=${result.blockNumber}
EXPIRY=${result.expiry}
`.trim()
}

/**
 * Output for `session revoke <addr>`.
 */
export function formatRevokeSessionOutput(result: RevokeSessionResult): string {
  return `
==========================================
Session address revoked on-chain!
==========================================
Chain id: ${result.chainId}

Revocation details:
------------------------------------------
OWNER_ADDRESS=${result.ownerAddress}
SESSION_ADDRESS=${result.sessionAddress}
REGISTRY=${result.registryAddress}
TX_HASH=${result.txHash}
BLOCK=${result.blockNumber}
REVOKED_PERMISSIONS=${result.permissions.length}
`.trim()
}

/**
 * Output for `session generate`. Local-only; no on-chain action.
 */
export function formatSessionKeypairOutput(keypair: SessionKeypair): string {
  return `
==========================================
Session keypair generated locally
==========================================
Keep SESSION_KEY secret. Share ONLY SESSION_ADDRESS with the wallet owner so
they can authorize it via: filecoin-pin session authorize ${keypair.address}

Save to your .env file:
------------------------------------------
SESSION_KEY=${keypair.privateKey}
SESSION_ADDRESS=${keypair.address}
`.trim()
}
