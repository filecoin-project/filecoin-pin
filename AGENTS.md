# Filecoin Pin

IPFS persistence layer for Filecoin with verifiable storage proofs. TypeScript library + CLI + GitHub Action.

## What This Is

Bridges IPFS content to Filecoin storage providers with cryptographic guarantees. Production tool + reference implementation for building on synapse-sdk.

**Affordances**: CLI (`add`, `payments`, `data-set`), GitHub Action, core library (published npm modules), IPFS Pinning Server (`server` daemon).

**Stack**: filecoin-pin → synapse-sdk → FOC contracts (FWSS, FilecoinPay, PDPVerifier, SPRegistry) + Curio.

**Status**: Calibration testnet only. Not production-ready.

## Design Philosophy

**Reference Implementation**: Demonstrates opinionated, documented patterns for building on synapse-sdk. Code clarity and educational value over abstraction.

**Developer Learning**: Primary use case is teaching developers how to build on FOC stack. Favor explicit, traceable code over clever shortcuts.

**Simple API Surface**: Keep public interfaces minimal and focused. Complexity lives in internal implementation, not exposed APIs.

## Architecture

```
src/
├── cli.ts, server.ts              # Commander.js CLI + Fastify server
├── add/, data-set/                # Command implementations
├── core/                          # Published library (see package.json exports)
│   ├── car/                       # CAR file handling (CARv1 streaming)
│   ├── payments/                  # Payment setup/status
│   ├── synapse/                   # SDK initialization patterns
│   ├── upload/                    # Upload workflows
│   ├── unixfs/                    # Helia integration, browser/node variants
│   └── utils/                     # Formatting, constants
└── common/                        # Internal shared code
```

**Data flow**: Files → Helia/UnixFS → CAR → Synapse SDK → FOC contracts + Curio → PieceCID + proofs.

## Development

**Setup**: `npm install && npm run build && npm test`

**Scripts**: `npm run build` (tsc), `npm run dev` (tsx watch), `npm test` (lint + typecheck + unit + integration), `npm run lint:fix`

**Requirements**: Node.js 24+, TypeScript ES modules, Biome linting

**Tests**: Vitest (unit + integration), mock SDK at `src/test/mocks/synapse-sdk.js`

## Key Patterns

**Synapse SDK**: Initialize with callbacks (onProviderSelected, onDataSetResolved, onPieceAdded), upload returns {pieceCid, pieceId, provider}. See `src/core/synapse/index.ts`, `src/core/upload/synapse.ts`.

**CAR files**: CARv1 streaming, handle 3 root cases (single/multiple/none), use zero CID for no roots. See `src/core/car/car-blockstore.ts`.

**UnixFS**: Helia for directory imports, chunking, CID calculation. See `src/core/unixfs/`.

**Payments**: `checkPaymentStatus()`, `setupPayments()` in `src/core/payments/index.ts`.

## Biome Linting (Critical)

- **NO** `!` operator → use `?.` or explicit checks
- **MUST** use `.js` extensions in imports (`import {x} from './y.js'` even for .ts)
- **NO** semicolons at line end (`semicolons: "asNeeded"`)
- **MUST** use kebab-case filenames

## Common Pitfalls

1. Import extensions required (`.js` even for .ts files)
2. Handle 3 CAR root cases (none/single/multiple)
3. Provider info may be undefined
4. Clean up CAR files and Helia instances on failure
5. Browser vs Node variants (check package.json exports)

## CLI & Environment

**Commands**: `payments setup --auto`, `add <file>`, `payments status`, `data-set <id>`, `server`

**Required env**: `PRIVATE_KEY=0x...` (with USDFC tokens)

**Optional**: `RPC_URL` (default: Calibration), `PORT`, `HOST`, `DATABASE_PATH`, `CAR_STORAGE_PATH`, `LOG_LEVEL`

**Default data dirs for pinning server**: Linux `~/.local/share/filecoin-pin/`, macOS `~/Library/Application Support/filecoin-pin/`, Windows `%APPDATA%/filecoin-pin/`

## Git Policy

Conventional commits. Never `git commit` or `git push` without explicit user permission. Ask first, draft message, wait for approval.

## License

Apache-2.0 OR MIT
