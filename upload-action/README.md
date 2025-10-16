# Filecoin Pin Upload Action

The Filecoin Pin Upload Action is a composite GitHub Action that packs a file or directory into a UnixFS CAR, uploads it to Filecoin, and publishes artifacts and context for easy reuse.

This GitHub Action is provided to illustrate how to use filecoin-pin, a new IPFS pinning workflow that stores to the Filecoin decentralized storage network.  It's not expected to be the action that other repos will depend on for their production usecase of uploading to Filecoin.  Given the emphasis on this being an educational demo, breaking changes may be made at any time.  For robust use, the intent is to add filecoin-pin functionality to the ipshipyard/ipfs-deploy-action, which is being tracked in [issue #39](https://github.com/ipfs/ipfs-deploy-action/issues/39).

*Note: The Filecoin Pin Upload Action currently runs on the Filecoin Calibration testnet, where data isn't permanent and infrastructure resets regularly.*

## Example Workflow Files

Check out the [Workflow Examples](https://github.com/filecoin-project/filecoin-pin/tree/master/upload-action/examples/README.md) for ready-to-use GitHub workflow files for the Filecoin Pin Upload Action.

## Quick Start

The recommended Upload Action usage is to run your build in an untrusted workflow, publish the build output as an artifact, then run this action in a trusted workflow to create the IPFS CAR and upload to Filecoin for long-term storage.

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
      checks: write
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
        uses: filecoin-project/filecoin-pin/upload-action@v0
        with:
          path: dist
          walletPrivateKey: ${{ secrets.FILECOIN_WALLET_KEY }}
          network: calibration
          minStorageDays: "30"
          filecoinPayBalanceLimit: "0.25"
```

**Why this pattern?**
- Build workflow never sees wallet secrets
- Upload workflow runs from main branch (PRs can't modify hardcoded limits until merged)
- Currently **same-repo PRs only** (fork PR support disabled for security)

## Inputs & Outputs

See [action.yml](./action.yml) for complete input documentation including:
- **Core**: `path`, `walletPrivateKey`, `network`
- **Financial**: `minStorageDays`, `filecoinPayBalanceLimit`
- **Advanced**: `withCDN`, `dryRun`

**Outputs**: `ipfsRootCid`, `dataSetId`, `pieceCid`, `providerId`, `providerName`, `carPath`, `uploadStatus`

### Advanced: Provider Overrides

For most users, automatic provider selection is recommended. However, for advanced use cases where you need to target a specific storage provider, set environment variables:

```yaml
- name: Upload to Filecoin
  uses: filecoin-project/filecoin-pin/upload-action@v0
  env:
    PROVIDER_ADDRESS: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e"  # Override by address
    # OR
    PROVIDER_ID: "5"  # Override by provider ID
  with:
    path: dist
    walletPrivateKey: ${{ secrets.FILECOIN_WALLET_KEY }}
    network: calibration
```

**Priority order**:
1. `PROVIDER_ADDRESS` environment variable (highest priority)
2. `PROVIDER_ID` environment variable (only if no address specified)
3. Automatic provider selection (default - recommended)

⚠️ **Warning**: Overriding the provider may cause uploads to fail if the specified provider is unavailable or doesn't support IPFS indexing.

## Security Checklist

- ✅ Pin action by version tag or commit SHA (`@v0`, `@v0.9.1`, or `@<sha>`)
- ✅ Grant `actions: read` for artifact reuse (cache fallback)
- ✅ Grant `checks: write` for PR check status
- ✅ Grant `pull-requests: write` for PR comments
- ℹ️ GitHub token is automatically provided - no need to pass it
- ✅ **Always** hardcode `minStorageDays` and `filecoinPayBalanceLimit` in trusted workflows
- ✅ **Never** use `pull_request_target` - use the two-workflow pattern instead
- ✅ Enable **branch protection** on main to require reviews for workflow changes
- ✅ Use **CODEOWNERS** to require security team approval for workflow modifications
- ⚠️ **Consider using GitHub Environments** with required approvals to gate wallet interactions - this prevents workflows from making deposits without maintainer approval (via label, manual approval, etc.)

**Security Note**: The `workflow_run` trigger executes the workflow file from your main branch, not from the PR. PRs cannot change hardcoded limits until merged to the main branch of your repo.

## Alternative: Single Workflow Pattern

For trusted repositories where all contributors have write access and fork PRs are disabled:

```yaml
name: Upload to Filecoin
on:
  pull_request:
  push:
    branches: [main]

jobs:
  upload:
    runs-on: ubuntu-latest
    permissions:
      checks: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm run build
      - name: Upload to Filecoin
        uses: filecoin-project/filecoin-pin/upload-action@v0
        with:
          path: dist
          walletPrivateKey: ${{ secrets.FILECOIN_WALLET_KEY }}
          network: calibration
          minStorageDays: "30"
          filecoinPayBalanceLimit: "0.25"
```

**Use only when you fully trust everyone who can open PRs.**

## Current Limitations

**⚠️ Fork PR Support Disabled**
- Only same-repo PRs and direct pushes are supported
- This prevents non-maintainer PR actors from draining funds

## Versioning

Use semantic version tags from [filecoin-pin releases](https://github.com/filecoin-project/filecoin-pin/releases):

- **`@v0`** - Latest v0.x.x (recommended)
- **`@v0.9.1`** - Specific version (production)
- **`@<commit-sha>`** - Maximum supply-chain security

## Caching & Artifacts

- **Cache key**: `filecoin-pin-v1-${ipfsRootCid}` enables reuse for identical content
- **Artifacts**: `filecoin-pin-artifacts/upload.car` and `filecoin-pin-artifacts/context.json` published for each run
- **PR comments**: Include IPFS root CID, dataset ID, piece CID, and preview link

## Examples & Documentation

- **[examples/two-workflow-pattern/](./examples/two-workflow-pattern/)** - Ready-to-use workflow files (recommended starting point)
- **[examples/README.md](./examples/README.md)** - Detailed setup instructions
- **[FLOW.md](./FLOW.md)** - Internal architecture for contributors and maintainers

## Contributing

See [FLOW.md](./FLOW.md) for internal architecture.
