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
- Runner functions must throw errors instead of calling `process.exit()` or setting `process.exitCode`.
- Command wiring should not print errors that the runner already displayed.
- Use `finally` blocks for cleanup that must happen on both success and failure.

The `server` command is long-running and manages its own process lifecycle, so this one-shot command pattern does not apply there.
