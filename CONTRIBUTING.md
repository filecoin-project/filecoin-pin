# Contributing to filecoin-pin

Thank you for your interest in contributing! Please follow these guidelines when submitting changes.

## Use Conventional Commits

All commits, especially PR titles, should follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

- `feat:` - New features
- `fix:` - Bug fixes
- `docs:` - Documentation changes
- `chore:` - Maintenance tasks
- `refactor:` - Code refactoring
- `test:` - Test additions or changes
- `ci:` - CI/CD changes

Example: `feat: add support for batch uploads`

## Reference GitHub Issues

Always reference the related GitHub issue in your PR description using keywords like `Fixes #123` or `Closes #456`.

### Include Visual Evidence

For user-facing changes or CLI flows, include:
- Screenshots for UI changes
- Terminal output for CLI commands
- Before/after comparisons when relevant

## Draft PRs

Leave your PR in draft status until it's ready for maintainer review. This helps maintainers prioritize their time.

## Code Quality

Keep comments concise and favor self-documenting code when possible. Use clear variable names, function names, and code structure to make your intent obvious.

## CLI Command Structure

One-shot CLI commands should keep Commander.js wiring separate from command behavior:

- `src/commands/<command>.ts` parses Commander arguments/options, calls the runner, catches errors, and owns CLI exit codes.
- `src/<command>/` contains business logic and user-facing terminal UI such as spinners, status output, cancellation messages, and cleanup.
- Runner functions signal failures by throwing (never call `process.exit()`). The one exception is the "incomplete" outcome (see [Exit codes](#exit-codes)): a runner may call `setIncompleteExitCode()` and return normally rather than throw. Deep helpers that abort by throwing use `CliIncomplete`, which the runner's outer catch maps to the same call.
- Command wiring should not print errors that the runner already displayed.
- Use `finally` blocks for cleanup that must happen on both success and failure.

The `server` command is long-running and manages its own process lifecycle, so this one-shot command pattern does not apply there.

### Exit codes

One-shot commands use three exit codes so scripts can distinguish outcomes (`EXIT_CODE_INCOMPLETE` lives in `src/common/cli-errors.ts`):

| Code | Meaning | How it is produced |
| --- | --- | --- |
| `0` | Success | Runner returns normally; wrapper exits `process.exitCode ?? 0`. |
| `1` | Failure — the operation errored | Runner throws; the Commander wrapper catches and exits `1`. |
| `2` | Incomplete — neither succeeded nor failed | Runner calls `setIncompleteExitCode()` and returns normally (does **not** throw). |

Use `2` (incomplete) when the user deliberately stops an operation or a requested confirmation never arrives — for example declining a destructive `confirm()` prompt, or a `--wait` confirmation that times out after the transaction was already submitted. These are not errors (so `1` would be misleading) but they are not successes either (so `0` would hide them from scripts).

Guidelines:

- Mark the outcome with `setIncompleteExitCode()` from `src/common/cli-errors.ts`; the helper never downgrades a prior failure code.
- When a command fans out over multiple targets (e.g. `remove` over several data sets), a hard failure (`process.exit(1)`) still takes precedence over an incomplete (`2`).
- `2` overlaps with the "usage error" convention some CLIs use, but Commander already exits `1` on argument-parse errors here, so `2` is reserved exclusively for the incomplete outcome.
