/**
 * Exit code for operations that neither succeeded nor errored: the user
 * cancelled (e.g. declining the `terminate` confirmation) or a requested
 * confirmation wait timed out. Distinct from `1`, which the
 * Commander wrappers use for caught errors, so scripts can tell "incomplete"
 * apart from "failed".
 */
export const EXIT_CODE_INCOMPLETE = 2

/**
 * Marks the process outcome as incomplete (exit code 2) unless a failure
 * code is already set. All incomplete-outcome sites go through this helper
 * so a real failure (exit 1) is never downgraded to incomplete.
 */
export function setIncompleteExitCode(): void {
  if ((process.exitCode ?? 0) === 0) {
    process.exitCode = EXIT_CODE_INCOMPLETE
  }
}

/**
 * Sentinel error for user-cancelled operations in code that aborts by
 * throwing (deep helpers where setting the exit code and returning would
 * let the caller continue). The runner's outer catch detects it via
 * {@link isCliIncomplete}, reports the cancellation, and calls
 * {@link setIncompleteExitCode} instead of failing with exit 1.
 */
export class CliIncomplete extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CliIncomplete'
  }
}

/**
 * Type guard for `CliIncomplete`. Used by runner outer catches to map a
 * user cancellation to the incomplete exit code rather than a failure.
 */
export function isCliIncomplete(error: unknown): error is CliIncomplete {
  return error instanceof CliIncomplete
}

/**
 * Sentinel error type for CLI runners that have already displayed the
 * user-facing failure message via clack/log/console.
 *
 * # Why this exists
 *
 * CLI commands use a two-layer split (see `CONTRIBUTING.md`):
 *
 * - `src/<cmd>/` runners contain business logic and clack UI. They display
 *   user-friendly error messages via clack BEFORE throwing.
 * - `src/commands/<cmd>.ts` Commander wrappers catch errors and own exit
 *   codes. They do NOT display errors (the runner already did).
 *
 * Runner code typically wraps work in a try/catch where the catch displays
 * a generic `✗ <action> failed: <msg>` line for unexpected errors. Some
 * inner branches need to display rich, contextual errors (cyan helpMessage,
 * formatted balances, multi-line guidance) BEFORE throwing. Without a
 * sentinel, the outer catch would re-display those errors as a generic
 * `✗ <action> failed` line, producing duplicate stderr output.
 *
 * `CliFatal` solves this: inner branches that have already displayed the
 * error throw `CliFatal`. The runner's outer catch checks `isCliFatal(err)`
 * and skips its generic display when the error has already been reported.
 * The Commander wrapper still catches and exits with code 1.
 *
 * # When to use
 *
 * Throw `CliFatal` ONLY at a CLI failure boundary where the error has
 * already been shown to the user via `log.line` + `log.flush`,
 * `console.error`, `cancel(...)`, or similar. The runner's outer catch
 * will treat the error as "already reported" and not print anything
 * additional.
 *
 * If your code has not displayed the error to the user, throw a regular
 * `Error` instead — the runner's outer catch will format and display it.
 *
 * # Example (correct)
 *
 * ```ts
 * if (!validation.isValid) {
 *   const msg = validation.errorMessage ?? 'Payment validation failed'
 *   log.line(`${pc.red('✗')} ${msg}`)
 *   if (validation.helpMessage) {
 *     log.line('')
 *     log.line(`  ${pc.cyan(validation.helpMessage)}`)
 *   }
 *   log.flush()
 *   cancel('Please fund your wallet and try again')
 *   throw new CliFatal(msg)
 * }
 * ```
 *
 * # Example (wrong)
 *
 * ```ts
 * // Don't throw CliFatal without displaying first — user sees nothing.
 * if (!ok) throw new CliFatal('something failed')
 * ```
 */
export class CliFatal extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CliFatal'
  }
}

/**
 * Type guard for `CliFatal`. Used by runner outer catches to detect
 * "error already displayed by inner branch — do not re-display."
 */
export function isCliFatal(error: unknown): error is CliFatal {
  return error instanceof CliFatal
}
