Filecoin Pin brings multiple technologies together (e.g., traditional Filecoin blockchain, traditional IPFS, new Filecoin initiatives like Filecoin Onchain Cloud).  As a result, terminology from all these areas is used for describing Filecoin Pin.  This glossary serves as a primer of the key terminology.  Rather than seeking to be the comprehensive source of truth, it seeks to point to where to find authoritative and more in depth information.  Many additional IPFS-related terms can be found in https://docs.ipfs.tech/concepts/glossary.  

## Calibration Network

The “test network” of Filecoin’s Mainnet, where developers can have more realistic network conditions without using truly valuable tokens.  See https://docs.filecoin.io/networks/calibration

## CAR

A CAR is a container and transport to hold your "IPFS data" (i.e., IPLD blocks).  It just happens to take file form sometimes.  See https://docs.ipfs.tech/concepts/glossary/#car for more info.

## CommP

CommP (Commitment of Piece) is a cryptographic hash function used in Filecoin to create piece commitments. CommP is the hash of a piece's data processed sequentially without regard to its internal DAG structure. This differs from content-addressed CIDs used in IPFS which depend on the merkle DAG structure. The CommP hash of a [CAR](#car) file uploaded by Filecoin Pin produces the [Piece CID](#piece-cid).

## Curio

Curio is the software that [Filecoin Warm Storage Service](#filecoin-warm-storage-service) [Storage Providers](#storage-provider) run, which handles:

1. interfacing with data writing clients like [Synapse](#synapse)/filecoin-pin
2. interfacing with [IPNI](#ipni) indexing for content routing
3. data retrieval from HTTP clients
4. interfacing with the blockchain for [Filecoin Warm Storage Service](#filecoin-warm-storage-service) and [Proof of Data Possession](#proof-of-data-possession)

## Data Set

Collections of stored data ([Pieces](#piece)) managed by [Filecoin Warm Storage Service](#filecoin-warm-storage-service). Each Data Set is tied to exactly one [Storage Provider](#storage-provider); all pieces in a Data Set are stored by the same SP. Each Data Set has [metadata keys](#metadata-keys), Pieces, and an associated payment rail between [Filecoin Pay](#filecoin-pay) and the SP that handles ongoing storage payments.

Filecoin Pin reuses existing Data Sets by default, matching on [metadata keys](#metadata-keys) (`source='filecoin-pin'`). If multiple exist, it uses the one storing the most data.

## FIL

FIL is Filecoin's native token.  While [Filecoin Onchain Cloud](#filecoin-onchain-cloud) storage is denominated in [USDFC](#usdfc), transactions on the Filecoin blockchain (e.g., adding a [Piece](#piece)) need to be paid for using FIL.

## Filecoin Pay

Filecoin Pay is a generic payment solution between users and various [Filecoin Onchain Cloud](#filecoin-onchain-cloud) services.

Think of it like…

Learn more at https://github.com/FilOzone/filecoin-pay

## Filecoin Onchain Cloud

https://filecoin.cloud.

This is the collection of DePIN services offered on Filecoin using shared/consistent payment infrastructure in [Filecoin Pay](#filecoin-pay).  [Filecoin Warm Storage Service](#filecoin-warm-storage-service) is the initial service offering.

This is often abbreviated as “FOC”, which yes, does phonetically resonate with more colorful language 😉.

## Filecoin Pin

https://github.com/FilOzone/filecoin-pin

Serves as an IPFS-oriented sets of tools for interfacing with [Filecoin Onchain Cloud](#filecoin-onchain-cloud) built on top of [Synapse](#synapse).

## `filecoin-pin`

`filecoin-pin` is a CLI tool affordance for [Filecoin Pin](#filecoin-pin).

## filecoin-pin-website

https://github.com/filecoin-project/filecoin-pin-website

Example of [Filecoin Pin](#filecoin-pin) in action within a web-browser.  Its purposes are:

1. Demonstrate that Filecoin Pin is usable.  Drag and drop and you're good to go!
2. Serve as a starter or inspiration for dApp builders wanting to use [Filecoin Onchain Cloud](#filecoin-onchain-cloud).

filecoin-pin-website is also hosted at [pin.filecoin.cloud](http://pin.filecoin.cloud), with hardcoded wallet and [session key](#session-key) on the [Calibration](#calibration-network) network.  In future, [integration with tools like Metamask will be supported](https://github.com/filecoin-project/filecoin-pin-website/issues/77).  

## Filecoin Warm Storage Service

This is the entry point smart contract for using the warm storage functionality offered in [Filecoin Onchain Cloud](#filecoin-onchain-cloud).  It acts as a validator for payment settlements, ensuring the warm storage service is actually delivered before payments are released to the [Storage Provider](#storage-provider).

## IPFS Root CID

The CID for the root of a merkle DAG that is usually encoding a file or directory as UnixFS.  Since each `filecoin-pin add` creates a [CAR](#car), regardless if passed a file or directory, there is a single root corresponding to root of the Merkle DAG made out of encoding the file or directory as UnixFS.

## `/ipfs` Retrieval

This is one of two retrieval endpoints that [Storage Providers](#storage-provider) expose.  This endpoint conforms with the [IPFS Trustless Gateway Specification](https://specs.ipfs.tech/http-gateways/trustless-gateway/).  All CIDs that are indexed by the SP should be retrievable via this endpoint.  This is endpoint that is announced through the provider records stored by [IPNI](#ipni) Indexers.

## IPNI

See https://docs.ipfs.tech/concepts/glossary/#ipni.

IPNI is the content routing system that [Filecoin Pin](#filecoin-pin) relies upon for retrieval to work for [standard IPFS tooling](#standard-ipfs-tooling).  [Storage Providers](#storage-provider) announce their advertisement changes to IPNI indexer like [filecoinpin.contact](http://filecoinpin.contact) and cid.contact, and the advertised CIDs become discoverable for IPFS Standard tooling.

## Metadata Keys

Key-value pairs stored on-chain, either scoped to [Data Sets](#data-set) or [Pieces](#piece). [Filecoin Pin](#filecoin-pin) uses specific metadata keys:

Key | Purpose | Scope
`source` | Set to 'filecoin-pin' to identify data created by this tool | Data Set
`withIPFSIndexing` | Set to empty string to signal the [SP](#storage-provider) to index and advertise the data to [IPNI](#ipni) | Piece
`ipfsRootCid` | Stored on each Piece to link the [Piece CID](#piece-cid) back to the [IPFS Root CID](#ipfs-root-cid).  While this is a convention that Filecoin Pin follows, there is nothing onchain enforcing a correct link between `ipfsRootCid` and `pieceCid`. | Piece

## Piece

A Piece is an individual unit of data identified by [Piece CID](#piece-cid). Multiple Pieces can be added to a [Data Set](#data-set) for storage.

With [Filecoin Pin](#filecoin-pin), the Piece is the [CAR](#car) file itself; an array of bytes representing the serialized content. Each `filecoin-pin add` operation creates exactly one Piece by converting the input file or directory to a CAR file, which then becomes the Piece that is uploaded and stored.

## Piece CID

A CID for a [Piece](#piece) using the [CommP](#commp) hash function.  This is a common CID type used within Filecoin.  This value is different than the [IPFS Root CID](#ipfs-root-cid).  This is the CommP hash for the full [CAR](#car) itself while serially processing its bytes without any regard to the CAR's underlying DAG structure.

## `/piece` Retrieval

This is a Filecoin-defined retrieval specification outlined in https://github.com/filecoin-project/FIPs/blob/master/FRCs/frc-0066.md.  It is for retrieving pieces by [Piece CID](#piece-cid), optionally taking a range.

It takes the form of https://sp.domain/piece/$pieceCid.

## Proof of Data Possession

https://github.com/FilOzone/pdp

The cryptographic protocol that verifies [storage providers](#storage-provider) are actually storing the data they claim to store. Providers must periodically prove they possess the data.  

This is usually abbreviated as “PDP”.

## RPC Provider

HTTP endpoint/infrastructure for reading or writing blockchain state.  These RPC providers run native blockchain clients and likely are storing blockchain state in optimized state for faster reads.  See https://docs.filecoin.io/networks/mainnet/rpcs for for more information about Filecoin RPC providers.  

## Service Provider Registry

An onchain registry of [Storage Providers](#storage-provider) who are participating in [Filecoin Onchain Cloud](#filecoin-onchain-cloud).  They can be view at https://filecoin.cloud/providers.  By default, only "Approved Providers" are used by [Filecoin Pin](#filecoin-pin) because they have been vetted to support IPFS Mainnet retrievals.

## Session Key

Credentials that are permitted to perform a scoped down set of tasks on behalf of a wallet within an expiration window.  For example, the [filecoin-pin-website](#filecoin-pin-website) uses a shared session key so that anonymous users can test out the tool without bringing their own wallet or funds.

Session keys require specific permissions (such as CREATE_DATA_SET and ADD_PIECES) and have expiration timestamps.  The filecoin-pin-website session key is scoped to allowing the creation of [data sets](#data-set) and [pieces](#piece), but prevents transferring of funds for example.

## Standard IPFS Tooling

This is shorthand way of referring to all the tooling the traditional IPFS ecosystem has built up for finding and retrieving content on [IPFS Mainnet](https://docs.ipfs.tech/concepts/glossary/#mainnet).  This includes tools like Kubo, Helia, and HTTP gateways.  A goal of filecoin-pin is to make sure data stored with it is retrievable with standard IPFS tooling without any special configuration.

## Storage Provider

Storage Providers receive uploaded piece data and then cryptographically prove that they have possession of the uploaded data.  Storage providers do this in exchange for payment through [Filecoin Pay](#filecoin-pay) as validated and authorized by [Filecoin Warm Storage Service](#filecoin-warm-storage-service).  Storage Providers at least currently run [Curio](#curio).

This is usually abbreviated as "SP".

## synapse

Synapse is the TypeScript SDK for interfacing with [Filecoin Onchain Cloud](#filecoin-onchain-cloud).  It abstracts [RPC Provider](#rpc-provider) calls, reading/writing smart contract state, and [Storage Provider](#storage-provider) interactions. Published as `@filoz/synapse-sdk` on npm, it provides TypeScript types and handles all blockchain interactions. Read more at https://synapse.filecoin.cloud.

## USDFC

A US dollar denominated "stable coin" that is backed by [FIL](#fil).  USDFC is the currency used by [Storage Providers](#storage-provider) in [Filecoin Onchain Cloud](#filecoin-onchain-cloud).  USDFC is an ERC-20 token. Read more at https://docs.secured.finance/usdfc-stablecoin.