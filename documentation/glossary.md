Filecoin Pin brings multiple technologies together (i.e., existing Filecoin blockchain and storage providers, new Filecoin initiatives including Filecoin Onchain Cloud, IPFS).  As a result, terminology from all these areas is used for describing Filecoin Pin.  This glossary serves as a primer of the key terminology.  Rather than seeking to be the comprehensive source of truth, it seeks to point to where to find authoritative and more in depth information.  Many additional IPFS-related terms can be found in https://docs.ipfs.tech/concepts/glossary.

## Calibration Network

The "test network" of Filecoin's Mainnet, where developers can have more realistic network conditions without using truly valuable tokens. This is sometimes colloquially known as "calibnet" and has the [chain ID](https://chainlist.org/) of 314159, while Filecoin's Mainnet is 314. See https://docs.filecoin.io/networks/calibration

## CAR

A CAR is a container format and network transport to hold your "IPFS data" (i.e., IPLD blocks).  It just happens to take file form sometimes so is often called a "CAR file".  See https://docs.ipfs.tech/concepts/glossary/#car for more info.

## CID

See https://docs.ipfs.tech/concepts/glossary/#cid.

## CommP

A common term used in place of [Piece CID](#piece-cid).

## Content Routing

How an IPFS node (including IPFS HTTP Gateways) find other IPFS nodes providing the CIDs.  Content routing refers to the way in which IPFS determines where to find a given CID on the network; specifically, which network peers are providing the CIDs you are requesting. In other words, a node cannot simply find data in the network with a CID alone; it requires information about the IP addresses and ports of its peers on the network.  Read more about [content routing in Filecoin Pin](content-routing-faq.md).

## Curio

Curio is the software that [Filecoin Warm Storage Service](#filecoin-warm-storage-service) [Service Providers](#service-provider) run, which handles:

1. interfacing with data writing clients like [Synapse](#synapse)/filecoin-pin
2. interfacing with [IPNI](#ipni) indexing for content routing
3. data retrieval from HTTP clients
4. interfacing with the blockchain for [Filecoin Warm Storage Service](#filecoin-warm-storage-service) and [Proof of Data Possession](#proof-of-data-possession)

## Data Set

Collections of stored data ([Pieces](#piece)) managed by [Filecoin Warm Storage Service](#filecoin-warm-storage-service). Each Data Set is tied to exactly one [Service Provider](#service-provider); all pieces in a Data Set are stored by the same SP. Each Data Set has [metadata](#metadata), Pieces, and an associated payment rail between [Filecoin Pay](#filecoin-pay) and the SP that handles ongoing storage payments.

Filecoin Pin reuses existing Data Sets by default, matching on [metadata](#metadata) (`source='filecoin-pin'`). If multiple exist, it uses the one storing the most data.

## FIL

FIL is Filecoin's native token.  While [Filecoin Onchain Cloud](#filecoin-onchain-cloud) storage is currently denominated in [USDFC](#usdfc), gas for transactions on the Filecoin blockchain (e.g., adding a [Piece](#piece)) need to be paid for using FIL. Most transactions in the data onboarding flow for Filecoin Onchain Cloud are submitted by storage providers so client typically have minimal need to interact directly with FIL.

## Filecoin Pay

Filecoin Pay is a generic payment solution between users and various [Filecoin Onchain Cloud](#filecoin-onchain-cloud) services.

Learn more at https://github.com/FilOzone/filecoin-pay

## Filecoin Onchain Cloud

https://filecoin.cloud.

This is the collection of DePIN services offered on Filecoin using shared/consistent payment infrastructure in [Filecoin Pay](#filecoin-pay).  [Filecoin Warm Storage Service](#filecoin-warm-storage-service) is the initial service offering.

This is often abbreviated as “FOC”, which yes, does phonetically resonate with more colorful language 😉.

## Filecoin Pin

https://github.com/FilOzone/filecoin-pin

Serves as an IPFS-oriented set of tools for interfacing with [Filecoin Onchain Cloud](#filecoin-onchain-cloud) built on top of [Synapse](#synapse).

## `filecoin-pin`

`filecoin-pin` is a CLI tool affordance for [Filecoin Pin](#filecoin-pin).

## filecoin-pin-website

https://github.com/filecoin-project/filecoin-pin-website

Example of [Filecoin Pin](#filecoin-pin) in action within a web-browser.  Its purposes are:

1. Demonstrate that Filecoin Pin is usable.  Drag and drop and you're good to go!
2. Serve as a starter or inspiration for dApp builders wanting to use [Filecoin Onchain Cloud](#filecoin-onchain-cloud).

filecoin-pin-website is also hosted at [pin.filecoin.cloud](http://pin.filecoin.cloud), with hardcoded wallet and [session key](#session-key) on the [Calibration](#calibration-network) network.  In future, [integration with tools like Metamask will be supported](https://github.com/filecoin-project/filecoin-pin-website/issues/77).

## Filecoin Pin example GitHub Action

https://github.com/filecoin-project/filecoin-pin/tree/master/upload-action

Example of [Filecoin Pin](#filecoin-pin) in action within a reusable GitHub Action.

## Filecoin Warm Storage Service

This is the primary smart contract used when interacting with the warm storage functionality offered in [Filecoin Onchain Cloud](#filecoin-onchain-cloud).  It acts as both a "service" contract and a "validator" contract for payment management and settlements, ensuring the warm storage service is actually delivered before payments are released to the [Service Provider](#service-provider).

## IPFS Root CID

The CID for the root of a merkle DAG that is usually encoding a file or directory as UnixFS.  Since each `filecoin-pin add` creates a [CAR](#car), regardless if passed a file or directory, there is a single root corresponding to root of the Merkle DAG made out of encoding the file or directory as UnixFS. Typically this will be presented in base32, beginning with `bafy` and be 59 characters long.

## `/ipfs` Retrieval

This is one of two retrieval endpoints that [Service Providers](#service-provider) expose.  This endpoint conforms with the [IPFS Trustless Gateway Specification](https://specs.ipfs.tech/http-gateways/trustless-gateway/).  All CIDs that are indexed by the SP should be retrievable via this endpoint.  This is the endpoint that is announced through the provider records stored by [IPNI](#ipni) Indexers.

As a "trustless" protocol, retrieval of IPFS data using this mechanism provides assurance that data has not been tampered with and that what is being retrieved is _exactly_ what was requested. This is in contrast to a "trusted" gateway where IPFS data is reassembled into a form appropriate for rendering. Developers and users are encouraged to perform this reassembly step as close as possible to the user, using existing IPFS technologies such as [Kubo](https://github.com/ipfs/kubo) and [Helia](https://github.com/ipfs/helia). For example, Helia's [`verified-fetch` package](https://www.npmjs.com/package/@helia/verified-fetch) is able to perform this within a browser context and is powering https://inbrowser.link/.

## IPNI

See https://docs.ipfs.tech/concepts/glossary/#ipni.

IPNI is the content routing system that [Filecoin Pin](#filecoin-pin) relies upon for retrieval to work for [standard IPFS tooling](#standard-ipfs-tooling).  [Service Providers](#service-provider) announce their advertisement changes to IPNI indexer like [filecoinpin.contact](http://filecoinpin.contact) and cid.contact, and the advertised CIDs become discoverable for IPFS Standard tooling.

## Metadata

Key-value pairs stored on-chain, either scoped to [Data Sets](#data-set) or [Pieces](#piece). [Filecoin Pin](#filecoin-pin) uses specific metadata keys:

Key | Purpose | Scope
`source` | Set to 'filecoin-pin' to identify data created by this tool | Data Set
`withIPFSIndexing` | Set to empty string to signal the [SP](#service-provider) to index and advertise the data to [IPNI](#ipni) | Data Set
`ipfsRootCid` | Stored on each Piece to link the [Piece CID](#piece-cid) back to the [IPFS Root CID](#ipfs-root-cid).  While this is a convention that Filecoin Pin follows, there is nothing onchain enforcing a correct link between `ipfsRootCid` and `pieceCid`. | Piece

## Piece

A Piece is an individual unit of data identified by [Piece CID](#piece-cid). Multiple Pieces can be added to a [Data Set](#data-set) for storage.

With [Filecoin Pin](#filecoin-pin), the Piece is the [CAR](#car) file itself; an array of bytes representing the serialized content. Each `filecoin-pin add` operation creates exactly one Piece by converting the input file or directory to a CAR file, which then becomes the Piece that is uploaded and stored.

## Piece CID

PieceCID, or "CommP" (Commitment of Piece), is a specific form of [CID](#cid) used in Filecoin to commit Merkle proofs of large _pieces_ of data on chain. A PieceCID includes a digest of the contiguous bytes, with no special handling of any internal format or packing (including CAR formats containing IPFS data). It uses a modified form of SHA2-256 internally, and further details can be found in [FRC-0069](https://github.com/filecoin-project/FIPs/blob/master/FRCs/frc-0069.md). PieceCID is a variant of CID specifically for use in Filecoin's proof system, and will differ from the CIDs used in IPFS. When presented in standard base32 format, it will begin with the characters `bafkzcib` and be between 64 and 65 characters long.

## `/piece` Retrieval

This is a Filecoin-defined retrieval specification outlined in https://github.com/filecoin-project/FIPs/blob/master/FRCs/frc-0066.md.  It is for retrieving pieces by [Piece CID](#piece-cid), optionally taking a byte range specified by standard HTTP request format. Piece retrieval is useful for downloading the bytes _as they are stored and proven_ in Filecoin, either to request the original non-IPFS data stored, or downloading the CAR format data generated by Filecoin Pin.

It takes the form of https://sp.domain/piece/$pieceCid.

## Proof of Data Possession

https://github.com/FilOzone/pdp

The cryptographic protocol that verifies [service providers](#service-provider) are actually storing the data they claim to store. Providers must periodically prove they possess the data.  This is distinct from the existing Filecoin proof system, "PoRep" or "Proof of Replication".

This is usually abbreviated as "PDP".

## RPC Provider

HTTP endpoint/infrastructure for reading or writing blockchain state.  These RPC providers run native blockchain clients and likely are storing blockchain state in an optimized format for faster reads. Filecoin provides support for the common set of Ethereum-style APIs in its RPC endpoints, meaning that most standard Ethereum tooling can interact with Filecoin without significant modification.  See https://docs.filecoin.io/networks/mainnet/rpcs for more information about Filecoin RPC providers.

## Service Provider

Service Providers receive uploaded piece data and then cryptographically prove that they have possession of the uploaded data.  Service providers do this in exchange for payment through [Filecoin Pay](#filecoin-pay) as validated and authorized by [Filecoin Warm Storage Service](#filecoin-warm-storage-service).  Service Providers at least currently run [Curio](#curio).

This is usually abbreviated as "SP".

Note that within [Filecoin Onchain Cloud](#filecoin-onchain-cloud), service providers in the context of warm storage are also commonly referred to as [Storage Providers](#storage-provider), and these two terms are often used interchangeably.

## Service Provider Registry

An onchain registry of [Service Providers](#service-provider) who are participating in [Filecoin Onchain Cloud](#filecoin-onchain-cloud).  They can be viewed at https://filecoin.cloud/service-providers.  By default, only "Approved Providers" are used by [Filecoin Pin](#filecoin-pin) because they have been vetted to support IPFS Mainnet retrievals.

## Session Key

Session Keys are wallet addresses, registered in the **Session Key Registry** on chain and used by [Filecoin Warm Storage Service](#filecoin-warm-storage-service) as an alternative to directly signed operations (e.g., adding pieces).

A session key acts as a credential that permits a scoped-down set of tasks on behalf of a wallet within an expiration window.  For example, the [filecoin-pin-website](#filecoin-pin-website) uses a shared session key so that anonymous users can test out the tool without bringing their own wallet or funds, while the owner of those actions is original (private) wallet of the service.

Session keys require specific permissions (such as CREATE_DATA_SET and ADD_PIECES) and have expiration timestamps.  The filecoin-pin-website session key is scoped to allowing the creation of [data sets](#data-set) and [pieces](#piece), but prevents transferring of funds for example.



## Standard IPFS Tooling

This is shorthand way of referring to all the tooling the traditional IPFS ecosystem has built up for finding and retrieving content on [IPFS Mainnet](https://docs.ipfs.tech/concepts/glossary/#mainnet).  This includes tools like Kubo, Helia, and HTTP gateways.  A goal of filecoin-pin is to make sure data stored with it is retrievable with standard IPFS tooling without any special configuration.

## Storage Provider

A common term used in place of [Service Provider](#service-provider).  Before [Filecoin Onchain Cloud](#filecoin-onchain-cloud), when Filecoin was just focused on storage, SP referred to "Storage Providers".  Now with the broader scope and utility of FOC, the more general "Service Provider" name is preferred.

## Synapse

Synapse is the TypeScript SDK for interfacing with [Filecoin Onchain Cloud](#filecoin-onchain-cloud).  It abstracts [RPC Provider](#rpc-provider) calls, reading/writing smart contract state, and [Service Provider](#service-provider) interactions. Published as `@filoz/synapse-sdk` on npm, it provides TypeScript types and handles all blockchain interactions. Read more at https://synapse.filecoin.cloud.

## USDFC

A US dollar denominated "stable coin" that is backed by [FIL](#fil).  USDFC is the currency used by [Service Providers](#service-provider) in [Filecoin Onchain Cloud](#filecoin-onchain-cloud).  USDFC is an ERC-20 token. Read more at https://docs.secured.finance/usdfc-stablecoin.
