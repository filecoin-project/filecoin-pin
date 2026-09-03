# How migrate works

`filecoin-pin migrate <cid-list-file>` moves a list of IPFS CIDs onto [Filecoin Onchain Cloud](glossary.md#filecoin-onchain-cloud). You give it a text file with one [CID](glossary.md#cid) per line; it downloads each one from a trustless gateway, packs them into large [pieces](glossary.md#piece), uploads those pieces to [storage providers](glossary.md#storage-provider), and commits them on chain in batches. Every step is recorded in a local sqlite database, so a killed or crashed run resumes where it left off.

This page explains the pipeline and the guarantees behind it. For flags and defaults, run `filecoin-pin migrate --help`.

## Why not just run `add` in a loop

Two reasons: cost and throughput. Each on-chain `addPieces` transaction can carry up to 40 pieces, and each piece can hold up to 1016 MiB. Uploading a 2 MiB CID as its own piece wastes both dimensions. Migrate packs many source CIDs into one ~1000 MiB multi-root [CAR](glossary.md#car) and commits up to 40 of those pieces per transaction, so a million small files does not mean a million transactions.

## The pipeline

Four stages run concurrently, connected by a disk budget:

```
download + verify --> pack --> upload --> commit --> evict
        ^                                              |
        +-------------- disk budget freed <------------+
```

1. **Download and verify.** Each CID is fetched from a trustless gateway as a CAR, once. In a single pass the bytes are written to a member file on disk while every block is hash-checked against its CID, the DAG is walked to confirm every reachable link is present, and the [CommP](glossary.md#commp) is computed. A truncated or corrupt gateway response fails that CID loudly instead of migrating incomplete data. The bytes that were verified are the bytes on disk, and later the bytes uploaded.
2. **Pack.** When enough verified members accumulate to fill a piece (default target 1000 MiB), they are bin-packed and assembled into one multi-root CAR, streamed disk-to-disk. The assembled piece's CommP is computed during assembly. Member files are deleted only after the piece and its member list are recorded atomically. A CID too large to share a piece ships alone; a CID over the 1016 MiB cap cannot migrate on this path and is reported, not dropped silently.
3. **Upload.** Each packed piece is stored on the primary provider over HTTP. Secondary copies pull provider-to-provider from the primary, so your bandwidth is spent once per piece regardless of `--copies`. A stored-but-uncommitted piece is "parked": [Curio](glossary.md#curio) garbage-collects parked pieces after a window (roughly 2 hours, provider-configurable, not discoverable), which is why commit timing matters.
4. **Commit and evict.** Parked pieces are flushed through one `addPieces` transaction when the batch reaches 40, when the oldest parked piece nears the assumed GC window (the margin adapts to observed confirmation times), or when the source drains. Once a piece is committed on chain, its staged file is deleted, which frees disk budget and unblocks the download stage.

## The disk budget

At startup, migrate measures free space in its staging directory and takes a budget (capped by `--max-staged-bytes` if you set it). Everything staged counts against it: member files, in-flight downloads, the piece being assembled, and packed pieces not yet committed. When the budget is full, downloads block until eviction frees space.

The budget is the whole flow-control mechanism. There is no rate probing and no schedule: a bounded pipeline runs at the speed of its slowest stage automatically, and it keeps adapting when the gateway throttles or a provider slows down. If your disk is smaller than your migration, the pipeline cycles through it; a full staging directory is the normal steady state, not a failure. A budget too small to assemble even one piece is refused up front with a clear error.

## The GC window

Committing every piece individually would be safe but wasteful; waiting for a full batch of 40 risks the provider garbage-collecting the oldest parked piece first. Migrate starts from a conservative window guess (60 minutes, `--assumed-window-minutes`) and flushes a partial batch whenever the oldest parked piece gets close. The costs are asymmetric (an early flush costs one extra transaction, a collected piece costs a full re-upload), so every tie breaks toward flushing sooner. When a commit is rejected because a piece was already collected, the window estimate is lowered from the evidence and the piece is re-uploaded. The estimate only ever moves down.

## Resume

State lives in `migrate.db` under the filecoin-pin data directory (`--db` overrides it). Kill the process at any point and re-run with the same CID list:

- Downloaded members are verified against their recorded hash and reused; anything missing or corrupt is re-downloaded, and only that CID.
- Packed pieces on disk are re-verified and re-enter the upload queue.
- A commit whose outcome is unknown (the process died mid-transaction) is never blindly retried. Resume checks the transaction receipt first: if the `PiecesAdded` event is on chain, the piece is marked committed; if not, it re-queues. A blind retry could add the same piece to your [data set](glossary.md#data-set) twice, so rows that cannot be resolved either way stay flagged and the run exits non-zero.
- Nothing staged is deleted until the piece it belongs to is committed for every copy that still needs the local bytes.

Two runs against the same `migrate.db` at the same time are not supported.

## Data sets and cost

Migrate writes into its own [data sets](glossary.md#data-set), tagged with `migrate: true` [metadata](glossary.md#metadata), separate from the data sets `add` and `import` use. Pass `--data-set-id` to target an existing one instead.

Egress defaults to `none` for migrate: bulk archives will not pay [FilBeam](glossary.md#filbeam-egress) CDN lockup unless you ask for it with `--egress-provider beam`. Storage costs are the same as any other upload; run `filecoin-pin payments status` before a large migration.

## What the exit code means

`0` means every CID in the list is committed on chain at the requested number of copies. Anything short of that (failed downloads, over-cap CIDs, unresolved commits, missing copies) exits `1`, and the summary JSON on stdout says exactly which CIDs need attention. Re-running is always safe.
