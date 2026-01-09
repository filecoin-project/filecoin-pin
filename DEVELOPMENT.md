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

### HTTP Tracing
TBD: depends on https://github.com/filecoin-project/filecoin-pin/issues/298

### Running CLI changes made to `filecoin-pin` only

If you want to quickly try out changes via CLI that were made in `filecoin-pin` only (i.e., not relying on unpublished changes in `synapse-sdk`):

```
npx tsx src/cli.ts $COMMAND
```

### Running CLI changes involving `synapse-sdk`

If you want within the `filecoin-pin` CLI to try out out `synapse-sdk` changes made locally that haven't been published:

```
# Commands for building Synapse
# Commands for adjusting filecoin-pin to use local Synapse 
npx tsx src/cli.ts $COMMAND
```

