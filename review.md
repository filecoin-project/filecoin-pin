## Round 1 Verification

1. **OOM:** `assembleMultiRootCar` streams member blocks straight into the writer. **FIXED** (`src/migrate/pack-cars.ts:168`).
2. **`store()` result verified:** Mismatch throws `CommPMismatchError` and skips the piece for the run. **FIXED** (`src/migrate/direct-upload.ts:477`).
3. **Missing secondary rows repaired:** Re-queries and pulls on resume. **FIXED** (`src/migrate/direct-upload.ts:394`).
4. **Reconcile uses `u.dataSetId ?? ctx.dataSetId`:** **FIXED** (`src/migrate/direct-upload.ts:501`).
5. **`revertUploadsToParked` clears tx_hash/piece_id/committed_at:** **FIXED** (`src/migrate/db.ts:557`).
6. **Eviction rule:** Primary committed suffices. **FIXED** (`src/migrate/db.ts:608`).
7. **`add_unconfirmed` counts in summary/exit code:** Checked by `migrateIncomplete`. **FIXED** (`src/migrate/migrate.ts:264`).
8. **State scoped per network + owner:** `MigrationDB` instantiated with `scope`. **FIXED** (`src/migrate/migrate.ts:208`).

## New Findings (Correctness Issues)

1. **Consumer Spin Loop on CommPMismatch (CPU lockup) - CRITICAL** (`src/migrate/direct-upload.ts:334`, `src/migrate/run-migrate.ts:294`)
   - **Scenario:** If a piece throws `CommPMismatchError`, it is added to the `mismatched` set and skipped (`next == null`). The uploader calls `waitForMore()`, which parks it and calls `checkStuck()`. `checkStuck()` queries `subPiecesNeedingUpload()`, sees the failed piece is still pending, and immediately wakes the uploader. The uploader wakes, finds `next == null`, parks, and the cycle repeats infinitely, pinning a CPU core and stalling the pipeline if downloads are budget-blocked.

2. **Oversized CID Livelock / Budget Leak - CRITICAL** (`src/migrate/pack-cars.ts:346`)
   - **Scenario:** A CID with `rawSize > MAX_UPLOAD_BYTES` is added to `overCap` but is never marked `failed` in the DB and its file is never unlinked. It stays in the `done` pool permanently eating staging budget. `checkStuck()` sees `db.freeMemberBytes() > 0` and endlessly triggers `packNow()`, which skips it and returns `built: 0` without waking the uploader. The pipeline deadlocks.

3. **Budget Wake-up Leak on Assembly Failure** (`src/migrate/pack-cars.ts:406`, `src/migrate/run-migrate.ts:327`)
   - **Scenario:** If `buildBin` fails midway, the `catch` block calls `opts.onBytesStaged?.(-binWritten)` to return the bytes. This routes to `budget.add(-delta)`. While this corrects the `used` count, `StagingBudget.add` does not call `wakeAll()` (unlike `budget.free()`). Parked download workers wait forever unless an unrelated eviction frees space.

4. **Unhandled `packError` Stall** (`src/migrate/run-migrate.ts:341`)
   - **Scenario:** If `packNow()` encounters a permanent error (e.g., local disk permissions), it sets `packError` but does not wake anyone. The producer loop keeps downloading until the budget is full, parks, and `checkStuck` calls `packNow()` again, which fails silently again. The pipeline hangs instead of exiting cleanly.

## Doc / Code Mismatches

1. **Blind retries on crash:** The doc claims "A commit whose outcome is unknown (the process died mid-transaction) is never blindly retried... if not, it re-queues."
   - **Code:** If the process crashes after `ctx.commit` signs and broadcasts the transaction but before `onSubmitted` records `txHash`, the DB row is `add_unconfirmed` with `txHash == null`. `reconcileUnconfirmed` (`src/migrate/direct-upload.ts:524`) falls through to `hasPiece`, finds it parked, and blindly reverts it to `parked`, meaning it will be added to the next flush and double-added on chain.
2. **Oversized pieces:** The doc claims "A CID over the 1016 MiB cap cannot migrate... and is reported, not dropped silently."
   - **Code:** It is reported, but because it is never purged from the `done` pool, it silently stalls the pipeline and breaks the disk budget accounting.

## Top 3 Changes Required for Calibnet Validation

1. **Fix the CommPMismatch spin loop & Oversized CID leak:** In `pack-cars.ts`, mark oversized pieces as `failed` in the DB and unlink them. In `direct-upload.ts`/`db.ts`, ensure pieces that permanently fail a primary store (like `CommPMismatchError`) are not continually returned by `subPiecesNeedingUpload`, and that their local CARs are evicted to free budget.
2. **Fix `add_unconfirmed` null-txHash handling:** In `reconcileUnconfirmed`, if `status === 'add_unconfirmed'` but `txHash == null`, it MUST be left `add_unconfirmed` (just like a landed tx with missing events) so the operator can manually check the data set. A blind re-queue is unsafe.
3. **Fix Budget Wake-up Leaks:** Change `opts.onBytesStaged?.(-binWritten)` to use `budget.free(binWritten)` so waiters are woken, and ensure `checkStuck()` checks `packError` to fail the budget (`budget.failAll()`) and abort the run cleanly if the packer is permanently broken.
