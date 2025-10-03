# Usage Guide

This action builds a UnixFS CAR from your site or files and uploads it to Filecoin in a single invocation. For security, separate untrusted build steps from the trusted upload step.

## Recommended Pattern: Build + Upload Workflows

1. **Build workflow** (no secrets) compiles your project and uploads the build output as an artifact.
2. **Upload workflow** (trusted) downloads the artifact, runs this action, and provides wallet secrets.

### Workflow 1: Build (Untrusted)

```yaml
# .github/workflows/build-pr.yml
name: Build PR Content

on:
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}

      - name: Build your site
        run: npm run build

      - name: Upload build artifacts
        uses: actions/upload-artifact@v4
        with:
          name: site-dist
          path: dist
```

### Workflow 2: Upload (Trusted)

```yaml
# .github/workflows/upload-to-filecoin.yml
name: Upload to Filecoin

on:
  workflow_run:
    workflows: ["Build PR Content"]
    types: [completed]

jobs:
  upload:
    if: ${{ github.event.workflow_run.conclusion == 'success' }}
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
          walletPrivateKey: ${{ secrets.WALLET_PRIVATE_KEY }}
          network: calibration
          minStorageDays: "30"
          filecoinPayBalanceLimit: "0.25"
```

**Security hints**:
- Build workflow never sees wallet secrets.
- Upload workflow runs from the main branch version of the file when triggered via `workflow_run`, so PRs cannot change hardcoded values until merged.
- Hardcode financial parameters in trusted workflows and review changes carefully.

---

## Alternative: Single Workflow (Trusted Repos Only)

If every contributor is trusted and you do not accept fork PRs, you can run build and upload in the same job:

```yaml
name: Upload to Filecoin

on:
  pull_request:
  push:
    branches: [main]

jobs:
  upload:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm run build
      - name: Upload to Filecoin
        uses: sgtpooki/filecoin-upload-action@v1
        with:
          path: dist
          walletPrivateKey: ${{ secrets.WALLET_PRIVATE_KEY }}
          network: mainnet
          minStorageDays: "7"
          filecoinPayBalanceLimit: "1.00"
```

Use this approach only when you fully trust everyone who can open PRs.

---

## Input Reference

### `path`
- **Type**: `string`
- **Required**: Yes
- **Description**: File or directory to package into a CAR and upload.

### `walletPrivateKey`
- **Type**: `string`
- **Required**: Yes when uploading
- **Description**: EVM-compatible private key for the Filecoin wallet.

### `network`
- **Type**: `string`
- **Required**: Yes
- **Options**: `mainnet`, `calibration`
- **Description**: Selects the Filecoin network; controls the RPC endpoint used by filecoin-pin.

### `minStorageDays`
- **Type**: `string`
- **Required**: No
- **Description**: Desired storage runway in days. When provided, the action calculates the deposit needed to reach this runway.

### `filecoinPayBalanceLimit`
- **Type**: `string`
- **Required**: Yes if `minStorageDays` is provided
- **Description**: Maximum Filecoin Pay balance (USDFC) allowed after deposits.

### `providerAddress`
- **Type**: `string`
- **Default**: `0xa3971A7234a3379A1813d9867B531e7EeB20ae07`
- **Description**: Optional override for the storage provider.

### `withCDN`
- **Type**: `boolean`
- **Default**: `false`
- **Description**: Request CDN support when available. Warning: filecoin-pin does not yet adjust deposit calculations for CDN usage.

---

## Outputs

- `ipfsRootCid`: IPFS Root CID
- `dataSetId`: Synapse Data Set ID
- `pieceCid`: Filecoin Piece CID
- `providerId`: Storage Provider ID
- `providerName`: Storage Provider Name
- `carPath`: Path to the generated CAR file
- `uploadStatus`: Status of the run (e.g., `uploaded`, `fork-pr-blocked`)

