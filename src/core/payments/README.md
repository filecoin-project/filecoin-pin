# Synapse SDK Integration Examples

Filecoin Pin is first and foremost a reference implementation. The modules in
`src/core/` expose the API surface we reuse across the CLI, GitHub Action, and
sample integrations so that the business logic stays in one place while the
surrounding UX layers remain easy to follow, fork, and remix.

This document shows how the payment helpers exported from
`filecoin-pin/core/payments` map onto the underlying [Synapse SDK](https://github.com/FilOzone/synapse-sdk).

Synapse is abstracted within Filecoin Pin to isolate it as an educational resource, to integrate with our logging system, and to make mocking easier for testing.

## Module Overview

### [`core/synapse`](../synapse/index.ts) - SDK Initialization & Lifecycle

Core patterns for initializing and managing the Synapse SDK lifecycle:

- **SDK Configuration**: Network selection, RPC URLs, private key management
- **Storage Context Creation**: Provider selection, dataset management
- **Event Tracking**: Comprehensive callbacks for monitoring operations
- **WebSocket Cleanup**: Proper resource management for WebSocket providers
- **Service Singleton Pattern**: Reusable service management

### [`core/upload`](../upload/index.ts) - Data Upload Patterns

Reusable upload functionality for CAR files to Filecoin:

- **Unified Upload Interface**: Consistent API for different upload sources
- **Progress Monitoring**: Upload, piece addition, and confirmation callbacks
- **Metadata Association**: IPFS CID linking with Filecoin pieces
- **Provider Information**: Direct download URLs from storage providers

### [`index.ts`](./index.ts) - Payment Operations

Comprehensive payment rail management for Filecoin Pay:

- **Balance Management**: FIL (gas) and USDFC (storage payments)
- **Token Operations**: ERC20 approve/deposit patterns
- **Service Approvals**: Storage operator authorization
- **Capacity Calculations**: Human-friendly storage unit conversions

## Filecoin Pin Use Examples

Below are examples of how we use our custom Synapse SDK abstractions from within Filecoin Pin.

### Set up Synapse Service

```typescript
import { RPC_URLS } from '@filoz/synapse-sdk'
import { setupSynapse } from 'filecoin-pin/core/synapse'

const config = {
  privateKey: process.env.PRIVATE_KEY,
  rpcUrl: RPC_URLS.calibration.websocket
}

const synapseService = await setupSynapse(config, logger, {
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
import { uploadToSynapse } from 'filecoin-pin/core/upload'
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
  calculateStorageAllowances,
  depositUSDFC,
  setServiceApprovals,
} from 'filecoin-pin/core/payments'
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
