# Filecoin Pin

[![NPM](https://nodei.co/npm/filecoin-pin.svg?style=flat&data=n,v)](https://nodei.co/npm/filecoin-pin/)

An IPFS Pinning Service API implementation that pins to Filecoin's PDP service, providing ongoing proof of possession of your pinned content using Filecoin's proving system.

## Overview

Filecoin Pin is a TypeScript server that implements the [IPFS Pinning Service API](https://ipfs.github.io/pinning-services-api-spec/) to enable users to pin IPFS content to Filecoin using familiar IPFS tooling like Kubo's `ipfs pin remote` commands.

### How It Works

1. **Serve Pin Service**: The server runs an HTTP service that implements the IPFS Pinning Service API
2. **Receive Pin Requests**: When you run `ipfs pin remote add`, Kubo sends a pin request to the service
3. **Fetch Blocks from IPFS**: The service connects to the IPFS network and fetches blocks for the requested CID (usually from the requesting node itself)
4. **Store in CAR**: As blocks arrive, they're written directly to a CAR (Content Addressable aRchive) file on disk
5. **Upload to PDP Provider**: Once all blocks are collected, the CAR file is uploaded to a Proof of Data Possession (PDP) service provider
6. **Commit to Filecoin**: The PDP provider commits the data to the Filecoin blockchain
7. **Start Proving**: The storage provider begins generating ongoing proofs that they still possess your data

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
filecoin-pin server
```

**Option 2: Use npx (installs automatically and runs)**
```bash
# No installation needed - npx downloads and runs it
npx filecoin-pin server
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

### Running the Server

⚠️ **PRIVATE_KEY is required** - The service will not start without it.

```bash
# If installed globally:
PRIVATE_KEY=0x... filecoin-pin server

# Or with npx:
PRIVATE_KEY=0x... npx filecoin-pin server

# With custom configuration:
PRIVATE_KEY=0x... PORT=8080 RPC_URL=wss://... filecoin-pin server
```

### CLI Usage

```bash
# Show help
filecoin-pin --help

# Show version
filecoin-pin --version

# Start server
filecoin-pin server

# Start server with options
filecoin-pin server --port 3456 --car-storage ./my-cars
```

## Using with IPFS

Once the server is running, you can configure it as a remote pinning service in IPFS.

### Using with Kubo CLI

```bash
# Add the pinning service (use any non-empty string as token - auth not currently enforced)
ipfs pin remote service add filecoin-pin http://localhost:3456 any-token

# Pin content to Filecoin
ipfs pin remote add --service=filecoin-pin QmYourContentCID

# List remote pins
ipfs pin remote ls --service=filecoin-pin

# Check pin status
ipfs pin remote ls --service=filecoin-pin --status=pinning,queued,pinned
```

### Using with IPFS Desktop or WebUI

You can also add this pinning service through the IPFS Desktop application or WebUI interface. See the [IPFS documentation on working with pinning services](https://docs.ipfs.tech/how-to/work-with-pinning-services/#use-a-third-party-pinning-service) for detailed instructions on:

- Adding remote pinning services via the GUI
- Managing pins through the web interface
- Configuring authentication tokens

The service endpoint will be `http://localhost:3456` (or your configured host/port). While the IPFS interface requires a token field, authentication is not currently enforced so any non-empty value will work.

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
