Filecoin Pin brings multiple technologies together (e.g., traditional Filecoin blockchain, traditional IPFS, new Filecoin initiatives like Filecoin Onchain Cloud).  As a result, terminology from all these areas is used for describing Filecoin Pin.  This glossary serves as a primer of the key terminology.  Rather than seeking to be the comprehensive source of truth, it seeks to point to where to find authoritative and more in depth information.  Many additional IPFS-related terms can be found in https://docs.ipfs.tech/concepts/glossary.  

## Calibration Network

The “test network” of Filecoin’s Mainnet, where developers can have more realistic network conditions without using truly valuable tokens.  TODO: add a link to filecoin-docs.

## CAR

A CAR is a container and transport to hold your "IPFS data" (i.e., IPLD blocks).  It just happens to take file form sometimes.  See https://docs.ipfs.tech/concepts/glossary/#car for more info.

## Curio

Curio is the software that Filecoin Warm Storage Service Storage Provider run, which handles:

1. interfacing with data writing clients like Synapse/filecoin-pin
2. interfacing with IPNI indexing for content routing 
3. data retrieval from HTTP clients
4. interfacing with the blockchain for Filecoin Warm Storage Service and Proof of Data Possession

## Data Set

Collections of stored data (Pieces) managed by Filecoin Warm Storage Service. Each Data Set has a corresponding SP, Pieces, metadata, and an associated payment rail between Filecoin Pay and the SP that handles the ongoing storage payments.

## FIL

FIL is Filecoin’s native token.  While Filecoin Onchain Cloud storage is denominated in USDFC, transactions on the Filecoin blockchain (e.g., adding a Piece) need to be paid for using FIL.

## Filecoin Pay

Filecoin Pay is a generic payment solution between users and various Filecoin Onchain Cloud services.  

Think of it like…

Learn more at https://github.com/FilOzone/filecoin-pay

## Filecoin Onchain Cloud

https://filecoin.cloud.

This is the collection of DePIN services offered on Filecoin using shared/consistent payment infrastructure in Filecoin Pay.  Filecoin Warm Storage Service is the initial service offering.

This is often abbreviated as “FOC”, which yes, does phonetically resonate with more colorful language 😉.

## filecoin-pin

https://github.com/FilOzone/filecoin-pin

Serves as an IPFS-oriented sets of tools for interfacing with Filecoin Onchain Cloud built on top of Synapse.  

`filecoin-pin` CLI is one such tool.

## filecoin-pin-website

https://github.com/filecoin-project/filecoin-pin-website

Example of filecoin-pin in action within a web-browser.  Its purposes are:

1. Demonstrate that filecoin-pin is usable.  Drag and drop and you’re good to go!
2. Serve as a starter or inspiration for dApp builders wanting to use Filecoin Onchain Cloud.

filecoin-pin-website is also hosted at [pin.filecoin.cloud](http://pin.filecoin.cloud), with hardcoded wallet and session key on the Calibration network.  In future, [integration with tools like Metamask will be supported](https://github.com/filecoin-project/filecoin-pin-website/issues/77).  

## Filecoin Warm Storage Service

This is the entry point smart contract for using the warm storage functionality offered in Filecoin Onchain Cloud.  It acts as a validator for payment settlements, ensuring the warm storage service is actually delivered before payments are released to the SP.

## IPFS Root CID

The CID for the root of a merkle DAG that is usually encoding a file or directory as UnixFS.  Since each `filecoin-pin add` creates a CAR, regardless if passed a file or directory, there is a single root corresponding to root of the Merkle DAG made out of encoding the file or directory as UnixFS.

## `/ipfs` Retrieval

This is one of two retrieval endpoints that SPs expose.  This endpoint conforms with the [IPFS Trustless Gateway Specification](https://specs.ipfs.tech/http-gateways/trustless-gateway/).  All CIDs that are indexed by the SP should be retrievable via this endpoint.  This is endpoint that is announced through the provider records stored by IPNI Indexers.

## IPNI

See https://docs.ipfs.tech/concepts/glossary/#ipni.

IPNI is the content routing system that Filecoin Pin relies upon for retrieval to work for standard IPFS tooling.  Storage Providers announce their advertisement changes to IPNI indexer like [filecoinpin.contact](http://filecoinpin.contact) and cid.contact, and the advertised CIDs become discoverable for IPFS Standard tooling.  

## Piece

A Piece is an individual unit of data identified by PieceCID. Multiple Pieces can be added to a Data Set for storage.

A Piece is an array of bytes.  Sometimes these bytes come from a single file, but it can also be directories with more directories files within it.

filecoin-pin creates a new piece for each “add” operation.  Whatever file or directory is “added” is converted to a CAR and uploaded as a piece.

## Piece CID

A CID for a Piece using the CommP hash function.  This is a common CID type used within Filecoin.  This value is different than the “IPFS Root CID”.  This is the CommP hash for the full CAR itself while serially processing its bytes without any regard to the CAR’s underlying DAG structure.

## `/piece` Retrieval

This is a Filecoin-defined retrieval specification outlined in TODO_FILL_ME_IN.  It is for retrieving pieces by Piece CID, optionally taking a range.

It takes the form of https://sp.domain/piece/$pieceCid. 

## Proof of Data Possession

https://github.com/FilOzone/pdp

The cryptographic protocol that verifies storage providers are actually storing the data they claim to store. Providers must periodically prove they possess the data.  

This is usually abbreviated as “PDP”.

## RPC Provider

HTTP endpoint/infrastructure for reading or writing blockchain state.  These RPC providers run native blockchain clients and likely are storing blockchain state in optimized state for faster reads.  See TODO ADD LINK for for more information about Filecoin RPC providers.  

## Service Provider Registry

An onchain registry of Storage Providers who are participating in Filecoin Onchain Cloud.  They can be view at [https://filecoin.cloud/providers](https://filecoin.services/providers).  By default, only "Approved Providers" are used by filecoin-pin because they have been vetted to support IPFS Mainnet retrievals.

## Session Key

Credentials that are permitted to perform a scoped down set of tasks on behalf of a wallet within an expiration window.  For example, the filecoin-pin-website using a shared session key so that anonymous users can test out the tool without bringing their own wallet or funds.  The session key is scoped to allowing the creation of data sets and pieces, but prevents transferring of funds for example. 

## Standard IPFS Tooling

This is shorthand way of referring to all the tooling the traditional IPFS ecosystem has built up for finding and retrieving content on [IPFS Mainnet](https://docs.ipfs.tech/concepts/glossary/#mainnet).  This includes tools like Kubo, Helia, and HTTP gateways.  A goal of filecoin-pin is to make sure data stored with it is retrievable with standard IPFS tooling without any special configuration.  

## Storage Provider

Storage Providers receive uploaded piece data and then cryptographically prove that they have possession of the uploaded data.  Storage providers do this in exchange for payment through Filecoin Pay as validated and authorized by Filecoin Warm Storage Service.  Storage Providers at least currently run Curio.

This is usually abbreviated as “SP”.

## synapse

Synapse is the TypeScript SDK for interfacing with Filecoin Onchain Cloud.  It abstracts RPC Provider calls, reading/writing smart contract state, and Storage Provider interactions.  Read more at https://synapse.filecoin.cloud.

## USDFC

A US dollar denominated "stable coin" that is backed by FIL.  USDFC is the currency used by Storage Providers in Filecoin Onchain Cloud.