/**
 * Funds preflight for `add` in session-key mode (PRD section 6, "add:
 * happy, then unfunded"; appendix A decision 21).
 *
 * Runs before anything is packed or uploaded. A session key cannot deposit
 * (payment operations are owner-only), so instead of auto-funding it prints
 * the readiness lines and a pre-filled console funding link, then exits 1.
 * Private-key auth keeps its existing checks and `--auto-fund` behavior.
 */

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Synapse } from '@filoz/synapse-sdk'
import pc from 'picocolors'
import { CliFatal } from '../common/cli-errors.js'
import { type EstimateUploadCostOptions, estimateUploadCost } from '../common/upload-flow.js'
import { buildFundingUrl, DEFAULT_SUGGESTED_DEPOSIT_USDFC, resolveConsoleUrl } from '../core/session/console-url.js'
import { checkAccountReadiness, formatReadinessLines, type UploadFunds } from '../login/index.js'
import type { Spinner } from '../utils/cli-helpers.js'
import { log } from '../utils/cli-logger.js'

const USDFC_WEI = 10n ** 18n

/**
 * Bytes the upload will roughly carry: the file's size, or the sum of the
 * files under a directory. CAR framing adds a little on top; the estimate
 * is for the funds check, not the bill.
 */
export async function estimateInputBytes(path: string, isDirectory: boolean, includeHidden = false): Promise<number> {
  if (!isDirectory) return (await stat(path)).size
  const entries = await readdir(path, { recursive: true, withFileTypes: true })
  let total = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    // The packer skips dotfiles unless --include-hidden; count what it will pack.
    if (!includeHidden && entry.name.startsWith('.')) continue
    total += (await stat(join(entry.parentPath, entry.name))).size
  }
  return total
}

/** Whole USDFC to pre-fill in the funding link: the shortfall rounded up, or the default when only approval is missing. */
function suggestedDeposit(shortfall: bigint): number {
  if (shortfall <= 0n) return DEFAULT_SUGGESTED_DEPOSIT_USDFC
  return Number((shortfall + USDFC_WEI - 1n) / USDFC_WEI)
}

/** Run one read; on failure stop the spinner with a plain line naming the step, then rethrow. */
async function readStep<T>(spinner: Spinner | undefined, what: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (error) {
    spinner?.stop(`${pc.red('✗')} Could not read the ${what}`)
    throw error
  }
}

/**
 * Check service approval and available funds against the upload's estimate.
 * Returns normally when the account can pay; otherwise prints the
 * remediation block and throws a {@link CliFatal} (exit 1).
 */
export async function assertUploadFunds(
  synapse: Synapse,
  estimatedBytes: number,
  estimateOptions: EstimateUploadCostOptions,
  rerunCommand: string,
  spinner?: Spinner
): Promise<void> {
  // Sequential so a failing step is named in the spinner rather than
  // surfacing as a raw SDK error under a stale "checking" line.
  spinner?.message('Checking the storage service approval...')
  const readiness = await readStep(spinner, 'account readiness', () => checkAccountReadiness(synapse))
  spinner?.message('Estimating the upload cost...')
  const estimate = await readStep(spinner, 'upload cost estimate', () =>
    estimateUploadCost(synapse, estimatedBytes, estimateOptions)
  )
  const summary = await readStep(spinner, 'account balance', () => synapse.payments.accountSummary({}))
  // The SDK's depositNeeded already nets available funds against lockups,
  // fees, runway, and debt, so it decides; the line shows the two amounts.
  const shortfall = estimate.costs.depositNeeded
  const funds: UploadFunds = {
    available: summary.availableFunds,
    needed:
      shortfall > 0n ? summary.availableFunds + shortfall : estimate.costs.lockups.total + estimate.costs.fees.total,
    covered: shortfall === 0n,
  }
  if (readiness.serviceApproved && estimate.costs.ready) return

  const consoleUrl = resolveConsoleUrl(synapse.chain.id)
  const headline = `${pc.red('✗')} Account can't pay for this upload`
  if (spinner === undefined) log.line(headline)
  else spinner.stop(headline)
  for (const line of formatReadinessLines(readiness, true, funds)) log.line(line)
  if (consoleUrl !== undefined) {
    log.line('  Top up (amount pre-filled, one transaction):')
    log.line(`  ${pc.cyan(pc.underline(buildFundingUrl(consoleUrl, suggestedDeposit(estimate.costs.depositNeeded))))}`)
  } else {
    log.line('  Top up and approve the storage service in the Filecoin Cloud console with the owner wallet.')
  }
  log.line(`  Then re-run:  ${rerunCommand}     check anytime: filecoin-pin balance`)
  log.flush()
  throw new CliFatal("Account can't pay for this upload")
}
