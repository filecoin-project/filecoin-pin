/**
 * Account readiness for uploads: the three-line scorecard `login` ends
 * with and `add` prints when it refuses an unfunded upload.
 *
 * Copy rule (PRD section 5): plain words only. The storage service is
 * "approved" or "not approved yet"; the deposit is a USDFC amount.
 */

import type { Synapse } from '@filoz/synapse-sdk'
import pc from 'picocolors'
import { checkAllowances, getDepositedBalance } from '../core/payments/index.js'
import { formatUSDFC } from '../core/utils/format.js'

export interface AccountReadiness {
  /** The storage service holds a usable approval on the owner's Filecoin Cloud balance. */
  serviceApproved: boolean
  /** USDFC deposited into Filecoin Cloud, in wei-scale units. */
  depositUsdfc: bigint
}

/** Read the readiness of `synapse`'s account (owner address) for uploads. */
export async function checkAccountReadiness(synapse: Synapse): Promise<AccountReadiness> {
  const [allowances, depositUsdfc] = await Promise.all([checkAllowances(synapse), getDepositedBalance(synapse)])
  return { serviceApproved: !allowances.needsUpdate, depositUsdfc }
}

const OK = pc.green('✓')
const NO = pc.red('✗')

/**
 * The scorecard lines, indented for printing under a heading. The session
 * line is always the first; the caller says whether the key is authorized.
 */
export function formatReadinessLines(readiness: AccountReadiness, sessionAuthorized: boolean): string[] {
  const lines = [
    sessionAuthorized ? `${OK} session key authorized` : `${NO} session key not authorized`,
    readiness.serviceApproved ? `${OK} storage service approved` : `${NO} storage service not approved yet`,
  ]
  const deposit = `USDFC deposit — ${formatUSDFC(readiness.depositUsdfc, 2)}`
  lines.push(readiness.depositUsdfc > 0n ? `${OK} ${deposit}` : `${NO} ${deposit}`)
  return lines.map((line) => `    ${line}`)
}
