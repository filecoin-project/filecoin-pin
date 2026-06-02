# Recipe: drive the `filecoin-pin` CLI directly

This recipe shows how to upload to Filecoin by running the [`filecoin-pin`](https://github.com/filecoin-project/filecoin-pin) CLI directly in a GitHub Actions workflow, **without** the composite [upload-action](../../). Use it when you want full control over your workflow steps — for example to compose filecoin-pin with your own build, packing, or pinning steps.

The complete workflow is in [`upload-with-cli.yml`](./upload-with-cli.yml). It covers both cases below.

## Prerequisites

- A Filecoin wallet private key stored in a repository secret (`FILECOIN_WALLET_KEY`). The wallet must hold FIL for gas and either USDFC, or FIL that `--auto-fund` can convert to USDFC.
- Decide your spend caps: `--min-runway-days` (days of storage runway auto-fund must achieve) and `--max-balance` (the USDFC balance cap after top-up). These govern wallet spend, so hardcode them in trusted workflows.

## Case 1: pack and upload a directory

`filecoin-pin add` builds a UnixFS CAR from a directory (or file) and uploads it in one step.

```yaml
- name: Upload directory to Filecoin
  env:
    PRIVATE_KEY: ${{ secrets.FILECOIN_WALLET_KEY }}
  run: |
    npx -y filecoin-pin@0.22.3 add dist \
      --network mainnet \
      --auto-fund \
      --min-runway-days 30 \
      --max-balance 5.00
```

## Case 2: upload a pre-built CAR

`filecoin-pin import` uploads an existing single-root CAR as-is and preserves its root CID. Useful when an upstream step already produced a CAR.

```yaml
- name: Import CAR to Filecoin
  env:
    PRIVATE_KEY: ${{ secrets.FILECOIN_WALLET_KEY }}
  run: |
    npx -y filecoin-pin@0.22.3 import build.car \
      --network mainnet \
      --auto-fund \
      --min-runway-days 30 \
      --max-balance 5.00
```

## Composing with a CAR-producing action

If you produce the CAR with [`ipfs-deploy-action`](https://github.com/ipshipyard/ipfs-deploy-action) (or any step that emits one), pass that CAR's path to `filecoin-pin import`. That project also maintains a [`filecoin-pin` recipe](https://github.com/ipshipyard/ipfs-deploy-action/tree/main/docs/recipes) for this exact pattern.

## Notes

- **Network flag.** Use `--network mainnet` or `--network calibration`. (There is no `--mainnet` / `--calibnet` shorthand.) Mainnet is the default, so `--network mainnet` is optional.
- **Gate this yourself.** Running the CLI spends wallet funds, so decide where it is allowed to run. The example workflow gates on `push` to the default branch; never run it on untrusted fork pull requests.
- **Pin the version.** The examples pin `filecoin-pin@0.22.3` so a future release cannot change behavior under your CI without a code review.
- **Egress.** The CLI defaults `--egress-provider` to `beam` (FilBeam CDN). Pass `--egress-provider none` to opt out. (Note: the composite upload-action defaults egress to `none` instead.)

## See also

- CLI reference: `npx filecoin-pin add --help` / `npx filecoin-pin import --help`
- Composite action: [upload-action README](../../README.md)
