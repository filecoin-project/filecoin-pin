# Developing Filecoin Pin

Tips and workflows for hacking on `filecoin-pin` itself. For user-facing docs
see the top-level [README](./README.md) and [`documentation/`](./documentation/README.md).

## Setup

Prerequisites: Node.js 24+ and `pnpm`. If `pnpm` isn't on your PATH, run
`corepack enable` once, this repo pins a pnpm version via the `packageManager`
field in `package.json`.

```bash
git clone https://github.com/filecoin-project/filecoin-pin
cd filecoin-pin
pnpm install
```

## Common Scripts

```bash
pnpm run build            # Compile TypeScript to dist/
pnpm run dev              # tsx watch on the pinning server (src/cli.ts server)
pnpm test                 # Lint + typecheck + unit + integration
pnpm run test:unit        # Unit tests only
pnpm run test:integration # Integration tests
pnpm run test:browser     # Browser tests
pnpm run lint:fix         # Auto-fix Biome formatting and lint issues
pnpm run typecheck        # tsc --noEmit
pnpm --dir upload-action run typecheck # Action package typecheck
```

## Running the CLI

There are several ways to run the CLI during development. Pick whichever fits
your edit loop.

```bash
# 1. Built output, mirrors what end users get from `filecoin-pin` after a
#    global install. Requires a prior `pnpm run build`.
node ./dist/cli.js <command>

# 2. npx against the local package (no global install, no stale cache).
#    Run from the package root; npx resolves `.` to this workspace.
npx .                     # same as `npx filecoin-pin` from here
npx . add ./myfile.txt

# 3. tsx, run the TypeScript sources directly, no build step. Fastest edit
#    loop when your changes are scoped to filecoin-pin only.
npx tsx src/cli.ts <command>

# 4. bun, also runs TypeScript directly if you have it installed.
bun src/cli.ts <command>
```

Any of these work with environment variables and flags the same way the
published CLI does, e.g. `PRIVATE_KEY=0x... NETWORK=calibration npx tsx src/cli.ts add ./file.txt`.

## Using a Local `synapse-sdk` Checkout

When your change spans both `filecoin-pin` and unpublished `synapse-sdk` work,
point this package at your local SDK checkout with a pnpm override. Edit the
root `package.json` and add (or extend) a `pnpm.overrides` block:

```json
{
  "pnpm": {
    "overrides": {
      "@filoz/synapse-sdk": "link:../synapse-sdk",
      "@filoz/synapse-core": "link:../synapse-sdk/packages/synapse-core"
    }
  }
}
```

Adjust the relative paths for your layout (the `synapse-sdk` repo publishes two
packages from a workspace: `@filoz/synapse-sdk` and `@filoz/synapse-core`).
Then:

```bash
# In the synapse-sdk checkout
pnpm install && pnpm run build

# Back in filecoin-pin
pnpm install              # re-resolves against the linked paths
npx tsx src/cli.ts <cmd>  # or npm run build && node ./dist/cli.js
```

Re-run `pnpm run build` in `synapse-sdk` any time you change SDK sources, the
published entry points live in its `dist/`, so tsx against `filecoin-pin` will
still resolve compiled SDK output.

**Don't commit the override block.** Revert before pushing, or keep it on a
local-only stash.

## Debug Logging

Prefix any command with `LOG_LEVEL=debug` for verbose application logs:

```bash
LOG_LEVEL=debug filecoin-pin add ./myfile.txt
```

## HTTP Tracing

To see every outbound HTTP request and its response status code, set
`NODE_DEBUG=fetch` (a built-in Node.js facility):

```bash
NODE_DEBUG=fetch filecoin-pin add ./myfile.txt
```

You'll see lines like:

```
FETCH 84357: connecting to calib2.ezpdpz.net using https:undefined
FETCH 84357: connected to calib2.ezpdpz.net using https:h1
FETCH 84357: sending request to POST https://calib2.ezpdpz.net/pdp/piece/uploads
FETCH 84357: received response to POST https://calib2.ezpdpz.net/pdp/piece/uploads - HTTP 201
FETCH 84357: trailers received from POST https://calib2.ezpdpz.net/pdp/piece/uploads
```

`NODE_DEBUG=fetch` includes the full URL with query string, but does **not**
show request/response headers or bodies. For deeper inspection, route traffic
through a local proxy like `mitmproxy`.

## Running Against a Local Devnet

For end-to-end testing without calibnet gas and latency, run against a local
[foc-devnet](https://github.com/filecoin-project/foc-devnet) cluster. See
foc-devnet's README for bringing up a cluster; once it's running:

```bash
# Reads devnet-info.json from ~/.foc-devnet/state/latest/ by default.
# Private key and RPC URL are auto-resolved; --skip-ipni is implied.
npx tsx src/cli.ts add ./myfile.txt --network devnet
```

Useful environment variables:

| Variable | Purpose | Default |
|---|---|---|
| `FOC_DEVNET_BASEDIR` | Override the foc-devnet base directory | `~/.foc-devnet` |
| `DEVNET_INFO_PATH` | Explicit path to `devnet-info.json` | `<basedir>/state/latest/devnet-info.json` |
| `DEVNET_USER_INDEX` | Which user from `devnet-info.json` to fund the run | `0` |

Devnet URLs shown in CLI output are rewritten so they're reachable from the
host, they won't work outside the devnet network, but they're accurate for
local inspection. Because IPNI is skipped on devnet, there is no global
content routing; retrievals must go straight to a storage provider. The `add`
command prints a `Retrieval URL` per copy ending in `/piece/<pieceCid>`. Swap
that for `/ipfs/<rootCid>` (also printed as `Root CID`) to hit the SP's IPFS
endpoint directly, e.g. `?format=raw` for the root block or `?format=car`
for the whole DAG. This is the same pattern foc-devnet's CI scenarios use
to end-to-end test filecoin-pin.

## Tips

### Upload unique data during testing

Because Filecoin (and IPFS) are content-addressed, re-uploading the same bytes
can be indistinguishable from a no-op: dedup at any layer masks bugs in the
store / pull / commit pipeline. Generate unique payloads when you want to
exercise the full path:

```bash
# Small, unique, and easy to eyeball on retrieval.
TMPFILE=$(mktemp) && date > "$TMPFILE" && filecoin-pin add "$TMPFILE"
```

For larger unique files use `head -c <bytes> /dev/urandom > "$TMPFILE"`.

### Watch for stale dist/

`node ./dist/cli.js` runs whatever was last built. When in doubt during an
edit/test loop, prefer `npx tsx src/cli.ts` or rebuild before each run.
