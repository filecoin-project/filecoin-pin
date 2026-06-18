# Retrieving Your Data

Each `filecoin-pin add` reports two CIDs, and they fetch different things:

- [IPFS Root CID](glossary.md#ipfs-root-cid) (`bafy...`) is the root of your content as an IPFS DAG. Use it with IPFS tooling and gateways, the [`/ipfs` retrieval](glossary.md#ipfs-retrieval) paths below.
- [Piece CID](glossary.md#piece-cid) (`bafkzcib...`) commits the whole [CAR](glossary.md#car) that Filecoin Pin packed and stored on chain. Use it to pull those exact bytes back, the [`/piece` retrieval](glossary.md#piece-retrieval) path below.

These two CIDs are [related but distinct](glossary.md#relationship-between-piece-cid-and-ipfs-root-cid); neither can be derived from the other.

Retrieval works once [IPNI](glossary.md#ipni) content routing is in place. Filecoin Pin waits for this before printing retrieval URLs. See the [Content Routing FAQ](content-routing-faq.md) for timing.

## View it in a browser

```
https://inbrowser.link/ipfs/<root-cid>
```

[inbrowser.link](https://inbrowser.link/) is a verifiable Service Worker Gateway. It fetches the raw blocks and verifies them against the CID inside your browser, using Helia's [`verified-fetch`](https://www.npmjs.com/package/@helia/verified-fetch), before rendering. The public `dweb.link` and `ipfs.io` gateways now [redirect browser navigations here](https://ipshipyard.com/blog/2026-ipfs-gateways-redirect-inbrowser-link/), so this is the link to share.

## Fetch via a public gateway

```
https://dweb.link/ipfs/<root-cid>
```

For hot-linking (e.g., `src` of an `img` tag) and non-browser clients (e.g., `curl`). A browser navigating here is redirected to inbrowser.link; programmatic requests are served directly. `dweb.link` is a [trustless gateway](glossary.md#ipfs-retrieval), so you can request verifiable responses:

- `?format=car` (or `Accept: application/vnd.ipld.car`) returns the [CAR](glossary.md#car) for the whole DAG.
- `Accept: application/vnd.ipld.raw` returns a single raw block.

Public gateways like [dweb.link/ipfs.io are rate-limited and best-effort](https://about.ipfs.io/#public-utility). In production, retrieve through your own [Helia](https://helia.io/) or [Kubo](https://github.com/ipfs/kubo) node, or `verified-fetch`, so verification happens close to your user. Alternatively, run your own [IPFS Gateway](https://docs.ipfs.io/concepts/ipfs-gateway/) that meets your operational requirements.

## Retrieve directly from the Service Provider

Each [Service Provider](glossary.md#service-provider) exposes two endpoints:

- [`/ipfs`](glossary.md#ipfs-retrieval) serves a trustless gateway by IPFS Root CID, the same protocol the public gateways use.
- [`/piece`](glossary.md#piece-retrieval) serves the [Piece CID](glossary.md#piece-cid): the exact CAR bytes stored and proven on chain, optionally a byte range.

Both return a CAR. `/piece` gives the stored bytes verbatim. `?format=car` on an `/ipfs` endpoint rebuilds a CAR from per-block retrieval, so the byte layout can differ, but the content and root CID match.
