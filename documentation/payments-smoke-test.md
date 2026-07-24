# Payments smoke test

This operator tool creates a sanitized report for one proposed or explicitly authorized [payments smoke-test](glossary.md#payments-smoke-test) command. It is dry-run-only by default: it writes the requested report but does not start the [`filecoin-pin` CLI](glossary.md#filecoin-pin-cli), contact [Squid](glossary.md#squid) or an [RPC provider](glossary.md#rpc-provider), or submit a transaction. Normal CI exercises dry-run cases plus an unfunded fake-child execute-path test; it never runs the real CLI or a funded smoke. The experimental funded mainnet smoke is not a normal CI task.

Build the CLI before any authorized execute run:

```bash
pnpm run build
```

These commands are safe planning examples because neither includes `--execute`:

```bash
# Calibration direct-funding plan
node scripts/payments-smoke-test.mjs --network calibration --flow fund --amount 7.1 --mode minimum \
  --output /absolute/private/path/calibration-fund.json

# Mainnet acquisition plan. The exact source cap is mandatory even for a dry run.
node scripts/payments-smoke-test.mjs --network mainnet --flow fund --amount 4 --mode minimum \
  --source-cap 10 --output /absolute/private/path/mainnet-fund.json
```

`--output` is required and must point outside the repository checkout. The tool refuses to overwrite an existing report. On POSIX it creates the report with mode `0600`. Before any Windows mainnet run, choose an explicitly user-private output directory, restrict its ACL to the operator, and verify that another local user cannot read it; inherited/default ACLs are not sufficient. When `RPC_URL` is set for an execute run, the tool probes `eth_chainId` and refuses to start the CLI unless it matches `--network`. A mainnet execution additionally requires `--execute`, `--ack-mainnet`, and an exact source cap with at most six decimal places and no value greater than 10 USDC. It records the separate 0.0001 Arbitrum ETH native-gas cap for [FIL](glossary.md#fil) and [USDFC](glossary.md#usdfc) acquisition. Do not add `--execute` until the funded smoke is explicitly authorized and its exact inputs have been reviewed.

Inspect the requested/completed state, exit code, and sanitized output outside the checkout. Never commit generated reports, private keys, provider credentials, credential-bearing URLs, quote calldata, or unverified transaction identifiers.
