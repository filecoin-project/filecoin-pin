/**
 * Egress-provider CLI option, FilBeam URL builder, and notice renderer.
 *
 * Owns:
 *   --egress-provider <beam|none>  (default: beam, env: EGRESS_PROVIDER)
 *   The non-interactive notice printed when beam is active
 */

import type { Synapse } from '@filoz/synapse-sdk'
import { type Command, Option } from 'commander'
import { getClientAddress } from '../core/synapse/index.js'
import { log } from './cli-logger.js'

export const EGRESS_PROVIDERS = ['beam', 'none'] as const
export type EgressProvider = (typeof EGRESS_PROVIDERS)[number]

/**
 * Attach the `--egress-provider` option to a Commander command. The `beam`
 * default is applied by the add/import CLI normalization, not via Commander.
 */
export function addEgressOptions(command: Command): Command {
  command.addOption(
    new Option(
      '--egress-provider <provider>',
      'Egress provider for piece retrieval: beam (default, FilBeam CDN; egress drawn from the owner lockup) or none.'
    )
      .choices(EGRESS_PROVIDERS as readonly string[])
      .env('EGRESS_PROVIDER')
  )
  return command
}

/**
 * Read the connected chain's FilBeam config, or `null` when the chain exposes
 * no FilBeam endpoint (e.g. devnet).
 */
function getFilbeamConfig(synapse: Synapse): { retrievalDomain: string } | null {
  return (synapse.chain as { filbeam?: { retrievalDomain: string } | null }).filbeam ?? null
}

/**
 * Whether the connected chain exposes a FilBeam retrieval endpoint.
 */
export function chainSupportsFilbeam(synapse: Synapse): boolean {
  return getFilbeamConfig(synapse) != null
}

/**
 * Build the FilBeam retrieval URL for an uploaded piece.
 *
 * Returns `undefined` when egress is disabled, the piece CID is missing, or the
 * selected chain has no FilBeam endpoint (e.g. devnet).
 */
export function buildFilbeamUrl(synapse: Synapse, pieceCid: string | undefined, withCDN: boolean): string | undefined {
  if (!withCDN || !pieceCid) {
    return undefined
  }
  const filbeam = getFilbeamConfig(synapse)
  if (filbeam == null) {
    return undefined
  }
  return new URL(pieceCid, `https://${getClientAddress(synapse)}.${filbeam.retrievalDomain}`).toString()
}

/**
 * Print a non-interactive informational block describing the active egress
 * provider. Called once per `add`/`import` invocation, before any spinner work.
 *
 * Silent when provider is 'none'.
 */
export function printEgressNotice(provider: EgressProvider): void {
  if (provider === 'none') {
    return
  }
  log.info('Egress: FilBeam')
  log.indent("• Egress consumes the data set owner's locked-up funds.")
  log.indent('• FilBeam routes piece/CAR retrieval only, not IPFS blocks.')
  log.indent('• Each new data set locks an extra 1 USDFC.')
  log.indent('• Disable: --egress-provider none')
  log.flush()
}
