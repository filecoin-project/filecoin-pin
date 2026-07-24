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
- **Funding Planner**: Build and execute Filecoin Pay funding plans for runway or fixed deposits

## Automatic setup and acquisition boundary

`payments setup --auto` first asks the on-chain price list for its authoritative Filecoin Pay target. That target and the resulting Filecoin Pay deposit delta are independent of the owner wallet's current FIL and USDFC balances. Only after the target is fixed does the CLI calculate wallet shortfalls and, when requested, validate readiness.

The optional acquisition boundary is deliberately narrow:

1. The estimator determines the Filecoin Pay target and deposit delta.
2. Readiness compares that delta and required FIL reserve to the owner wallet.
3. On Filecoin mainnet, the allowlisted provider route may acquire only the remaining FIL/USDFC shortfall from the same owner address; its source amount stays within the explicit user cap.
4. Fresh Filecoin wallet balances are read after acquisition.
5. The established `depositUSDFC` and service-approval helpers execute the Filecoin-side payment work.

The provider stage has typed outcomes: no acquisition needed, completed acquisition, incomplete/unknown acquisition that must not be resent, and a failed pre-submission acquisition. A rerun recomputes shortfalls from fresh balances. Once acquisition has completed, a later deposit or approval failure must offer only direct Filecoin-side recovery, never a source-route retry that could duplicate spending.

Tests follow a ladder: deterministic fixtures and mocked RPCs first; real Filecoin Pay deposit/rerun on local devnet; direct deposit and approval on Calibration where acquisition fails closed; then a separately authorized, hard-capped mainnet smoke test. The mainnet smoke is never a normal test or CI task; see [the payments smoke test](../../../documentation/payments-smoke-test.md).

## Filecoin Pin Use Examples

Below are examples of how we use our custom Synapse SDK abstractions from within Filecoin Pin.

### Set up Synapse Service

```typescript
import { RPC_URLS } from '@filoz/synapse-sdk'
import { initializeSynapse } from 'filecoin-pin/core/synapse'

const config = {
  privateKey: process.env.PRIVATE_KEY,
  rpcUrl: RPC_URLS.calibration.websocket
}

const synapse = await initializeSynapse(config, logger)
```

### Upload CAR File

```typescript
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { uploadToSynapse } from 'filecoin-pin/core/upload'
import { CID } from 'multiformats/cid'

const carData = Readable.toWeb(createReadStream('path/to/file.car'))
const rootCid = CID.parse('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi')

const result = await uploadToSynapse(
  synapseService,
  carData,
  rootCid,
  logger,
  {
    onProgress: (event) => {
      if (event.type === 'stored') {
        console.log(`Stored on provider ${event.data.providerId}: ${event.data.pieceCid}`)
      }
    }
  }
)

console.log(`Piece CID: ${result.pieceCid}`)
console.log(`Retrieval URL: ${result.copies[0]?.retrievalUrl}`)
```

### Setup Payments

```typescript
import {
  calculateStorageAllowances,
  executeFilecoinPayFunding,
  depositUSDFC,
  planFilecoinPayFunding,
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

// Plan and execute a Filecoin Pay top-up for 30 days of runway
const { plan } = await planFilecoinPayFunding({
  synapse,
  targetRunwayDays: 30,
  ensureAllowances: true, // also checks and sets WarmStorage allowances
})

if (plan.delta > 0n) {
  const execution = await executeFilecoinPayFunding(synapse, plan)
  console.log(`Deposited ${execution.delta} wei USDFC for ~${execution.newRunwayDays} day(s) runway`)
} else {
  console.log('No additional funding required')
}
```
