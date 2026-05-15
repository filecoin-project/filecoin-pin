/**
 * Egress-provider CLI option, env normalization, and notice renderer.
 *
 * Owns:
 *   --egress-provider <beam|none>  (default: beam, env: EGRESS_PROVIDER)
 *   WITH_CDN env var fallback for backwards compatibility
 *   The non-interactive notice printed when beam is active
 */

import { type Command, Option } from 'commander'
import { log } from './cli-logger.js'

export const EGRESS_PROVIDERS = ['beam', 'none'] as const
export type EgressProvider = (typeof EGRESS_PROVIDERS)[number]

/**
 * Resolve the effective egress provider.
 *
 * Precedence:
 *   1. Explicit CLI value (--egress-provider flag, EGRESS_PROVIDER env, or other non-default Commander source)
 *   2. WITH_CDN env var (backwards compat: 'true' → beam, 'false' → none)
 *   3. Default: 'beam'
 *
 * `cliSource` is Commander's `getOptionValueSource('egressProvider')` result —
 * one of `'cli' | 'env' | 'default' | 'config' | 'implied' | undefined`. When
 * the source is `'default'` or `'implied'`, `cliValue` is treated as absent so
 * the WITH_CDN fallback can apply.
 */
export function normalizeEgressProvider(
  cliValue: EgressProvider | undefined,
  cliSource: string | undefined,
  env: { WITH_CDN?: string }
): EgressProvider {
  const userProvidedCli = cliValue != null && cliSource !== 'default' && cliSource !== 'implied'
  if (userProvidedCli) {
    return cliValue as EgressProvider
  }
  if (env.WITH_CDN === 'false') {
    return 'none'
  }
  if (env.WITH_CDN === 'true') {
    return 'beam'
  }
  return 'beam'
}

/**
 * Attach the `--egress-provider` option to a Commander command.
 *
 * Defaults to `beam` (FilBeam CDN active). `none` opts out completely.
 * Reads `EGRESS_PROVIDER` env var. `WITH_CDN` is honored as a fallback
 * via {@link normalizeEgressProvider} after Commander parsing.
 */
export function addEgressOptions(command: Command): Command {
  command.addOption(
    new Option(
      '--egress-provider <provider>',
      'Egress provider for piece retrieval (default: beam). ' +
        'beam = pieces retrievable via FilBeam CDN; egress costs charged to the dataset owner. ' +
        'none = no CDN routing; pieces retrievable only via direct SP PDP endpoints. ' +
        'Today FilBeam serves piece/CAR retrieval only, not IPFS-block retrieval ' +
        '(see https://github.com/filbeam/roadmap/issues/85).'
    )
      .choices(EGRESS_PROVIDERS as readonly string[])
      .default('beam')
      .env('EGRESS_PROVIDER')
  )
  return command
}

/**
 * Source of the resolved egress provider.
 *
 * - 'cli'     — explicit --egress-provider, EGRESS_PROVIDER, or WITH_CDN env
 * - 'default' — no explicit input, falling back to the Commander default
 */
export type EgressProviderSource = 'cli' | 'default'

/**
 * Print a non-interactive informational block describing the active egress
 * provider. Called once per `add`/`import` invocation, before any spinner work.
 *
 * Silent when provider is 'none'.
 */
export function printEgressNotice(provider: EgressProvider, resolution: { source: EgressProviderSource }): void {
  if (provider === 'none') {
    return
  }
  const suffix = resolution.source === 'default' ? ' (default)' : ''
  log.info(`Egress: FilBeam${suffix}`)
  log.indent('• Pieces retrievable via the FilBeam CDN endpoint.')
  log.indent("• Egress costs are charged to the dataset owner's wallet.")
  log.indent(
    '• Today FilBeam serves piece/CAR retrieval only — IPFS-block retrieval is not yet routed through FilBeam\n  (https://github.com/filbeam/roadmap/issues/85).'
  )
  log.indent('• Disable with: --egress-provider none')
  log.flush()
}

/**
 * Map Commander's option-value source to our two-way notice classifier.
 *
 * Commander returns: 'cli' | 'env' | 'default' | 'config' | 'implied' | undefined.
 * We collapse to:
 *   'cli'     — user-initiated (cli, env, config, or WITH_CDN fallback)
 *   'default' — Commander's `.default('beam')` won
 */
export function resolveEgressProviderSource(
  commanderSource: string | undefined,
  env: { WITH_CDN?: string }
): EgressProviderSource {
  if (commanderSource != null && commanderSource !== 'default' && commanderSource !== 'implied') {
    return 'cli'
  }
  if (env.WITH_CDN === 'true' || env.WITH_CDN === 'false') {
    return 'cli'
  }
  return 'default'
}
