# Content Routing FAQ

[Content Routing](glossary.md#content-routing) is essential for making the data stored with Filecoin Pin actually retrieval by [standard IPFS tooling](glossary.md#standard-ipfs-tooling).  This document answers questions about the content routing systems Filecoin Pin relies on.

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

This depends on both the [IPNI](glossary.md#ipni) indexer instance (e.g., cid.contact, filecoinpin.contact) and whether there is a cache hit or cache miss.

[cid.contact](http://cid.contact) for example tends to cache hits for multiple hours and cache misses (negative cache) for minutes.  As a result of this, there are "gotchas" we have to be careful to avoid or can unavoidably fall into.

- [cid.contact](http://cid.contact) cache miss "gotcha" - Because cid.contact caches misses (i.e., negative cache), it's important for Filecoin Pin to not poll cid.contact after an advertisement has been announced.  The act of polling could cause the empty result set to get cached for minutes.  Instead, Filecoin Pin polls [filecoinpin.contact](http://filecoinpin.contact) which doesn't have negative caching.  Once Filecoin Pin sees the expected results from filecoinpin.contact it then proceeds to give IPFS Mainnet retrieval URLs since it should be safe to invoke a request path that hits cid.contact because cid.contact should now not get a non-empty result.
- [cid.contact](http://cid.contact) cache hit "gotcha" - If cid.contact has a provider record(s) for CID X, but CID X is not currently from any of those provider(s), then cid.contact could be caching non-retrievable result for hours even though filecoinpin.contact has a provider that makes CID X retrievable. We currently don't have a workaround for this…

## Why is there filecoinpin.contact and cid.contact?

[filecoinpin.contact](http://filecoinpin.contact) serves two purposes currently:

1. Serve as a fallback in case [cid.contact](http://cid.contact) has issues keeping its global index updated.  To help with availability, cid.contact has the ability to delegate requests to other [IPNI](glossary.md#ipni) indexers like [filecoinpin.contact](http://filecoinpin.contact) in case they have results.
2. Validate IPNI announcing/advertising independently of [cid.contact](http://cid.contact).  Per the "[cid.contact](http://cid.contact) cache miss gotcha" above, the act of polling cid.contact can actually delay how long it takes before cid.contact returns a non-empty result for a given CID.  [filecoinpin.contact](http://filecoinpin.contact) has different caching configuration so that polling can be done safely.
