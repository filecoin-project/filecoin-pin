## Setup
```bash
# Clone and install
git clone https://github.com/filecoin-project/filecoin-pin
cd filecoin-pin
npm install
```

## Basic Execution
```bash
# Run the Pinning Server
npm run dev

# Run tests
npm test

# Compile TypeScript source
npm run build

# Run the cli
# This is the equivalent of running `filecoin-pin` if you had it installed globally (e.g., `npm install filecoin-pin -g`).
# It's like doing `npx filecoin-pin` that isn't stuck on that version until you `run npm install filecoin-pin -g` again.
node ./dist/cli.js
```

## Testing

```bash
npm run test             # All tests
npm run test:unit        # Unit tests only
npm run test:integration # Integration tests
npm run test:browser     # Browser tests
npm run lint:fix         # Fix formatting
```

Below are various tips and suggestions for doing development with `filecoin-pin`.

## Tips
### Debug Logging
Prefix your `filecoin-pin` command with `LOG_LEVEL=debug`.

### HTTP Tracing on the CLI

If you want to see the HTTP calls and their response codes when running the `filecoin-pin` CLI, simply set `NODE_DEBUG=fetch`.

For example: 

```bash
NODE_DEBUG=fetch filecoin-pin add $TMPFILE
```

This will yield log lines like:

```bash
FETCH 84357: connecting to calib2.ezpdpz.net using https:undefined
FETCH 84357: connected to calib2.ezpdpz.net using https:h1
FETCH 84357: sending request to POST https://calib2.ezpdpz.net//pdp/piece/uploads
FETCH 84357: received response to POST https://calib2.ezpdpz.net//pdp/piece/uploads - HTTP 201
FETCH 84357: trailers received from POST https://calib2.ezpdpz.net//pdp/piece/uploads
```

Note that this doesn't show query string, headers, request/response payload.  

### Running CLI changes made to `filecoin-pin` only

If you want to quickly try out changes via CLI that were made in `filecoin-pin` only (i.e., not relying on unpublished changes in `synapse-sdk`):

```bash
npx tsx src/cli.ts $COMMAND
```

### Running CLI changes involving `synapse-sdk`

If you want within the `filecoin-pin` CLI to try out out `synapse-sdk` changes made locally that haven't been published:

```bash
# Commands for building Synapse
# Commands for adjusting filecoin-pin to use local Synapse 
npx tsx src/cli.ts $COMMAND
```

### Quickly adding unique data

Because of content addressing, it's valuable to upload unique data to make sure there is no deduplication in the end-to-end store and retrieval flow.  Various quick ways to do this:

1. Use temp file with the date/time.  The file is small, it's very likely to be unique, and it's easy to verify in retrievals rather than random data.  
```bash
TMPFILE=$(mktemp) && date > $TMPFILE && filecoin-pin add $TMPFILE
```
