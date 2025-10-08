# Synapse SDK Helpers (Deprecated Location)

The payment- and upload-related Synapse helpers now live under `src/core/` so
that all runtime logic is shared consistently across the CLI, GitHub Action,
and future SDK consumers. Please see [`src/core/payments/README.md`](../core/payments/README.md)
for the full documentation that originally accompanied this directory.

The remaining modules in `src/synapse/` either proxy to the new core layers or
are awaiting relocation. Both `service.ts` and `upload.ts` now re-export the
implementation in `src/core/synapse/` and `src/core/upload/`; clients should
update imports to the new locations.
