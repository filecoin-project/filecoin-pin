# Synapse SDK Helpers (Deprecated Location)

The payment- and upload-related Synapse helpers now live under `src/core/` so
that all runtime logic is shared consistently across the CLI, GitHub Action,
and future SDK consumers. Please see [`src/core/payments/README.md`](../core/payments/README.md)
for the full documentation that originally accompanied this directory.

The modules in `src/synapse/` now act as thin re-export shims to maintain
backwards compatibility with older import paths. New code should consume the
relevant helpers from `src/core/` instead.
