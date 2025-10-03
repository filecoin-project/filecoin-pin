# Internal Flow

This document explains how the action works internally and why each step exists.

## High-Level Execution

1. **run.mjs** is the entry point. It:
   - Persists basic GitHub run metadata in the shared context.
   - Calls `runBuild()` to create the CAR file.
   - Calls `runUpload()` to upload to Filecoin.
   - Ensures `cleanupSynapse()` runs on success or failure.

2. **Build phase (`src/build.js`)**
   - Parses inputs via `parseInputs('compute')`. This validates `path` and `network` but does not require the wallet key.
   - Detects fork PRs (by comparing head/base repo names). When detected, it records `uploadStatus=fork-pr-blocked` in the context and emits a notice that upload will be blocked.
   - Resolves `path` against the workspace and generates a CAR using `createCarFile()`.
   - Stores the CAR file path, size, and IPFS root CID in the in-memory context (see `src/context.js`).
   - Merges additional metadata (run id, PR details) through `mergeAndSaveContext()`.

3. **Upload phase (`src/upload.js`)**
   - Parses inputs via `parseInputs('upload')`. This enforces presence of `walletPrivateKey` and confirms `network`, `minStorageDays`, and `filecoinPayBalanceLimit` rules.
   - If the build context marked the run as `fork-pr-blocked`, the upload phase writes outputs, posts the explanatory PR comment, and exits without touching Filecoin.
   - Validates that the CAR file still exists on disk.
   - Calls `initializeSynapse({ walletPrivateKey, network })`, which selects the correct RPC endpoint (`RPC_URLS[network].websocket`) and bootstraps filecoin-pin.
   - Fetches current payment status, then hands control to `handlePayments()` for deposit logic.
   - Uploads the CAR to Filecoin via `uploadCarToFilecoin()`; this returns piece CID, dataset id, provider info, preview URL, and canonical network name from filecoin-pin.
   - Updates the context, writes GitHub Action outputs, appends a step summary, and posts/updates the PR comment via `commentOnPR()`.

## Input Parsing (`src/inputs.js`)

`parseInputs()` uses a single schema for both phases:
- `path`: required for both phases.
- `walletPrivateKey`: required when `phase !== 'compute'`.
- `network`: required; must be `mainnet` or `calibration`.
- `minStorageDays`: optional number (defaults to `0` when unset).
- `filecoinPayBalanceLimit`: bigint parsed from USDFC string; required when `minStorageDays > 0`.
- `providerAddress`, `withCDN`: optional advanced settings with defaults.

The helper supports both environment-variable fallback (`INPUT_<NAME>`) and the `INPUTS_JSON` bundle populated by `action.yml`.

## Payment Handling (`src/filecoin.js` – `handlePayments`)

- Ensures Synapse allowances are configured via `checkAndSetAllowances()`.
- Pulls current balance with `getPaymentStatus()`.
- If `minStorageDays > 0`, computes the top-up required using `computeTopUpForDuration()`.
- Enforces the hard ceiling defined by `filecoinPayBalanceLimit`. If the current balance already meets or exceeds the limit, no deposit happens. If the computed top-up would exceed the limit, it is reduced to the largest permissible amount.
- Executes a deposit through `depositUSDFC()` when the final top-up is positive and refreshes payment status for downstream reporting.

## Context & Outputs

- Context lives in-memory inside `src/context.js`. Build and upload occur in the same job, so filesystem artifacts are not required for hand-off.
- `writeOutputs()` exposes CID, dataset, provider, CAR path, and status. Fork-blocked runs still surface the CAR information to aid reviewers.
- `writeSummary()` appends a markdown summary detailing payment status, provider links (via `pdp.vxb.ai/<network>`), and CAR size.
- `commentOnPR()` reuses existing bot comments when possible and uses the default workflow token.

## Error Handling

- Domain-specific failures throw `FilecoinPinError` with codes for insufficient funds, invalid private keys, and balance-limit violations.
- `handleError()` surfaces guidance tailored to the inputs (e.g., advising updates to `filecoinPayBalanceLimit`).
- `run.mjs` guarantees Synapse cleanup even when build or upload throws.

