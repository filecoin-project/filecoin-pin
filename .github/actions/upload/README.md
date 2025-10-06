# Filecoin Pin Upload Action

Composite GitHub Action that packs a file or directory into a UnixFS CAR, uploads it to Filecoin, and publishes artifacts and context for easy reuse.

## Quick Start

Run your build in an untrusted workflow, publish the build output as an artifact, then run this action in a trusted workflow to create the CAR and upload to Filecoin. Fork PR support is currently disabled, so workflows must run within the same repository.

**Step 1: Build workflow** (no secrets):
```yaml
# .github/workflows/build-pr.yml
name: Build PR Content
on: pull_request

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm run build
      - name: Upload build artifacts
        uses: actions/upload-artifact@v4
        with:
          name: site-dist
          path: dist
```

**Step 2: Upload workflow** (runs after build, uses secrets):
```yaml
# .github/workflows/upload-to-filecoin.yml
name: Upload to Filecoin
on:
  workflow_run:
    workflows: ["Build PR Content"]
    types: [completed]

jobs:
  upload:
    if: github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-latest
    permissions:
      actions: read
      pull-requests: write
    steps:
      - name: Download build artifacts
        uses: actions/download-artifact@v4
        with:
          name: site-dist
          path: dist
          github-token: ${{ github.token }}
          repository: ${{ github.event.workflow_run.repository.full_name }}
          run-id: ${{ github.event.workflow_run.id }}

      - name: Upload to Filecoin
        uses: sgtpooki/filecoin-upload-action@v1
        with:
          path: dist
          walletPrivateKey: ${{ secrets.FILECOIN_WALLET_KEY }}
          network: calibration
          minStorageDays: "30"
          filecoinPayBalanceLimit: "0.25"
```

**Versioning**: This action uses [Semantic Release](https://semantic-release.gitbook.io/) for automated versioning. Use version tags like `@v1`, `@v1.0.0`, or commit SHAs for supply-chain safety.

## Inputs

See [action.yml](./action.yml) the input parameters and their descriptions.

## Security & Permissions Checklist

- ✅ Pin the action by version tag or commit SHA
- ✅ Grant `actions: read` if you want artifact reuse (cache fallback) to work
- ✅ Protect workflow files with CODEOWNERS/branch protection
- ✅ **Always** hardcode `minStorageDays` and `filecoinPayBalanceLimit` in trusted workflows
- ✅ **Never** use `pull_request_target` - use the two-workflow pattern instead
- ✅ Enable **branch protection** on main to require reviews for workflow changes
- ✅ Use **CODEOWNERS** to require security team approval for workflow modifications
- ⚠️ Consider gating deposits with Environments that require approval

## Usage

The action uses a secure two-workflow pattern by default. This currently works for **same-repo PRs only** (fork PR support temporarily disabled).

Split your CI into untrusted build + trusted upload workflows.

**Security Note**: The `workflow_run` trigger always executes the workflow file from your main branch, not from the PR. Even if a PR modifies the upload workflow to change hardcoded limits, those changes won't apply until the PR is merged.

## Current Limitations

**⚠️ Fork PR Support Disabled**

- Only same-repo PRs and direct pushes to main are supported
- PR commenting works, but shows different message for fork PRs
- This limits non-maintainer PR actors from draining funds from unaware repo owners

**See [examples/two-workflow-pattern/](./examples/two-workflow-pattern/)** for complete, ready-to-use workflow files.

## Releases & Versioning

This action uses [Semantic Release](https://semantic-release.gitbook.io/) for automated versioning based on [Conventional Commits](https://www.conventionalcommits.org/).

### Available Versions

- **`@v1`** - Latest v1.x.x release (recommended for most users)
- **`@v1.0.0`** - Specific version (recommended for production)
- **`@<commit-sha>`** - Specific commit (maximum security)

### Version Bumps

- **Patch** (`1.0.0` → `1.0.1`): Bug fixes, docs, refactoring
- **Minor** (`1.0.0` → `1.1.0`): New features
- **Major** (`1.0.0` → `2.0.0`): Breaking changes

### Release Process

Releases are automatically created when changes are pushed to `main` with conventional commit messages. See [CONTRIBUTING.md](./CONTRIBUTING.md) for commit message guidelines.

## Documentation

- **[examples/two-workflow-pattern/](./examples/two-workflow-pattern/)** - Ready-to-use workflow files (recommended)
- **[USAGE.md](./USAGE.md)** - Complete usage guide with all patterns
- **[FLOW.md](./FLOW.md)** - Internal architecture & how the action works under the hood
- **[examples/README.md](./examples/README.md)** - Detailed setup instructions

## Caching & Artifacts

- Cache key: `filecoin-pin-v1-${ipfsRootCid}` enables reuse for identical content.
- Artifacts: `filecoin-pin-artifacts/upload.car` and `filecoin-pin-artifacts/context.json` are published for each run.
- PR comments include the IPFS root CID, dataset ID, piece CID, and preview link.
