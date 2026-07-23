# Payments acquisition route

Status: **go with restrictions**, validated 2026-07-23.

This record defines the first external token-acquisition route used by Filecoin
Pin. It does not replace the existing [Filecoin Pay](glossary.md#filecoin-pay)
deposit path. Acquisition only brings missing [FIL](glossary.md#fil) and
[USDFC](glossary.md#usdfc) into the owner wallet; the existing
[Synapse](glossary.md#synapse) integration remains responsible for the deposit
and Filecoin Warm Storage Service approval.

## Approved route

The first release supports exactly two output-driven legs from the same owner:

| Field | FIL leg | USDFC leg |
| --- | --- | --- |
| Provider | [Squid](glossary.md#squid) v2 API | Squid v2 API |
| Source chain | Arbitrum One (`42161`) | Arbitrum One (`42161`) |
| Source token | native USDC, 6 decimals, `0xaf88d065e77c8cc2239327c5edb3a432268e5831` | same |
| Destination chain | Filecoin mainnet (`314`) | Filecoin mainnet (`314`) |
| Destination token | native sentinel `0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee` | USDFC, 18 decimals, `0x80b98d3aa09ffff255c3ba4a241111ff1262f045` |
| Recipient | the source signer address | the source signer address |

Both legs must use one EVM owner address on the source and destination chains.
No other chain, source token, destination token, recipient, or provider target
is part of the allowlist.

The provider accepts a source amount rather than a required output amount.
Filecoin Pin therefore plans each leg from its exact wallet shortfall and finds
a source amount whose `toAmountMin` covers that shortfall:

1. Quote an estimated source amount for the leg.
2. If `toAmountMin` is short, scale the source amount by
   `ceil(currentSource * requiredOutput / toAmountMin)` and quote again.
3. Allow no more than four planning quote attempts per leg. Honor at most one
   bounded `Retry-After` retry for each attempt that receives HTTP 429.
4. Sum both source amounts and fail before any approval if the user-provided
   maximum would be exceeded.
5. Finalize each leg with at most two additional fixed-input quote attempts:
   one immediately before approval and one after approval confirmation. The
   fixed input is the exact planned source amount; a refresh must not silently
   increase it. Recheck the output requirement, target allowlist, expiry,
   cumulative source maximum, and total native-gas maximum on both attempts.

The planning and finalization phases therefore permit at most six quote
attempts per leg and at most twelve HTTP requests if every attempt uses its
single 429 retry. If the post-approval fixed-input route no longer meets the
required output, changes any allowlisted field, or exceeds either cap, do not
execute it and do not reapprove automatically. Report the exact outstanding
allowance and route identifiers and require an explicit rerun. A rerun must
re-read the allowance; if its newly planned exact input differs, replace the
allowance before obtaining another post-approval route. This is the only
reapproval path.

The two legs are independent transactions. A FIL leg that succeeds must not be
repeated merely because the USDFC leg is incomplete.

## Live evidence

Read-only calls with the dedicated integrator identity returned HTTP 200 from
the live `/v2/chains` and `/v2/tokens` endpoints. The response contained
Filecoin mainnet and the three destination assets relevant to this decision:

- native FIL, 18 decimals;
- WFIL at `0x60e1773636cf5e4a227d9ac24f20feca034ee25a`, 18 decimals;
- USDFC at `0x80b98d3aa09ffff255c3ba4a241111ff1262f045`,
  18 decimals.

Filecoin [Calibration](glossary.md#calibration-network) (`314159`) was absent
from both the supported chain and token sets. Acquisition must fail closed on
Calibration and local devnet. Those environments test direct Filecoin-side
funding only.

Live route probes used the disposable, unfunded
`0x000000000000000000000000000000000000F00D` owner. No transaction was signed
or submitted.

| Source amount | Output | Observed minimum output | Estimated duration |
| --- | --- | --- | --- |
| 0.5 USDC | FIL | 0.677010422296478806 FIL | 90 seconds |
| 1 USDC | FIL | 1.354019088160762983 FIL | 90 seconds |
| 0.5 USDC | USDFC | 0.489408816834980334 USDFC | 90 seconds |
| 1 USDC | USDFC | 0.978817475619899121 USDFC | 90 seconds |
| 5 USDC | FIL | 6.770027892972110136 FIL | 90 seconds |
| 5 USDC | USDFC | 4.894083014213259056 USDFC | 90 seconds |

These observations prove a usable floor of **at most 0.5 USDC per leg** on the
captured route. They are fixtures and budget inputs, not stable exchange-rate
guarantees. Runtime quotes remain authoritative.

The captured path was:

1. swap Arbitrum USDC to axlUSDC through PancakeSwap V3;
2. bridge axlUSDC to Filecoin through Axelar;
3. swap axlUSDC to USDFC through SushiSwap V3;
4. for the FIL leg, swap USDFC to WFIL and unwrap WFIL to native FIL.

The provider estimated about 90 seconds. The 5 USDC probes estimated about
0.000012 Arbitrum ETH in source execution gas and included a separate native
`transactionRequest.value` for destination gas. The two captured execution
commitments total 0.000064392661400073 Arbitrum ETH. That figure excludes the
ERC-20 approval transactions, so it is not itself a sufficient source-native
budget.

Before any approval, runtime must estimate every approval transaction the run
will send and combine those estimates with every current route commitment:

```text
required source native balance = sum(
  approval.gasLimit * approval.feeCap
) + sum(
  route.transactionRequest.value
  + route.transactionRequest.gasLimit * route.transactionRequest.feeCap
)
```

Here `feeCap` is the transaction's effective maximum fee per gas, such as
`maxFeePerGas`. Include allowance replacements and any other source-chain
transaction the run constructs. Recompute this total after each route refresh
and before every signature, reserving the still-required transactions for the
other leg. Fail before the first approval, or stop before the next signature,
if either the wallet balance or the hard native-gas cap is insufficient.

## Credential and request handling

The dedicated Squid integrator ID is passed in the
`SQUID_INTEGRATOR_ID` environment variable and sent only in the
`x-integrator-id` header. Its value must not be committed, written to fixtures,
included in telemetry, or printed by the CLI. Acquisition is unavailable when
the variable is absent.

Every quote request must set `quoteOnly: false`, use the same signer for
`fromAddress` and `toAddress`, and capture both:

- `route.quoteId`, used for current status requests;
- the `x-request-id` response header or legacy
  `transactionRequest.requestId`, retained for support and recovery.

Squid recommends refreshing routes every 20 seconds. The captured Axelar route
also reported an `expiryOffset` of 30 seconds. Filecoin Pin must never submit an
expired route and must refresh after user interaction, approval delay, or any
other pause that crosses the refresh window. The post-approval refresh uses the
already-approved fixed source amount; it either still satisfies the planned
output and all caps or the leg stops without execution.

## Spender and signing contract

The live routes targeted Squid's canonical mainnet `SquidRouter`:
`0xce16F69375520ab01377ce7B88f5BA8C48F8D666`.

For the captured route, the owner grants a normal ERC-20 allowance directly to
that target. The selected route does **not** require Permit2. The OmniPin
reference used Permit2, but current provider behavior is the authority for this
integration.

Before every approval or execution, Filecoin Pin must verify that:

- `transactionRequest.target` is the canonical allowlisted router;
- the source token, chain, amount, destination, token, and recipient still
  match the planned leg;
- the calldata is non-empty;
- the exact leg input and cumulative source spend remain within the cap.

Authorize only the exact source amount for the current leg. Re-read allowance
for each leg even when both quotes currently return the same target. A
post-approval refresh never authorizes an increased amount in the same run. If
the approved amount is no longer sufficient, stop and require an explicit
rerun; that rerun replaces a differing stale allowance before execution. If a
future route requires Permit2, returns a different target, or changes the
spender model, fail closed and update this decision record before enabling it.

## Status, timeout, and recovery

Poll the Squid status endpoint every five seconds initially, then every
15 seconds after two minutes. Stop automatic polling after the greater of
15 minutes or twice `estimatedRouteDuration`. A timeout is an unknown/incomplete
result, never permission to submit the source transaction again.

| Squid status | Filecoin Pin result | Recovery |
| --- | --- | --- |
| `success` | terminal success | Verify the destination wallet balance before starting the next stage. |
| `ongoing` | retryable | Keep polling within the bounded deadline. |
| `not_found` | initially retryable | Indexing can lag, especially on Filecoin. At the deadline, report incomplete with identifiers and do not resubmit. |
| `needs_gas` | terminal incomplete | Show the Axelar/Squid explorer URL and require explicit recovery after destination gas is supplied. |
| `partial_success` | terminal incomplete | Inspect the destination wallet for the bridged asset, recompute shortfalls, and never repeat the source spend blindly. |
| `refund` | terminal incomplete | Verify the source refund, recompute balances, and require an explicit rerun. |
| HTTP 429 | bounded retry | Honor `Retry-After` once per quote attempt. |
| Other provider, validation, or RPC error | failure | Preserve identifiers, do not advance to deposit, and do not retry a submitted transaction automatically. |

Persist or print enough recovery evidence to identify each leg without exposing
credentials: leg name, quote ID, request ID, source transaction hash,
destination transaction hash when available, source/destination chain IDs, and
provider explorer links.

Reruns begin by refreshing Filecoin wallet balances and Filecoin Pay state.
They acquire only the remaining shortfall. A recorded transaction with an
unknown or incomplete terminal result blocks automatic reacquisition until its
status or destination balance is resolved.

## Environment support

| Environment | Acquisition support | What it proves |
| --- | --- | --- |
| Deterministic tests | sanitized fixtures and mocked RPCs | planning, caps, spender validation, ordering, status mapping, and recovery |
| local `foc-devnet` | mocked acquisition only | real local Filecoin Pay deposit and rerun behavior |
| Calibration | unsupported; fail closed | real public-network direct USDFC deposit and Filecoin-side approval |
| Squid/Tenderly fork | unavailable for this gate | the published legacy hostname did not resolve and no Filecoin fork endpoint was discoverable |
| Filecoin mainnet | supported | real route execution remains the funded release evidence in issue #6 |

A fork would not replace issue #6 even if one becomes available because it
cannot prove live bridge delivery or production liquidity.

## Release smoke budget

The existing Filecoin gas reserve is 0.1 FIL. Initial setup currently requires
about 3.32 USDFC for two data sets under the test price model. The live probes
showed that these outputs fit comfortably below 5 source USDC in total at the
captured rates.

Issue #6 must use these hard maximums unless a separately reviewed update
lowers or raises them:

- **10 USDC total source-token spend** across both legs;
- **0.0001 Arbitrum ETH** total for every source-chain transaction commitment,
  including exact-amount approvals, allowance replacements, and both route
  executions;
- exact-amount ERC-20 approvals only.

The captured route executions consume about 64.4% of that native cap before
approval gas. Runtime estimation, not this observation, decides whether the
complete transaction set fits. Any current quote or approval plan that causes
either cap to be exceeded is a no-go for the smoke test. The operator must
record starting balances, both quotes, approval gas estimates and transactions,
route transaction hashes, destination arrivals, the Filecoin Pay deposit, and
the no-duplicate rerun.

Same-chain FIL to USDFC remains deferred. The approved first route acquires both
assets directly from Arbitrum USDC, which avoids spending the newly acquired
Filecoin gas reserve.

## Sources

- [Squid supported chains and tokens](https://docs.squidrouter.com/api-and-sdk-integration/key-concepts/get-supported-tokens-and-chains)
- [Squid route requests](https://docs.squidrouter.com/api-and-sdk-integration/key-concepts/get-a-route)
- [Squid status semantics](https://docs.squidrouter.com/api-and-sdk-integration/key-concepts/track-status)
- [Squid mainnet contracts](https://docs.squidrouter.com/additional-resources/contracts)
- [Legacy Squid/Tenderly environment](https://docs.squidrouter.com/additional-resources/additional-dev-resources/squid-x-tenderly)
- [OmniPin reference implementation](https://github.com/omnipin/omnipin/commit/dee5a24a12b71b28dd78d9b7ac7ac31606a34baf)
