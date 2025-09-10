# Filecoin Pin

[![NPM](https://nodei.co/npm/filecoin-pin.svg?style=flat&data=n,v)](https://nodei.co/npm/filecoin-pin/)

An IPFS Pinning Service API implementation that pins to Filecoin's PDP service, providing ongoing proof of possession of your pinned content using Filecoin's proving system.

## Overview

Filecoin Pin is a TypeScript daemon that implements the [IPFS Pinning Service API](https://ipfs.github.io/pinning-services-api-spec/) to enable users to pin IPFS content to Filecoin using familiar IPFS tooling like Kubo's `ipfs pin remote` commands.

### How It Works

1. **Filecoin Pin daemon**: The Filecoin Pin daemon runs an HTTP server that implements the [IPFS Pinning Service API](https://ipfs.github.io/pinning-services-api-spec/) so it can serve pin requests.
2. **Receive Pin Requests**: When you run `ipfs pin remote add`, Kubo (or compatible IPFS node) sends a pin request to the Filecoin Pin daemon (assuming the Filecoin Pin Daemon has been configured as a pinning service for your Kubo client per [below](#using-with-ipfskubo)),
3. **Fetch Blocks from IPFS**: The Filecoin Pin daemon connects to the IPFS network and fetches blocks for the requested CID (usually from the requesting node itself).
4. **Store in CAR**: As the Filecoin Pin daemon receives blocks, it writes them directly to a CAR (Content Addressable aRchive) file on disk.
5. **Upload to PDP Provider**: Once all blocks are collected, the Filecoin Pin daemon uploads the CAR file to a Proof of Data Possession (PDP) service provider.
6. **Commit to Filecoin**: The PDP service provider commits the data to the Filecoin blockchain.
7. **Start Proving**: The PDP service provider begins generating ongoing proofs that they still possess your data.

This bridges the gap between IPFS's content-addressed storage and Filecoin's incentivized persistence layer, giving you the best of both worlds - easy pinning with long-term storage guarantees.

**⚠️ Alpha Software**: This is currently alpha software, only deploying on Filecoin's Calibration Test network with storage providers participating in network testing, not dedicating long-term persistence.

You need a Filecoin calibration network wallet funded with USDFC. See the [USDFC documentation](https://docs.secured.finance/usdfc-stablecoin/getting-started) which has a "Testnet Resources" section for getting USDFC on calibnet.

## Quick Start

### Prerequisites

Node.js 24+ and npm

### Installation

You can install `filecoin-pin` globally or use it directly with npx.

⚠️ **Note**: You'll need to set the `PRIVATE_KEY` environment variable before running - see [Configuration](#configuration) below.

**Option 1: Install globally (then run from anywhere)**
```bash
# First install it globally (one time)
npm install -g filecoin-pin

# Then you can run it from anywhere
filecoin-pin daemon
```

**Option 2: Use npx (installs automatically and runs)**
```bash
# No installation needed - npx downloads and runs it
npx filecoin-pin daemon
```

**Option 3: Build from source**
```bash
# Clone and build
git clone https://github.com/FilOzone/filecoin-pin
cd filecoin-pin
npm install
npm run build

# Run it
npm start
```

### Configuration

Configuration is managed through environment variables. The service uses platform-specific default directories for data storage following OS conventions.

#### Environment Variables

```bash
# REQUIRED - Without this, the service will not start
export PRIVATE_KEY="your-filecoin-private-key"      # Ethereum private key (must be funded with USDFC on calibration network)

# Optional configuration with defaults
export PORT=3456                                    # API server port (default: 3456)
export HOST="localhost"                             # API server host (default: localhost)
export RPC_URL="https://api.calibration.node.glif.io/rpc/v1"  # Filecoin RPC endpoint
export DATABASE_PATH="./pins.db"                    # SQLite database location (default: see below)
export CAR_STORAGE_PATH="./cars"                    # Temporary CAR file directory (default: see below)
export LOG_LEVEL="info"                             # Log level (default: info)
```

#### Default Data Directories

When `DATABASE_PATH` and `CAR_STORAGE_PATH` are not specified, the service uses platform-specific defaults:

- **Linux**: `~/.local/share/filecoin-pin/` (follows XDG Base Directory spec)
- **macOS**: `~/Library/Application Support/filecoin-pin/`
- **Windows**: `%APPDATA%/filecoin-pin/`
- **Other**: `~/.filecoin-pin/`

### Running the Daemon

⚠️ **PRIVATE_KEY is required** - The service will not start without it.

```bash
# If installed globally:
PRIVATE_KEY=0x... filecoin-pin daemon

# Or with npx:
PRIVATE_KEY=0x... npx filecoin-pin daemon

# With custom configuration:
PRIVATE_KEY=0x... PORT=8080 RPC_URL=wss://... filecoin-pin daemon
```

### CLI Usage

```bash
# Show help
filecoin-pin help

# Show version
filecoin-pin version

# Start server
filecoin-pin daemon
```

## Using with IPFS/Kubo

Once the daemon is running, configure it as a remote pinning service in Kubo:

```bash
# Add the pinning service (replace <bearer-token> with any non-empty string for now)
ipfs pin remote service add filecoin-pin http://localhost:3456 <bearer-token>

# Pin content to Filecoin
ipfs pin remote add --service=filecoin-pin QmYourContentCID

# List remote pins
ipfs pin remote ls --service=filecoin-pin

# Check pin status
ipfs pin remote ls --service=filecoin-pin --status=pinning,queued,pinned
```

## Development

For developers who want to contribute or build from source:

```bash
# Clone the repository
git clone https://github.com/FilOzone/filecoin-pin
cd filecoin-pin

# Install dependencies
npm install

# Start development server with hot reload
npm run dev

# Run tests
npm test
```

### Development Scripts

- `npm run build` - Compile TypeScript to JavaScript
- `npm run dev` - Start development server with hot reload
- `npm start` - Run compiled output (after building)
- `npm test` - Run linting, type checking, unit tests, and integration tests
- `npm run test:unit` - Run unit tests only
- `npm run test:integration` - Run integration tests only
- `npm run test:watch` - Run tests in watch mode
- `npm run lint` - Check code style with ts-standard
- `npm run lint:fix` - Auto-fix code style issues
- `npm run typecheck` - Type check without emitting files

## License

Dual-licensed under [MIT](https://opensource.org/licenses/MIT) + [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0)

## References

- [IPFS Pinning Service API Spec](https://ipfs.github.io/pinning-services-api-spec/)
- [Helia Documentation](https://helia.io/)
- [CAR Format Specification](https://ipld.io/specs/transport/car/)
- [SynapseSDK](https://github.com/FilOzone/synapse-sdk)
- [Filecoin Services Upload Demo App](https://fs-upload-dapp.netlify.app/)
