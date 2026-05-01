# Filecoin Pin Upload Action

The Filecoin Pin Upload Action is a composite GitHub Action that packs a file or directory into a UnixFS CAR, uploads it to Filecoin, and publishes artifacts and context for easy reuse.

This GitHub Action is provided to illustrate how to use filecoin-pin, a new IPFS pinning workflow that stores to the Filecoin decentralized storage network.  It's not expected to be the action that other repos will depend on for their production use case of uploading to Filecoin.  Given the emphasis on this being an educational demo, breaking changes may be made at any time.  For robust use, the intent is to add filecoin-pin functionality to the ipshipyard/ipfs-deploy-action, which is being tracked in [issue #39](https://github.com/ipfs/ipfs-deploy-action/issues/39).

*Note: The Filecoin Pin Upload Action currently runs on the Filecoin Calibration testnet, where data isn't permanent and infrastructure resets regularly.*

## Quick Start

See the two-workflow approach in the [examples directory](./examples/) for complete workflow files and setup instructions.

## Inputs & Outputs

> **Using the CLI directly?** `filecoin-pin add` and `filecoin-pin import` accept `--auto-fund`, `--min-runway-days`, and `--max-balance` flags that mirror `minStorageDays` and `filecoinPayBalanceLimit` here. See `filecoin-pin add --help`.

See [action.yml](./action.yml) for complete input documentation including:
- **Core**: `path`, `walletPrivateKey`, `network`
- **Financial**: `minStorageDays`, `filecoinPayBalanceLimit`
- **Advanced**: `withCDN`, `dryRun`

**Outputs**: `ipfsRootCid`, `dataSetId`, `pieceCid`, `providerId`, `providerName`, `carPath`, `uploadStatus`

### Uploading a pre-built CAR

If `path` points to a regular file whose name ends in `.car`, the action skips its own UnixFS packing and uploads the file as-is, extracting the IPFS root CID from the CAR header. Useful for composing with upstream steps that already produce a CAR (e.g. [`ipfs-deploy-action`](https://github.com/ipfs/ipfs-deploy-action), [`ipfs dag export`](https://docs.ipfs.tech/reference/kubo/cli/#ipfs-dag-export)).

```yaml
- name: Upload pre-built CAR to Filecoin
  uses: filecoin-project/filecoin-pin/upload-action@v0
  with:
    path: build.car
    walletPrivateKey: ${{ secrets.FILECOIN_WALLET_KEY }}
    network: calibration
```

The CAR must declare exactly one root; multi-root and rootless CARs are rejected so the upload always has an unambiguous IPFS root CID. Directories (even named `foo.car/`) fall through to the UnixFS packer.

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

## Current Limitations

**⚠️ Fork PR Support Disabled**
- Only same-repo PRs and direct pushes are supported
- This prevents non-maintainer PR actors from draining funds

## Versioning and Updates

Use semantic version tags from [filecoin-pin releases](https://github.com/filecoin-project/filecoin-pin/releases):

- **`@v0`** - Latest v0.x.x (recommended)
- **`@v0.9.1`** - Specific version (production)
- **`@<commit-sha>`** - Maximum supply-chain security

The action checks npm for a newer `filecoin-pin` release at the start of each run and posts a GitHub Actions notice when one is available.

## Caching & Artifacts

- **Cache key**: `filecoin-pin-v1-${ipfsRootCid}` enables reuse for identical content
- **Artifacts**: `filecoin-pin-artifacts/upload.car` and `filecoin-pin-artifacts/context.json` published for each run
- **PR comments**: Include IPFS root CID, dataset ID, piece CID, and preview link

## Examples & Documentation

- **[examples/](./examples/)** - Ready-to-use workflow files and setup instructions
- **[Actual usage in filecoin-pin-website repo](https://github.com/filecoin-project/filecoin-pin-website/blob/main/.github/workflows/filecoin-pin-upload.yml)** ([🎥 demo recording](https://www.youtube.com/watch?v=_2ZsMYXfgwI))
- **[Filecoin Pin + ENS Demo](https://github.com/FIL-Builders/filecoin-pin-ens-demo)** ([🎥 demo recording](https://www.youtube.com/watch?v=tkDwXAVtnDA)) - A minimal demo showing a static website deployed with the Filecoin Pin Upload Action and an ENS update that points the ENS name to the latest IPFS CID after each push to main.
- **[FLOW.md](./FLOW.md)** - Internal architecture for contributors and maintainers

## Contributing

See [FLOW.md](./FLOW.md) for internal architecture.
