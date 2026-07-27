# Payments acquisition fixtures

These fixtures were captured from Squid's live v2 API on 2026-07-23 and reduced
to the fields Filecoin Pin consumes.

- Integrator credentials and HTTP headers are omitted.
- Quote and request IDs are synthetic.
- Transaction calldata is reduced to its real function selector so tests cannot
  accidentally submit a captured route.
- The owner is the intentionally public, unfunded `0xF00D` test address.
- Amounts, targets, gas fields, token metadata, route stages, and status shapes
  retain the captured API representation.

Tests must use these files deterministically and must not refresh them from the
network. Refreshing a fixture requires a new provider-validation review because
spender, target, status, and recovery semantics can change.

`squid-selected-source-catalog.json` is a reduced synthetic EVM catalog shape
for resolver tests. Its test-only addresses never authorize routes or approvals.
