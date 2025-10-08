# Synapse SDK Helpers (Deprecated Location)

The payment- and upload-related Synapse helpers now live under `src/core/` so
that all runtime logic is shared consistently across the CLI, GitHub Action,
and future SDK consumers. Please see [`src/core/payments/README.md`](../core/payments/README.md)
for the full documentation that originally accompanied this directory.

The remaining modules in `src/synapse/` either proxy to the new core layers or
are awaiting relocation. The legacy `upload.ts` helper has now moved entirely to
`src/core/upload/`; clients must update imports to the new location.
