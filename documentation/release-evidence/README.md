# Release evidence runbook

This harness captures a sanitized record of one proposed or explicitly authorized release-evidence command. It is dry-run-only by default: it writes an ignored artifact but does not start the CLI, contact a provider, or submit a transaction. Normal CI exercises dry-run cases plus an unfunded fake-child execute-path test; it never runs the real CLI or a funded smoke. The experimental funded mainnet smoke remains pending and is not a normal CI task.

Build the CLI before any authorized execute run:

```bash
pnpm run build
```

These commands are safe planning examples because neither includes `--execute`:

```bash
# Calibration direct-funding evidence plan
node scripts/release-evidence.mjs --network calibration --flow fund --amount 7.1 --mode minimum

# Mainnet acquisition evidence plan. The exact source cap is mandatory even for a dry run.
node scripts/release-evidence.mjs --network mainnet --flow fund --amount 4 --mode minimum --source-cap 10
```

The harness writes a new artifact under `artifacts/release-evidence/` and refuses to overwrite an existing one. On POSIX it is created with mode `0600`. Before any Windows mainnet run, pass `--output` inside an explicitly user-private directory, restrict its ACL to the operator, and verify that another local user cannot read it; inherited/default ACLs are not sufficient evidence. When `RPC_URL` is set for an execute run, the harness probes `eth_chainId` and refuses to start the CLI unless it matches `--network`. A mainnet execution additionally requires `--execute`, `--ack-mainnet`, and an exact source cap with at most six decimal places and no value greater than 10 USDC. It records the separate 0.0001 Arbitrum ETH native-gas cap. Do not add `--execute` until the funded smoke is explicitly authorized and its exact inputs have been reviewed.

Artifacts are intentionally ignored. Inspect the requested/completed state, exit code, and sanitized output, then promote only verified, non-sensitive facts into a curated versioned evidence record. Never commit raw artifacts, private keys, provider credentials, credential-bearing URLs, quote calldata, or unverified transaction identifiers.
