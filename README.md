# Filecoin Pin

[![NPM](https://nodei.co/npm/filecoin-pin.svg?style=flat&data=n,v)](https://nodei.co/npm/filecoin-pin/)

Bridge IPFS content to Filecoin storage using familiar tools.

## What It Does

Filecoin Pin provides two ways to store data on Filecoin:

1. **IPFS Pinning Service** - Use `ipfs pin remote` commands to pin content to Filecoin
2. **Direct CAR Import** - Upload existing CAR files directly to Filecoin

Both methods use Synapse SDK to handle Filecoin storage deals, providing persistent storage with cryptographic proofs.

## Installation

Requires Node.js 24+

```bash
npm install -g filecoin-pin
```

## Quick Start

### 1. Set Up Payments (Required First Step)

Before storing data, configure your Filecoin payment approvals:

```bash
# Check your current payment status
filecoin-pin payments status

# Interactive setup (recommended)
filecoin-pin payments setup

# Or automated setup
filecoin-pin payments setup --deposit 100 --storage 10TiB --auto
```

You'll need:
- A private key with USDFC tokens on Calibration testnet
- Get test USDFC from the [faucet](https://docs.secured.finance/usdfc-stablecoin/getting-started#testnet-resources)

### 2. Choose Your Storage Method

#### Option A: Run IPFS Pinning Service

```bash
# Start the daemon
PRIVATE_KEY=0x... filecoin-pin daemon

# In another terminal, configure IPFS
ipfs pin remote service add filecoin http://localhost:3456 any-token

# Pin content
ipfs pin remote add --service=filecoin QmYourCID
```

#### Option B: Import CAR Files Directly

```bash
# Import a CAR file
filecoin-pin import /path/to/file.car --private-key 0x...
```

## Commands

### `filecoin-pin daemon`
Runs the IPFS Pinning Service API server.

**Options:**
- `--port <number>` - Server port (default: 3456)
- `--host <string>` - Server host (default: localhost)
- `--database <path>` - SQLite database location
- `--car-storage <path>` - CAR file storage directory

### `filecoin-pin payments status`
Check payment configuration and balances.

**Options:**
- `--private-key <key>` - Ethereum private key
- `--rpc-url <url>` - Filecoin RPC endpoint

### `filecoin-pin payments setup`
Configure payment approvals for Filecoin storage.

**Options:**
- `--private-key <key>` - Ethereum private key
- `--rpc-url <url>` - Filecoin RPC endpoint
- `--deposit <amount>` - USDFC amount to deposit
- `--storage <size>` - Storage allowance (e.g., "10TiB" or "5000" for USDFC/epoch)
- `--auto` - Run without prompts

### `filecoin-pin import <file>`
Import an existing CAR file to Filecoin.

**Options:**
- `--private-key <key>` - Ethereum private key
- `--rpc-url <url>` - Filecoin RPC endpoint

**Output includes:**
- Piece CID for retrieval
- Storage provider details
- Direct download URL

## Configuration

### Environment Variables

```bash
# Required for daemon
PRIVATE_KEY=0x...              # Ethereum private key with USDFC

# Optional
RPC_URL=wss://...              # Filecoin RPC (default: calibration websocket)
PORT=3456                      # Daemon port
DATABASE_PATH=./pins.db        # SQLite database
CAR_STORAGE_PATH=./cars        # CAR file directory
LOG_LEVEL=info                 # Logging level
```

### Default Directories

When not specified, data is stored in:
- **Linux**: `~/.local/share/filecoin-pin/`
- **macOS**: `~/Library/Application Support/filecoin-pin/`
- **Windows**: `%APPDATA%/filecoin-pin/`

## How It Works

### IPFS Pinning Flow
1. Receive pin request from IPFS
2. Create CAR file with root CID
3. Fetch blocks via Bitswap
4. Stream blocks directly to CAR
5. Upload CAR to Synapse
6. Return Filecoin piece CID

### CAR Import Flow
1. Validate CAR file format
2. Extract root CIDs
3. Upload to Synapse
4. Display storage provider info

## Development

```bash
# Clone and install
git clone https://github.com/filecoin-project/filecoin-pin
cd filecoin-pin
npm install

# Run development server
npm run dev

# Run tests
npm test

# Build for production
npm run build
```

### Testing

```bash
npm run test           # All tests
npm run test:unit      # Unit tests only
npm run test:integration # Integration tests
npm run lint:fix       # Fix formatting
```

## Status

**⚠️ Alpha Software** - Currently running on Filecoin Calibration testnet only. Not for production use.

## License

Dual-licensed under [MIT](LICENSE-MIT) + [Apache 2.0](LICENSE-APACHE)

## References

- [IPFS Pinning Service API](https://ipfs.github.io/pinning-services-api-spec/)
- [Synapse SDK](https://github.com/filecoin-project/synapse-sdk)
- [USDFC Documentation](https://docs.secured.finance/usdfc-stablecoin)