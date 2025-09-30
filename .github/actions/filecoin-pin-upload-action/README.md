# Filecoin Pin Upload Action (Local Copy)

This is a local copy of the composite action that packs a file/directory into a UnixFS CAR, uploads via `filecoin-pin` to Filecoin (Synapse), and publishes useful artifacts.

Use it from this repo via:

```yaml
uses: ./.github/actions/filecoin-pin-upload-action
with:
  privateKey: ${{ secrets.FILECOIN_WALLET_KEY }}
  path: dist
  minDays: 10
  minBalance: "5"   # USDFC
  maxTopUp: "50"     # USDFC
  providerAddress: "0xa3971A7234a3379A1813d9867B531e7EeB20ae07"
```

Notes:
- This action automatically installs and builds the local `filecoin-pin` sources before running (no prebuilt `dist` is committed). This will change to an npm installed version when the action is production-ready.
- For PR events, the action posts a comment with the IPFS Root CID.

Inputs
- `privateKey` (required): Wallet private key.
- `path` (default: `dist`): Build output path.
- `minDays` (default: `10`): Minimum runway in days.
- `minBalance` (optional): Minimum deposit (USDFC).
- `maxTopUp` (optional): Maximum additional deposit (USDFC).
- `token` (default: `USDFC`): Supported token.
- `withCDN` (default: `false`): Request CDN if available.
- `providerAddress` (default shown above): Override storage provider address (Calibration/Mainnet). Leave empty to allow auto-selection.

Security notes for PR workflows
- If you use `pull_request`, the workflow and action come from the PR branch. PR authors can modify inputs (e.g., `minDays`, `minBalance`). Set a conservative `maxTopUp` to cap spending.
- If you need PRs to always run the workflow definition from `main`, consider `pull_request_target`. WARNING: it runs with base repo permissions and may have access to secrets. Do not run untrusted PR code with those secrets. Prefer a two-workflow model (`pull_request` build → `workflow_run` deploy) when in doubt.

Security considerations (PRs)
- Running uploads on pull_request means PR authors can change inputs (e.g., `minDays`, `minBalance`) within the PR, which can influence deposits/top-ups.
- Always set a conservative `maxTopUp` to cap the maximum funds added in a single run.
- Protect your main branch and review workflow changes. Require approval for workflows from outside collaborators.
- Forked PRs don’t receive secrets by default, so funding won’t run there; same-repo PRs do have access to secrets.

Caching details
- Cache key: `filecoin-pin-v1-${root_cid}` ensures uploads are skipped for identical content.
- You can invalidate all caches by changing the version prefix (e.g., `v2`).
- Retention is managed by GitHub Actions and organization settings; it’s not configurable per cache entry in actions/cache v4. Each restore updates last-access time.

## Setup Checklist (Security + Reliability)

- Pin the action when used from another repo: `uses: filecoin-project/filecoin-pin/.github/actions/filecoin-pin-upload-action@<commit-sha>`
- Restrict allowed actions in repo/org settings (Actions → General → Allow select actions) to:
  - GitHub official (e.g., `actions/*`)
  - Your org (e.g., `filecoin-project/*`)
- Grant the workflow/job `actions: read` if you want artifact reuse to work across runs.
- Cap spend with `maxTopUp` (pushes) and a lower cap (or zero) on PRs.
- Consider Environments with required reviewers for any deposit/top-up steps.
- Keep workflow files protected with CODEOWNERS + branch protection.
- Never run untrusted PR code with secrets under `pull_request_target`. Prefer a two‑step model if you need main‑defined workflows.

## PR Safety Options

- Low/zero PR top‑ups (simple)
  - In your workflow, set a small cap for PRs. Uploads still work if already funded.
  - Example:
    ```yaml
    with:
      maxTopUp: ${{ github.event_name == 'pull_request' && '0' || '50' }}
    ```

- Label‑gated PR spending (reviewer control)
  - Default PR cap is 0; maintainers add `allow-upload` label to raise the cap.
  - Example:
    ```yaml
    - name: Decide PR cap
      id: caps
      if: ${{ github.event_name == 'pull_request' }}
      uses: actions/github-script@v7
      with:
        script: |
          const labels = (context.payload.pull_request.labels||[]).map(l=>l.name)
          core.setOutput('PR_CAP', labels.includes('allow-upload') ? '5' : '0')

    - name: Upload
      uses: ./.github/actions/filecoin-pin-upload-action
      with:
        maxTopUp: "${{ steps.caps.outputs.PR_CAP || '50' }}"
    ```

- Two‑step (safest) with artifacts
  - PR workflow (no secrets): `with: mode: prepare` → uploads CAR + metadata as artifact
  - workflow_run on main: download artifact and `with: mode: upload` → validates and uploads with secrets

## Two‑Step Usage

Prepare (PR, no secrets):
```yaml
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with: { node-version: 20.x }
  - run: npm ci && npm run build
  - name: Prepare CAR (no secrets)
    uses: ./.github/actions/filecoin-pin-upload-action
    with:
      mode: prepare
      path: dist
      artifactName: filecoin-pin-${{ github.run_id }}-${{ github.sha }}
```

Upload (workflow_run on main, with secrets):
```yaml
steps:
  - uses: actions/checkout@v4
  - name: Download artifact
    uses: actions/download-artifact@v4
    with:
      name: filecoin-pin-${{ github.event.workflow_run.run_id }}-${{ github.event.workflow_run.head_sha }}
      path: filecoin-pin-artifacts
  - name: Upload to Filecoin
    uses: ./.github/actions/filecoin-pin-upload-action
    with:
      mode: upload
      prebuiltCarPath: filecoin-pin-artifacts/upload.car
      privateKey: ${{ secrets.FILECOIN_WALLET_KEY }}
      minDays: 10
      minBalance: "5"
      maxTopUp: "50"
      providerAddress: "0xa3971A7234a3379A1813d9867B531e7EeB20ae07"
```
