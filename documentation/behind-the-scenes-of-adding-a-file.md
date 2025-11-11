The steps outlined below are taken to "add a file with `filecoin-pin`".  This document is intended to provide more info about what happens "behind the scenes" as it uses underlying libraries like `synapse` and the Filecoin Onchain Cloud offering.

## Diagram

TODO: show a Mermaid diagram of the connection between the different steps

The diagram can surface these steps and show where they happen in parallel.  

We should highlight the blockchain steps vs. the non-blockchain steps.  

We should also have a note about some of the unlocks or abilities the user has as a result of a given step.

| Step | Note of what is now available  | Has Blockchain Interaction |
| --- | --- | --- |
| Select a file to “add” |  | No |
| Create CAR | Client knows the IPFS Root Cid | No |
| Upload CAR | Client know the Piece CID.
SP can serve https://sp.domain/piece/$pieceCid requests. | No |
| Index CAR CIDs | SP can serve https://sp.domain/ipfs/$cid requests. | No |
| Advertise CAR CIDs | IPNI indexers should have corresponding provider records for https://filecoinpin.com/cid/$cid calls.
IPFS Mainnet retrieval of  | No |
| Retrieve Data | ipfs://$cid works | No |
| Connect Wallet | Wallet balances | Yes |
| Setup Filecoin Pay | Filecoin Pay account balance | Yes |
| Identify a Data Set SP and ID |  | Yes |
| Create Data Set if necessary and Add Piece | Ability to explore the metadata of a Data Set and its Pieces | Yes |
| Prove Data Possession | Explore proving records stored onchain of a Data Set and its Pieces | Yes |

## Steps without Blockchain Interactions

These are the set of steps that that are done client side (i.e., where the `filecoin-pin` code is running) and with a Storage Provider that don’t involve the Filecoin blockchain.  These steps in isolation though don’t yield a committed cryptographic proof of the data being possessed by and retrievable from an SP, but they are necessary preconditions.

### Create CAR

*What/why:*

The provided file needs to be turned into a merkle DAG and have the DAG’s blocks shipped off.  CAR is a common container format for transporting blocks in the IPFS ecosystem and is used with `filecoin-pin`.  It is `filecoin-pin` client to dagify the content so that it knows the CIDs of the blocks so it doesn’t need to trust the Storage Provider (SP).

*Outputs:*

v1 CAR containing the merkle DAG representing the provided file.  There is one root in the CAR, and it represents the root of the DAG for the input file.  This is referred to as the “IPFS Root CID”.  

*Expected duration:* 

This is a function of the size of the input file and the hardware, but a 1Gb input file can take upwards of a minute to dagify and package as a CAR.  As the car is being created, it can be streamed to an SP.

### Upload CAR

*What/why:*

The Storage Provider (SP) needs to be given the bytes to store so it can serve retrievals and prove to the chain that it possesses them.   This is done via an HTTP `PUT /pdp/piece/upload`.  

*Outputs:*

SP parks the piece and queues it up for processing, while the client gets an HTTP response with a status code.

Since the SP has the data for the Piece, it can be retrieved with https://sp.domain/piece retrieval.

*Expected duration:*

This is a function of the CAR size and the throughput between between the client and the SP.  

### Index and Advertise CAR CIDs

*What/why:*

At some point after receiving the uploaded CAR, an SP indexing task process the CAR and creates a local mapping of CIDs to offsets within the CAR.  Following that, an SP IPNI tasks picks up the local index, makes IPNI advertisement chain, and then announces the advertisement chain to IPNI indexers like [filecoinpin.contact](http://filecoinpin.contact) and cid.contact so they know to come and get the advertisement chain to build up their own index.  

*Outputs:*

Once the SP has indexed the CAR, it can be directly retrieved from the SP (i.e., bypassing IPFS Mainnet content routing) using https://sp.domain/ipfs/$cid retrieval. 

The SP produces a new or updated advertisments chain.  By the end, IPNI indexers should have additional provider records for the advertised CIDs.

*Expected duration:* 

Local indexing of the CAR is quick as the CAR already contains a list of CIDs and their offsets, which is verified and reused.  Creating/updating an advertisement chain and announcing it to IPNI indexers is also quick.  There is a delay in an IPNI indexer on the order of seconds for coming to grab the advertisements plus some ingestion delay on the IPNI indexer side.

## Blockchain related steps

Below are the set of steps that are particularly unique from traditional IPFS usage as they involve authorization, payment, and cryptographic proofs.

### Connect Wallet

*What/why:*

`filecoin-pin` needs to interface with the Filecoin blockchain to authorize and send payment to storage providers (SPs) for their work of storing and proving possession of data.  This requires having a secret key to sign messages sent to the blockchain.  

Currently `filecoin-pin` expects to be explicitly passed a private key via environment variable or command line argument.  filecoin-pin-website as [pin.filecoin.cloud](http://pin.filecoin.cloud) uses a global session key which can be embedded into source code since it scopes down the set of actions that can be performed.  

*Outputs:*

Once a wallet is connected, USDFC and FIL balances  in the wallet itself can be inspected.

*Expected duration:* 

Less than 1 second once a wallet private key is provided.

### Setup Filecoin Pay account

*What/why:*

To prepare to make a “deal” with an SP to store data, these actions need to occur:

1. Permit the user's Filecoin Pay account to use USDFC.  This is a one-time authorization.
2. Approve FilecoinWarmStorage as an operator of Filecoin Pay funds.  This is a one-time authorization.  
3. Deposit at least enough funds into Filecoin Pay to cover the lock-up period for the created CAR.

If they haven’t occurred before, then they will be handled as part of the first deposit into the Filecoin Pay account from filecoin pin.  A single `depositWithPermitAndApproveOperator` transaction handles all of these actions.

*Outputs:*

The Filecoin Pay account has a non-zero balance.

*Expected duration:*

As a single transaction, this takes ~30 seconds to be confirmed onchain.  

### Identify a Data Set SP and ID

*What/why:*

In order to upload a CAR, filecoin-pin needs to identify the SP to upload to.  This strategy is followed (assuming no overrides are provided):

1. If the chain has record of a Data Set created by the wallet with the dataset metadata key “TODO fill this in” set to “filecoin-pin”, then that DataSet ID and corresponding SP are used.  If there are multiple, then the one storing the most data will be used.
2. If there is no existing Data Set, then a new Data Set is created using an approved Storage Provider from the Storage Provider Registry.

*Outputs:*

- An existing Data Set id to use or empty if a new Data Set should be created
- SP id to use for CAR upload and Data Set creation (if needed).

*Expected duration:*

This should take less than a couple of seconds as it involves hitting RPC providers to get chain state.

### Create Data Set if necessary and Add Piece

*What/why:*

A single blockchain transaction that create a Data Set if one doesn't already exist and adds a Piece to the Data Set for the corresponding CAR file.  This is done as one operation rather than just “Create Data Set” and “Add Piece” to improve interaction latency.  The Piece uses a Filecoin-internal hash function called CommP, resulting in a Piece CID, which is what is stored onchain.  The Filecoin Warm Storage Service then has record of what SP is storing which data that it needs to periodically proof it has possession of.  filecoin-pin stores additional metadata on the piece denoting that the uploaded data should be indexed by the SP and advertised to IPNI indexers.  

*Outputs:*

A record onchain denoting the data that needs to periodically be proven to be in the possession of the Data Set’s SP.

*Expected duration:*

As a single transaction, this takes ~30 seconds to be confirmed onchain.  

## Content Routing FAQ

### Will indexed CIDs from Calibration be mixed with CIDs from Mainnet?

Yes.  IPNI indexers are not are not chain aware.  They key on the CID and will point to whatever providers have “recently” advertised the CID.  This means that if a given piece is created with a Calibration SP and also with a Mainnet SP, the CIDs will list both SPs as providers.

### What happens when a piece is deleted?

When an SP is instructed to delete a piece, it announces a new advertisement to IPNI that includes the removal of the CIDs within the piece.  This update to IPNI goes through the normal IPNI flow of receiving advertisement announcements and then asynchronously fetching the advertisements from the provider.  As a result, delete pieces should take seconds to low minutes for IPNI index state to be updated.

### What happens if a SP goes offline?

In this case, the IPNI indexer will still attempt to auto-sync with the publisher until 7 days (168 hours) have passed.  Once this timeout is hit, the offline-SP’s advertised CIDs will be removed from the index.

### What happens if an SP loses index state?

In the event that an SP wipes their existing index state, the previously announced advertisements will still be stored by the IPNI indexer if no further action is done.  If the underlying advertisement disappears, but has already been processed by IPNI, this does not affect the availability of records, so long as the provider is still reachable. For the records to disappear, it is necessary to either:

1. publish a removal advertisement for the CIDs that need to be deleted OR
2. have the SP create a new advertisement chain under a new peer ID so as to let the old provider records die out (7 days per above)

### How long does an IPNI indexer cache results?

This depends on both the Indexer instance (e.g., cid.contact, filecoinpin.contact) and whether there is a cache hit or cache miss.

[cid.contact](http://cid.contact) for example tends to cache hits for multiple hours and cache misses (negative cache) for minutes.  As a result of this, there are “gotchas” we have to be careful to avoid or can unavoidably fall into.

- [cid.contact](http://cid.contact) cache miss "gotcha" - Because cid.contact caches misses (i.e., negative cache), it's important for filecoin-pin to not poll cid.contact after an advertisement has been announced.  The act of polling could cause the empty result set to get cached for minutes.  Instead, filecoin-pin polls [filecoinpin.contact](http://filecoinpin.contact) which doesn't have negative caching.  Once filecoin-pin sees the expected results from filecoinpin.contact it then proceeds to give IPFS Mainnet retrieval URLs since it should be safe to invoke a request path that hits cid.contact because cid.contact should now not get a non-empty result.
- [cid.contact](http://cid.contact) cache hit "gotcha" - If cid.contact has a provider record(s) for CID X, but CID X is not currently from any of those provider(s), then cid.contact could be caching non-retrievable result for hours even though filecoinpin.contact has a provider that makes CID X retrievable. We currently don't have a workaround for this…

### Why is there [filecoinpin.contact](http://filecoinpin.contact) and cid.contact?

[filecoinpin.contact](http://filecoinpin.contact) serves two purposes currently:

1. Serve as a fallback in case [cid.contact](http://cid.contact) has issues keeping its global index updated.  To help with availability, cid.contact has the ability to delegate requests other IPNI indexers like [filecoinpin.contact](http://filecoinpin.contact) in case they have results.
2. Validate IPNI announcing/advertising independently of [cid.contact](http://cid.contact).  Per the "[cid.contact](http://cid.contact) cache miss gotcha" above, the act of polling cid.contact can actually delay how long it takes before cid.contact returns a non-empty result for a given CID.  [filecoinpin.contact](http://filecoinpin.contact) has different caching configuration so that polling can be done safely.