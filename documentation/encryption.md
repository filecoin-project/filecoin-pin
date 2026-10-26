# Encryption

This guide explains how encrypted uploads work in Filecoin Pin: who can read them, what stays private, and how the pieces fit together. The [README](../README.md#encrypted-uploads) is the command reference; this page links to it instead of repeating flags.

- [Overview](#overview)
- [Terms](#terms)
- [Two ways to hold the key](#two-ways-to-hold-the-key)
- [Commands](#commands)
- [What is private and what is not](#what-is-private-and-what-is-not)
- [Lifecycle and limits](#lifecycle-and-limits)
- [Format, for integrators](#format-for-integrators)
- [Sharing (not available yet)](#sharing-not-available-yet)
- [Further reading](#further-reading)

## Overview

`filecoin-pin add <path> --encrypt` encrypts a file or folder on your machine before anything is uploaded. Only ciphertext leaves the machine. The result is an [Encrypted Upload](glossary.md#encrypted-upload).

What encryption gives you:

- Only the [Owner](glossary.md#owner) wallet, and [Session Keys](glossary.md#session-key) the Owner gave a [Grant](glossary.md#grant), can read the content.
- The encrypted bytes are stored and proven like any other upload, and stay public: [standard IPFS tooling](glossary.md#standard-ipfs-tooling) and gateways can fetch them by their [Encrypted root CID](glossary.md#encrypted-root-cid). Reading them needs the key.

What it does not give you:

- Anyone can still download the ciphertext. They just can't read it.
- Anyone can see that the upload exists. [Service Providers](glossary.md#service-provider), and anyone reading the chain, can see that encrypted data is stored, by whom, and roughly how large it is. See [What is private and what is not](#what-is-private-and-what-is-not).

## Terms

Filecoin Pin builds on two libraries from [synapse-sdk](https://github.com/FilOzone/synapse-sdk): [Keysmith](https://github.com/FilOzone/synapse-sdk/tree/master/packages/keysmith), which derives and shares keys, and the [Filecoin Encryption Envelope](https://github.com/FilOzone/synapse-sdk/tree/master/packages/filecoin-encryption-envelope) (FEE), which encrypts the bytes. Filecoin Pin renames some Keysmith terms for its users. On-chain and envelope metadata keys keep Keysmith's names (`foc/ks`, `foc/kc`, `foc/scope`).

| Filecoin Pin | Keysmith | What it is |
| --- | --- | --- |
| [Group Key](glossary.md#group-key) | keyspace | The root key all of an Owner's uploads under it are encrypted from. Named by a public 16-byte id (`foc/ks`). |
| [Group](glossary.md#group) | scope | A named part of a group key, so access can cover some uploads only. Not used yet ([#781](https://github.com/filecoin-project/filecoin-pin/issues/781)). |
| [Grant](glossary.md#grant) | delivery (claim chain + grant) | A group key wrapped to one session key, plus an Owner-signed claim. Text form `fgr1_…`. |
| [Claim Chain](glossary.md#claim-chain) | claim chain | Signed statements of who may read which key, rooted in the Owner's signature. |
| [Delivery](glossary.md#delivery) | delivery | One blob holding a claim chain and the wrapped key it vouches for. A Grant is a delivery in text form. |
| [Owner](glossary.md#owner) | owner | The wallet that pays for storage and derives the group key. |
| [Session Key](glossary.md#session-key) | bearer | A key the Owner authorizes for this machine, without sharing the wallet key. |
| [Envelope](glossary.md#envelope) | (FEE) | The encrypted file that is uploaded, named `encrypted.fee`. |
| [Encrypted root CID](glossary.md#encrypted-root-cid) | | The IPFS Root CID of the envelope: what `add --encrypt` prints and `get` takes. |
| [Plaintext root CID](glossary.md#plaintext-root-cid) | | The IPFS Root CID of the original content. It exists only inside the ciphertext and is never printed. |
| [Share link](glossary.md#share-link) | | A viewer link for one upload. Not available yet ([#779](https://github.com/filecoin-project/filecoin-pin/issues/779)). |
| [Access key](glossary.md#access-key) | (recipient private key) | The other half of a share link, text form `fak1_…`. Not available yet. |

Keysmith shares a key by wrapping it to the recipient's public key, so only the recipient's private key opens it. A Grant works this way: it is wrapped to the session key. The Access key is Filecoin Pin's name for a private key the sender generates for a recipient who has no key pair of their own; the share is wrapped to its public key, and the private key is handed over separately.

## Two ways to hold the key

### Owner mode

With the Owner wallet key (`PRIVATE_KEY` or `--private-key`), the CLI derives the [Group Key](glossary.md#group-key) itself from a wallet signature (Keysmith's `KeyspaceKey` message). The CLI doesn't save the group key anywhere: the wallet derives the same key again from a new signature whenever it's needed.

- `add --encrypt` picks the Owner's oldest valid group key from the chain, or the default one when there is none (see [Lifecycle and limits](#lifecycle-and-limits)). For a group key already on chain the wallet signs once and the key is checked against the recorded `foc/kc`. For a new group key it signs twice, to check that the wallet signs deterministically.
- `get` and `decrypt` sign twice, since there is no recorded commitment to check against offline.

Owner mode works on every network, including devnet and custom RPCs.

### Session-key mode

A [Session Key](glossary.md#session-key) cannot sign for a group key. Instead, the Owner gives it a [Grant](glossary.md#grant) through the Filecoin Cloud console:

```
filecoin-pin login --scopes createDataSet,addPieces,encrypt
```

`encrypt` is not an on-chain permission. It adds a group key step to the console flow:

1. `login` generates a session key and opens the console link. The link carries the session key's public key and a signature from the session key binding it to the session address. Both `login` and the console show the session address: check they match.
2. The Owner approves the session key on chain, as with any `login`.
3. The Owner signs `KeyspaceKey`, which derives the group key from the wallet signature (twice for a new group key, to check determinism). The console picks the group key the same way owner-mode `add --encrypt` does; the user does not choose.
4. The Owner signs `ReadGrant`, the access approval: it names the session key as bearer, the network (chain id), an expiry, and that the session key may not pass access on.
5. The console wraps the group key to the session key and shows the Grant, one line starting with `fgr1_`.
6. Paste the Grant at the `login` prompt as one line, or finish later with `filecoin-pin login --grant <grant>` (or `--grant -` to read it from stdin). See [Group key Grants](../README.md#group-key-grants) for the details.

The Grant opens only with the session key it was made for, so it is not a secret on its own, but it does reveal public metadata (the Owner, the session address, the group key id and the expiry). `login` saves it in `session.env` as `GROUP_KEY_ID` and `GROUP_KEY_GRANT`; the key it opens is never stored. The CLI checks the Grant on import and every time it uses it: the signatures, that it was wrapped to this session key, the Owner (`WALLET_ADDRESS`), the network, the group key, that it covers a whole group key, and the expiry.

Session-key mode needs the console, so it works on Mainnet and Calibration only. On devnet or a custom RPC, use owner mode.

### Where the Grant comes from

`GROUP_KEY_ID` and `GROUP_KEY_GRANT` follow the same precedence as other credentials: environment variables, then `--credentials-file`, then the saved login. There are no flags for them. The two are taken as a pair from one source: if either is set in the environment, neither is read from a file. The saved login supplies its Grant only when it also supplies the session key.

- Set both together. `GROUP_KEY_GRANT` without `GROUP_KEY_ID` is refused.
- A Grant for another session key is refused, naming that key. A stale `export GROUP_KEY_GRANT=…` in your shell wins over the saved login, so unset it after a new `login`.

## Commands

The [README](../README.md#encrypted-uploads) lists every flag. In terms of the model:

- **`add <path> --encrypt [--no-ipfs]`** packs the input, encrypts it into an [Envelope](glossary.md#envelope) under the group key (owner mode) or the Grant's group key (session-key mode), and uploads the envelope like any other file. It prints the [Encrypted root CID](glossary.md#encrypted-root-cid). Without a usable key it stops before uploading anything; it never uploads plaintext. `--no-ipfs` skips IPFS indexing; see [Lifecycle and limits](#lifecycle-and-limits). Reference: [Encrypted Uploads](../README.md#encrypted-uploads).
- **`get <cid> [dir]`** fetches an upload by its IPFS Root CID, verifies every block, and checks whether the root file is an envelope. An envelope is decrypted with the Owner wallet or the session key's Grant and restored under its original name; plain content is saved unchanged, and you can `get` it without any key or login. Reference: [Get](../README.md#get).
- **`decrypt <file> <dir>`** does the same from a file you already downloaded (the bare `encrypted.fee`, or a CAR from a gateway or `/piece`), offline. Reference: [Encrypted Uploads](../README.md#encrypted-uploads) and [Retrieving Your Data](retrieval.md).

## What is private and what is not

| Private (inside the ciphertext only) | Not private (public) |
| --- | --- |
| File and folder names | The total size: the envelope header records the plaintext length, and the [Piece](glossary.md#piece) size is on chain |
| The folder structure | The group key id (`foc/ks`), in data set metadata and in every envelope |
| Individual file sizes | The Owner address (`foc/own` in the envelope, and the data set's payer) |
| The [Plaintext root CID](glossary.md#plaintext-root-cid) and every plaintext CID | Which Service Providers hold the ciphertext |
| The content | When it was uploaded, and that it is encrypted (`foc/enc` on the data set) |

A single file's size is visible to within a few hundred bytes. The piece's `name` [Metadata](glossary.md#metadata) is `encrypted.fee` unless you pass `--metadata name=…`. Errors and logs name a bad input entry by its position, not its path, and never print the Plaintext root CID.

## Lifecycle and limits

- **Grants cannot be revoked.** A Grant gives the session key permanent read access to everything in the group key, including future uploads. Revoking the session key ends its on-chain permissions, but the key holder can still unwrap the Grant. Narrower Grants will come with [Groups](glossary.md#group) ([#781](https://github.com/filecoin-project/filecoin-pin/issues/781)).
- **Expiry.** By the console's convention a Grant expires with the session key's authorization. The CLI refuses an expired Grant. Renewing the authorization does not renew the Grant: run `login --scopes …,encrypt` again for a new one. Expiry only stops the CLI from using the Grant; it does not take back the key.
- **One Grant per session key.** A new Grant replaces the saved one. `login --fresh` drops it (the replaced key can still open it), and `logout` deletes it with the session file.
- **Default group key.** An Owner's first group key id is derived from the Owner address: the first 16 bytes of `keccak256("filecoin/default-group-key" ‖ owner)`, with the owner as 20 raw bytes. Every client that sets up encryption before the first upload (the CLI, or several console logins) picks the same id. The group key id appears on chain with its first upload (as `foc/ks`); the CLI writes nothing about it to your machine.
- **Oldest valid group key wins.** When an Owner has several group keys, the CLI groups the live data sets by `foc/ks`, skips a group key whose data sets disagree on `foc/kc`, are not `foc/enc: "1"`, or whose id is not canonical, and uses the one holding the lowest data set id. A session key always writes under its Grant's group key, and refuses if that group key's data sets disagree with the Grant.
- **`--no-ipfs` uploads can't be fetched by root CID.** They are not announced to [IPNI](glossary.md#ipni) and the provider doesn't build an `/ipfs` index for them. Download the piece by its [Piece CID](glossary.md#piece-cid) from the provider's [`/piece` endpoint](glossary.md#piece-retrieval) and run `decrypt` on it.
- **A fresh upload may not be found right away.** cid.contact caches a miss for a while, so a `get` soon after upload can fail; try again later. See the [Content Routing FAQ](content-routing-faq.md#how-long-does-an-ipni-indexer-cache-results).
- **Size.** One upload holds about 1 GiB; larger input is refused before it is encrypted.

## Format, for integrators

This section describes the bytes as this version writes them. A shared package for reading and writing them is planned ([FilOzone/synapse-sdk#1040](https://github.com/FilOzone/synapse-sdk/issues/1040)).

### CAR-in-CAR packaging

```
input file or folder
  └─ inner CAR    (CARv1, unixfs-v1-2025, anonymous wrapping directory, metadata-first)
      └─ envelope (FEE, encrypted.fee)
          └─ outer CAR (CARv1, the envelope as one UnixFS file)  ← the Piece; its root is the Encrypted root CID
```

1. **Inner CAR.** The input is imported with the [unixfs-v1-2025 profile](glossary.md#unixfs-v1-2025-profile), so its CIDs match an unencrypted `add`, under an anonymous wrapping directory that holds the input under its own name. Blocks are written metadata-first: every dag-pb node (breadth-first from the root), then every raw leaf in file order, each CID once. A reader learns the whole tree before the first data byte, which lets `decrypt` unpack in one streaming pass and a viewer map a file offset to a byte range. The root of this CAR is the [Plaintext root CID](glossary.md#plaintext-root-cid).
2. **Envelope.** The inner CAR is encrypted with FEE scheme 2 (chunked AES-256-GCM, STREAM construction) at FEE's default chunk size of 256 KiB, with:
   - `content_type`: `application/vnd.ipld.car` (readers reject anything else);
   - the plaintext length in the header, so truncation is detected;
   - `appMetadata`: exactly Keysmith's `pieceMetadata`, which is all a reader needs to derive the key again:
     ```json
     { "foc/v": 1, "foc/own": "<owner, lowercase>", "foc/ks": "<group key id>", "foc/salt": "<16 random bytes, hex>" }
     ```
   Each upload gets a fresh salt, and so its own key, derived from the group key and the salt. `foc/scope` is added once [Groups](glossary.md#group) are used.
3. **Outer CAR.** The envelope, named `encrypted.fee`, is packed like any single-file `add` and uploaded. Its root is the [Encrypted root CID](glossary.md#encrypted-root-cid).

### Data set metadata

Encrypted uploads go to their own [Data Sets](glossary.md#data-set), tagged with:

| Key | Value |
| --- | --- |
| `foc/enc` | `"1"`: marks the data set as encrypted and versions its rules |
| `foc/ks` | The group key id: `0x` and 32 lowercase hex |
| `foc/kc` | A public commitment to the group key, `v1.<32 hex>`, checked before the group key is reused |
| `source` | `filecoin-pin`, as for every upload |
| `withIPFSIndexing` | Present unless `--no-ipfs` |

- An encrypted upload reuses a data set only when `foc/enc`, `foc/ks` and `foc/kc` all match; a missing copy gets a new data set with the same values. Only canonical group key ids are reused, matched exactly.
- A plain upload never reuses a data set carrying `foc/enc`, `foc/ks` or `foc/kc`, and `--data-set-id` pointing at the wrong kind of data set is refused.
- `--no-ipfs` uploads go to data sets without `withIPFSIndexing`, in the same group key. Indexed and `--no-ipfs` data sets never share uploads.
- Only the group key id and its commitment are written on chain, and both are public. The keys themselves are never published.

## Sharing (not available yet)

> **Not available yet.** Nothing in this section works in the current release. It describes planned designs so the terms make sense.

**Share links and Access keys** ([#779](https://github.com/filecoin-project/filecoin-pin/issues/779)). A planned `get-share-link <cid>` command, and an `add --encrypt` option, will share one upload with someone who has no wallet or Grant:

- The CLI generates a throwaway key pair for the share and wraps that one upload's key to its public key.
- The [Share link](glossary.md#share-link) opens the upload in the Filecoin encryption viewer ([FilOzone/synapse-sdk#1036](https://github.com/FilOzone/synapse-sdk/issues/1036)). Everything is in the link's fragment, so it never reaches a server.
- The [Access key](glossary.md#access-key) (`fak1_…`) is the throwaway private key, sent separately. The recipient needs both the link and the Access key to open the upload, and they open that one upload only.
- A `--restricted` variant puts the Access key in the link's fragment too, so one link opens the content directly, for when one channel is acceptable.
- Like Grants, shares cannot be revoked. To stop sharing, upload again.

**Recipient-bound links** ([#784](https://github.com/filecoin-project/filecoin-pin/issues/784)). The recipient's viewer generates its own key pair and sends its public key to the sender, who wraps the share to it. The recipient opens the link without an Access key, and only their own viewer can open it.

## Further reading

- [README: Encrypted Uploads](../README.md#encrypted-uploads), [Get](../README.md#get), [Login](../README.md#login), [Group key Grants](../README.md#group-key-grants), [Session-Key Permissions](../README.md#session-key-permissions), [Environment Variables](../README.md#environment-variables)
- [Glossary](glossary.md)
- [Retrieving Your Data](retrieval.md)
- [Keysmith README](https://github.com/FilOzone/synapse-sdk/tree/master/packages/keysmith)
- [Filecoin Encryption Envelope](https://github.com/FilOzone/synapse-sdk/tree/master/packages/filecoin-encryption-envelope) and its draft FRC ([filecoin-project/FIPs#1294](https://github.com/filecoin-project/FIPs/pull/1294))
