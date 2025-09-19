# Synapse SDK Integration Examples

This directory contains examples demonstrating how to integrate with the [Synapse SDK](https://github.com/FilOzone/synapse-sdk) for interacting with Filecoin Onchain Cloud.

Synapse is abstracted within Filecoin Pin to isolate it as an educational resource, to integrate with our logging system, and to make mocking easier for testing.

## Module Overview

### [`service.ts`](./service.ts) - SDK Initialization & Lifecycle

Core patterns for initializing and managing the Synapse SDK lifecycle:

- **SDK Configuration**: Network selection, RPC URLs, private key management
- **Storage Context Creation**: Provider selection, dataset management
- **Event Tracking**: Comprehensive callbacks for monitoring operations
- **WebSocket Cleanup**: Proper resource management for WebSocket providers
- **Service Singleton Pattern**: Reusable service management

### [`upload.ts`](./upload.ts) - Data Upload Patterns

Reusable upload functionality for CAR files to Filecoin:

- **Unified Upload Interface**: Consistent API for different upload sources
- **Progress Monitoring**: Upload, piece addition, and confirmation callbacks
- **Metadata Association**: IPFS CID linking with Filecoin pieces
- **Provider Information**: Direct download URLs from storage providers

### [`payments.ts`](./payments.ts) - Payment Operations

Comprehensive payment rail management for Filecoin Pay:

- **Balance Management**: FIL (gas) and USDFC (storage payments)
- **Token Operations**: ERC20 approve/deposit patterns
- **Service Approvals**: Storage operator authorization
- **Capacity Calculations**: Human-friendly storage unit conversions

## Filecoin Pin Use Examples

Below are examples of how we use our custom Synapse SDK abstractions from within Filecoin Pin.

### Initialize Synapse SDK

```typescript
import { RPC_URLS } from '@filoz/synapse-sdk'
import { initializeSynapse } from './synapse/service.js'

const config = {
  privateKey: process.env.PRIVATE_KEY,
  rpcUrl: RPC_URLS.calibration.websocket
}

const synapseService = await initializeSynapse(config, logger, {
  onProviderSelected: (provider) => {
    console.log(`Selected provider: ${provider.name}`)
  },
  onDataSetResolved: (info) => {
    console.log(`Dataset ID: ${info.dataSetId}`)
  }
})
```

### Upload CAR File

```typescript
import { uploadToSynapse } from './synapse/upload.js'
import { CID } from 'multiformats/cid'

const carData = await fs.readFile('path/to/file.car')
const rootCid = CID.parse('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi')

const result = await uploadToSynapse(
  synapseService,
  carData,
  rootCid,
  logger,
  {
    callbacks: {
      onUploadComplete: (pieceCid) => {
        console.log(`Upload complete: ${pieceCid}`)
      }
    }
  }
)

console.log(`Piece CID: ${result.pieceCid}`)
console.log(`Download URL: ${result.providerInfo?.downloadURL}`)
```

### Setup Payments

```typescript
import {
  depositUSDFC,
  setServiceApprovals,
  calculateStorageAllowances
} from './synapse/payments.js'
import { ethers } from 'ethers'

// Deposit 100 USDFC
const depositAmount = ethers.parseUnits('100', 18)
const { depositTx } = await depositUSDFC(synapse, depositAmount)

// Calculate allowances for 10 TiB/month
const storageInfo = await synapse.storage.getStorageInfo()
const pricing = storageInfo.pricing.noCDN.perTiBPerEpoch
const allowances = calculateStorageAllowances(10, pricing)

// Set service approvals
const txHash = await setServiceApprovals(
  synapse,
  allowances.rateAllowance,
  allowances.lockupAllowance
)
```
