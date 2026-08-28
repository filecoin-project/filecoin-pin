# Content Routing FAQ

[Content Routing](glossary.md#content-routing) is essential for making the data stored with Filecoin Pin actually retrievable by [standard IPFS tooling](glossary.md#standard-ipfs-tooling).  This document answers questions about the content routing systems Filecoin Pin relies on.

## Will indexed CIDs from Calibration be mixed with CIDs from Mainnet?

Yes.  [IPNI](glossary.md#ipni) indexers are not chain aware.  They key on the CID and will point to whatever providers have "recently" advertised the CID.  This means that if a given piece is created with a [Calibration](glossary.md#calibration-network) SP and also with a Mainnet SP, the CIDs will list both SPs as providers.

## What happens when a piece is deleted?

When an SP is instructed to delete a [piece](glossary.md#piece), it announces a new advertisement to [IPNI](glossary.md#ipni) that includes the removal of the CIDs within the piece.  This update to IPNI goes through the normal IPNI flow of receiving advertisement announcements and then asynchronously fetching the advertisements from the provider.  As a result, deleted pieces should take seconds to low minutes for IPNI index state to be updated.

## What happens if a SP goes offline?

In this case, the [IPNI](glossary.md#ipni) indexer will still attempt to auto-sync with the publisher until 7 days (168 hours) have passed.  Once this timeout is hit, the offline-SP's advertised CIDs will be removed from the index.

## What happens if an SP loses index state?

In the event that an SP wipes their existing index state, the previously announced advertisements will still be stored by the [IPNI](glossary.md#ipni) indexer if no further action is done.  If the underlying advertisement disappears, but has already been processed by IPNI, this does not affect the availability of records, so long as the provider is still reachable. For the records to disappear, it is necessary to either:

1. publish a removal advertisement for the CIDs that need to be deleted OR
2. have the SP create a new advertisement chain under a new peer ID so as to let the old provider records die out (7 days per above)

## How long does an IPNI indexer cache results?

[cid.contact](http://cid.contact) tends to cache hits for multiple hours and cache misses (negative cache) for minutes.  As a result of this, there are "gotchas" we have to be careful to avoid or can unavoidably fall into.

- cid.contact cache miss "gotcha" - Because cid.contact caches misses (i.e., negative cache), it's important for Filecoin Pin to not poll `GET /cid/{cid}` aggressively before the advertisement has actually been processed.  The act of polling could cause the empty result set to get cached for minutes.  Instead, Filecoin Pin first polls the storage provider's `GET /pdp/piece/{pieceCid}/status` until it reports `synced: true` — the SP checks the indexer's own sync-status endpoint on Filecoin Pin's behalf here, which isn't a CID lookup and isn't subject to the same negative caching, so it's safe for the SP to do that patiently.  Only once the SP confirms sync does Filecoin Pin make a small, bounded number of `GET /cid/{cid}` queries, to confirm the expected provider's record actually shows up.  If a provider never reports `synced: true`, Filecoin Pin reports failure without ever falling back to `GET /cid/{cid}` — the SP already did the patient, safe check on its end, so a further `/cid/{cid}` fallback would be redundant and risk the exact negative-cache problem this whole flow exists to avoid.
- cid.contact cache hit "gotcha" - If cid.contact has a provider record(s) for CID X, but CID X is not currently retrievable from any of those provider(s), then cid.contact could be caching a non-retrievable result for hours. We currently don't have a workaround for this…
