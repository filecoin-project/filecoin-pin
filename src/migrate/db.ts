/**
 * Migrate state store, backed by Node's built-in node:sqlite (no dependency).
 *
 * The database is the single source of truth for a migration run: each source
 * CID's piece commitment and member file, the packed piece it landed in, and
 * the per-provider upload lifecycle. A run resumes from here after any
 * interruption. Rows are scoped per network and owner address so one
 * `migrate.db` serves development runs against different networks and wallets
 * without cross-talk.
 *
 * Concurrent runs against the same file are unsupported: WAL mode plus
 * `busy_timeout` keep a second process from corrupting state, but two live
 * runners would race the same work items.
 */

import { DatabaseSync } from 'node:sqlite'

export type PieceStatus = 'pending' | 'done' | 'failed' | 'oversized'

/**
 * Failure taxonomy set alongside `pieces.error` so operators can triage by
 * category rather than parsing free-form error strings.
 */
export type FailureCategory =
  | 'source_gateway_429'
  | 'source_gateway_5xx'
  | 'source_gateway_network'
  | 'source_gateway_timeout'
  | 'car_incomplete'
  | 'car_root_mismatch'
  | 'commp_mismatch'
  | 'oversized'
  | 'staging_budget'
  | 'other'

/**
 * Packed piece lifecycle. A sub-piece is a synthetic multi-root CAR that
 * groups M source CIDs into one uploadable piece. `built` means the assembled
 * CAR is on disk (under the staging directory) and its commitment matched;
 * `failed` is set if assembly produced a different commitment than planned.
 */
export type SubPieceStatus = 'built' | 'failed'

export interface SubPieceRow {
  subPieceCid: string
  assembledCarLength: number
  assembledSha256: string | null
  targetSizeBytes: number
  /** Local CAR file for the assembled sub-piece. */
  carPath: string | null
  status: SubPieceStatus
}

export interface PieceRow {
  cid: string
  pieceCid: string | null
  rawSize: number | null
  gateway: string | null
  url: string | null
  /** Verified member CAR file on disk; null until the download completes. */
  memberCarPath: string | null
  /** sha256 of the member CAR bytes, for resume re-verification. */
  memberSha256: string | null
  status: PieceStatus
  error: string | null
}

/**
 * Direct-upload lifecycle, per (sub-piece, provider) pair: the migrate
 * command stores the same CAR on every provider copy independently.
 *
 *   parked           the provider holds the bytes; nothing on-chain. Curio
 *                    garbage-collects parked pieces after an undiscoverable
 *                    window (~2h default), so parked_at drives the flush timer
 *   add_unconfirmed  an addPieces batch containing this piece was attempted;
 *                    outcome unknown. Never auto-reset into a blind re-add
 *   committed        addPieces landed; data_set_id/piece_id/tx_hash are final
 *   collected        the provider garbage-collected the parked piece before
 *                    commit; the piece must be stored (or pulled) again
 *   failed           store, pull, or commit failed for a non-GC reason
 */
export type UploadStatus = 'parked' | 'add_unconfirmed' | 'committed' | 'collected' | 'failed'

export type UploadRole = 'primary' | 'secondary'

export interface UploadRow {
  subPieceCid: string
  providerId: string
  role: UploadRole
  dataSetId: string | null
  status: UploadStatus
  /** ISO timestamp of store() completion: the moment the GC clock starts. */
  parkedAt: string
  txHash: string | null
  pieceId: string | null
  committedAt: string | null
  /** Timestamp of the row's last state transition. */
  updatedAt: string
  error: string | null
}

export class MigrationDB {
  #db: DatabaseSync
  /** The sqlite file path this instance opened, so callers can echo it back. */
  readonly path: string
  /** Network + owner-address scope for every row this instance touches. */
  readonly scope: string

  constructor(path: string, scope: string) {
    this.path = path
    this.scope = scope
    this.#db = new DatabaseSync(path)
    // busy_timeout must come before any other exec: even setting WAL needs
    // the write lock, and a sibling process holding it will error out the
    // very first pragma without this. Without busy_timeout, the sqlite layer
    // surfaces SQLITE_BUSY as `disk I/O error`.
    this.#db.exec('PRAGMA busy_timeout = 5000')
    this.#db.exec('PRAGMA journal_mode = WAL')
    this.#migrate()
  }

  #migrate(): void {
    // No ALTERs: schema is unreleased, so each new column joins the CREATE
    // statement directly. sub_pieces / sub_piece_members hold the packed
    // multi-root CAR groups (each one is a single uploadable piece).
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS pieces (
        scope            TEXT NOT NULL,
        cid              TEXT NOT NULL,
        piece_cid        TEXT,
        raw_size         INTEGER,
        gateway          TEXT,
        url              TEXT,
        member_car_path  TEXT,
        member_sha256    TEXT,
        status           TEXT NOT NULL DEFAULT 'pending',
        error            TEXT,
        failure_category TEXT,
        updated_at       TEXT NOT NULL,
        PRIMARY KEY (scope, cid)
      );
      CREATE TABLE IF NOT EXISTS sub_pieces (
        scope                 TEXT NOT NULL,
        sub_piece_cid         TEXT NOT NULL,
        assembled_car_length  INTEGER NOT NULL,
        assembled_sha256      TEXT,
        target_size_bytes     INTEGER NOT NULL,
        car_path              TEXT NOT NULL,
        status                TEXT NOT NULL DEFAULT 'built',
        built_at              TEXT,
        error                 TEXT,
        created_at            TEXT NOT NULL,
        PRIMARY KEY (scope, sub_piece_cid)
      );
      CREATE TABLE IF NOT EXISTS sub_piece_members (
        scope             TEXT NOT NULL,
        sub_piece_cid     TEXT NOT NULL,
        member_cid        TEXT NOT NULL,
        member_sort_order INTEGER NOT NULL,
        member_sha256     TEXT,
        member_raw_size   INTEGER,
        PRIMARY KEY (scope, sub_piece_cid, member_cid),
        FOREIGN KEY (scope, sub_piece_cid) REFERENCES sub_pieces(scope, sub_piece_cid),
        FOREIGN KEY (scope, member_cid) REFERENCES pieces(scope, cid)
      );
      CREATE TABLE IF NOT EXISTS uploads (
        scope         TEXT NOT NULL,
        sub_piece_cid TEXT NOT NULL,
        provider_id   TEXT NOT NULL,
        role          TEXT NOT NULL,
        data_set_id   TEXT,
        status        TEXT NOT NULL DEFAULT 'parked',
        parked_at     TEXT NOT NULL,
        tx_hash       TEXT,
        piece_id      TEXT,
        committed_at  TEXT,
        error         TEXT,
        updated_at    TEXT NOT NULL,
        PRIMARY KEY (scope, sub_piece_cid, provider_id),
        FOREIGN KEY (scope, sub_piece_cid) REFERENCES sub_pieces(scope, sub_piece_cid)
      );
      CREATE TABLE IF NOT EXISTS provider_windows (
        scope             TEXT NOT NULL,
        provider_id       TEXT NOT NULL,
        assumed_window_ms INTEGER NOT NULL,
        updated_at        TEXT NOT NULL,
        PRIMARY KEY (scope, provider_id)
      );
    `)
  }

  /** Register CIDs for processing. Existing rows are left untouched (resumable). */
  addCids(cids: string[]): void {
    const stmt = this.#db.prepare(
      `INSERT INTO pieces (scope, cid, status, updated_at) VALUES (?, ?, 'pending', ?)
       ON CONFLICT(scope, cid) DO NOTHING`
    )
    const now = new Date().toISOString()
    for (const cid of cids) {
      stmt.run(this.scope, cid, now)
    }
  }

  /** CIDs not yet downloaded and verified. Failed CIDs re-enter the queue. */
  pendingCids(): string[] {
    const rows = this.#db
      .prepare(`SELECT cid FROM pieces WHERE scope = ? AND status IN ('pending', 'failed') ORDER BY cid`)
      .all(this.scope)
    return rows.map((r) => (r as { cid: string }).cid)
  }

  /** Record a verified member download: commP, sizes, and the on-disk CAR file. */
  recordPieceSuccess(
    cid: string,
    info: {
      pieceCid: string
      rawSize: number
      gateway: string
      url: string
      memberCarPath: string
      memberSha256: string
    }
  ): void {
    this.#db
      .prepare(
        `UPDATE pieces SET piece_cid=?, raw_size=?, gateway=?, url=?,
                            member_car_path=?, member_sha256=?,
                            status='done', error=NULL, failure_category=NULL, updated_at=?
         WHERE scope=? AND cid=?`
      )
      .run(
        info.pieceCid,
        info.rawSize,
        info.gateway,
        info.url,
        info.memberCarPath,
        info.memberSha256,
        new Date().toISOString(),
        this.scope,
        cid
      )
  }

  recordPieceFailure(cid: string, error: string, category: FailureCategory = 'other'): void {
    this.#db
      .prepare(`UPDATE pieces SET status='failed', error=?, failure_category=?, updated_at=? WHERE scope=? AND cid=?`)
      .run(error, category, new Date().toISOString(), this.scope, cid)
  }

  /**
   * Return a `done` piece to `pending`, clearing its member-file columns. The
   * startup sweep uses this when the recorded member CAR is missing or does
   * not match its recorded sha256: only that CID re-downloads.
   */
  resetPieceToPending(cid: string): void {
    this.#db
      .prepare(
        `UPDATE pieces SET status='pending', member_car_path=NULL, member_sha256=NULL,
                            piece_cid=NULL, raw_size=NULL, error=NULL, failure_category=NULL, updated_at=?
         WHERE scope=? AND cid=?`
      )
      .run(new Date().toISOString(), this.scope, cid)
  }

  counts(): { pending: number; done: number; failed: number; oversized: number; total: number } {
    const row = this.#db
      .prepare(
        `SELECT
           SUM(status='pending')    AS pending,
           SUM(status='done')       AS done,
           SUM(status='failed')     AS failed,
           SUM(status='oversized')  AS oversized,
           COUNT(*)                 AS total
         FROM pieces WHERE scope = ?`
      )
      .get(this.scope) as Record<string, number | null>
    return {
      pending: Number(row.pending ?? 0),
      done: Number(row.done ?? 0),
      failed: Number(row.failed ?? 0),
      oversized: Number(row.oversized ?? 0),
      total: Number(row.total ?? 0),
    }
  }

  failures(): Array<{ cid: string; error: string; category: FailureCategory }> {
    const rows = this.#db
      .prepare(`SELECT cid, error, failure_category FROM pieces WHERE scope = ? AND status='failed' ORDER BY cid`)
      .all(this.scope)
    return rows.map((r) => {
      const row = r as Record<string, unknown>
      return {
        cid: String(row.cid),
        error: String(row.error ?? ''),
        category: (row.failure_category as FailureCategory | undefined) ?? 'other',
      }
    })
  }

  /**
   * Insert a sub-piece row in `built` status together with its member rows in
   * one transaction: a crash between the two writes must never strand a
   * sub-piece with locked members and no recovery pass.
   */
  recordBuiltSubPiece(args: {
    subPieceCid: string
    assembledCarLength: number
    targetSizeBytes: number
    carPath: string
    assembledSha256: string
    members: Array<{ cid: string; rawSize: number | null; sha256: string | null }>
  }): void {
    const now = new Date().toISOString()
    const insertSub = this.#db.prepare(
      `INSERT INTO sub_pieces (scope, sub_piece_cid, assembled_car_length, target_size_bytes,
                                status, car_path, assembled_sha256, built_at, created_at)
       VALUES (?, ?, ?, ?, 'built', ?, ?, ?, ?)`
    )
    const insertMember = this.#db.prepare(
      `INSERT INTO sub_piece_members (scope, sub_piece_cid, member_cid, member_sort_order,
                                       member_sha256, member_raw_size)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    this.#db.exec('BEGIN')
    try {
      insertSub.run(
        this.scope,
        args.subPieceCid,
        args.assembledCarLength,
        args.targetSizeBytes,
        args.carPath,
        args.assembledSha256,
        now,
        now
      )
      args.members.forEach((m, i) => {
        insertMember.run(this.scope, args.subPieceCid, m.cid, i, m.sha256, m.rawSize)
      })
      // The members' bytes now live in the recorded piece; clearing their
      // member-file columns in the same transaction keeps the startup sweep
      // from treating the soon-deleted files as missing and re-queueing
      // already-packed downloads.
      const clearMember = this.#db.prepare(
        `UPDATE pieces SET member_car_path = NULL, member_sha256 = NULL, updated_at = ?
         WHERE scope = ? AND cid = ?`
      )
      for (const m of args.members) {
        clearMember.run(now, this.scope, m.cid)
      }
      this.#db.exec('COMMIT')
    } catch (err) {
      this.#db.exec('ROLLBACK')
      throw err
    }
  }

  /**
   * Remove a staged piece whose CAR file failed re-verification, freeing its
   * member CIDs to re-download. One transaction deletes the piece, its
   * member list, and any upload rows, then returns the affected source CIDs
   * so the caller can reset them to pending. Refuses a piece whose primary
   * copy is already committed: that piece is on chain and its local file no
   * longer matters.
   */
  deleteSubPieceForRebuild(subPieceCid: string): string[] {
    // Live provider-side state blocks a rebuild: a committed primary is
    // final, an add_unconfirmed row is an unresolved breadcrumb whose
    // deletion could turn into a duplicate on-chain add, and a parked copy
    // can still commit from the provider's bytes without the local file.
    // Reconciliation resolves those states first; the rebuild waits for a
    // run where none remain.
    const live = this.#db
      .prepare(
        `SELECT status FROM uploads
         WHERE scope = ? AND sub_piece_cid = ?
           AND (status IN ('parked', 'add_unconfirmed') OR (role = 'primary' AND status = 'committed'))
         LIMIT 1`
      )
      .get(this.scope, subPieceCid) as { status: string } | undefined
    if (live != null) {
      throw new Error(`refusing to rebuild ${subPieceCid}: it has a live upload in status '${live.status}'`)
    }
    const members = this.subPieceMemberCids(subPieceCid)
    this.#db.exec('BEGIN')
    try {
      this.#db.prepare(`DELETE FROM uploads WHERE scope = ? AND sub_piece_cid = ?`).run(this.scope, subPieceCid)
      this.#db
        .prepare(`DELETE FROM sub_piece_members WHERE scope = ? AND sub_piece_cid = ?`)
        .run(this.scope, subPieceCid)
      this.#db.prepare(`DELETE FROM sub_pieces WHERE scope = ? AND sub_piece_cid = ?`).run(this.scope, subPieceCid)
      this.#db.exec('COMMIT')
    } catch (err) {
      this.#db.exec('ROLLBACK')
      throw err
    }
    return members
  }

  /**
   * Mark CIDs whose CAR exceeds the per-piece upload cap. Terminal: they
   * leave the free pool and the retry queue, and only appear in reporting.
   */
  markOversized(cids: string[]): void {
    const stmt = this.#db.prepare(
      `UPDATE pieces SET status='oversized', failure_category='oversized',
                          member_car_path=NULL, member_sha256=NULL, updated_at=?
       WHERE scope=? AND cid=?`
    )
    const now = new Date().toISOString()
    for (const cid of cids) stmt.run(now, this.scope, cid)
  }

  /** Look up a sub-piece by its packed PieceCID v2. Null when no row exists. */
  subPieceByCid(subPieceCid: string): SubPieceRow | null {
    const row = this.#db
      .prepare(
        `SELECT sub_piece_cid, assembled_car_length, assembled_sha256, target_size_bytes,
                car_path, status FROM sub_pieces WHERE scope = ? AND sub_piece_cid = ? LIMIT 1`
      )
      .get(this.scope, subPieceCid) as Record<string, unknown> | undefined
    if (row == null) return null
    return toSubPieceRow(row)
  }

  /** Sub-pieces in the given status. */
  subPiecesByStatus(status: SubPieceStatus): SubPieceRow[] {
    const rows = this.#db
      .prepare(
        `SELECT sub_piece_cid, assembled_car_length, assembled_sha256, target_size_bytes,
                car_path, status FROM sub_pieces WHERE scope = ? AND status = ? ORDER BY sub_piece_cid`
      )
      .all(this.scope, status)
    return rows.map(toSubPieceRow)
  }

  /**
   * Ordered member CIDs of a sub-piece (sort order set at pack time): the
   * order the piece commitment was computed against.
   */
  subPieceMemberCids(subPieceCid: string): string[] {
    const rows = this.#db
      .prepare(
        `SELECT member_cid FROM sub_piece_members
         WHERE scope = ? AND sub_piece_cid = ? ORDER BY member_sort_order`
      )
      .all(this.scope, subPieceCid)
    return rows.map((r) => String((r as { member_cid: string }).member_cid))
  }

  /**
   * Verified members not yet packed into a sub-piece. Membership in any
   * sub-piece excludes a piece; composition is set at INSERT and never
   * mutates.
   */
  donePiecesFreeForPacking(): PieceRow[] {
    const rows = this.#db
      .prepare(
        `SELECT p.cid, p.piece_cid, p.raw_size, p.gateway, p.url,
                p.member_car_path, p.member_sha256, p.status, p.error
         FROM pieces p
         WHERE p.scope = ? AND p.status='done'
           AND p.cid NOT IN (SELECT member_cid FROM sub_piece_members WHERE scope = ?)
         ORDER BY p.cid`
      )
      .all(this.scope, this.scope)
    return rows.map(toPieceRow)
  }

  /** Total bytes of verified members not yet packed (pack trigger + budget resync). */
  freeMemberBytes(): number {
    const row = this.#db
      .prepare(
        `SELECT COALESCE(SUM(p.raw_size), 0) AS n
         FROM pieces p
         WHERE p.scope = ? AND p.status='done'
           AND p.cid NOT IN (SELECT member_cid FROM sub_piece_members WHERE scope = ?)`
      )
      .get(this.scope, this.scope) as { n: number }
    return Number(row.n)
  }

  /** Every `done` piece with a recorded member file, for the startup sweep. */
  donePiecesWithMembers(): Array<{ cid: string; memberCarPath: string; memberSha256: string | null }> {
    const rows = this.#db
      .prepare(
        `SELECT cid, member_car_path, member_sha256
         FROM pieces
         WHERE scope = ? AND status='done' AND member_car_path IS NOT NULL
           AND cid NOT IN (SELECT member_cid FROM sub_piece_members WHERE scope = ?)`
      )
      .all(this.scope, this.scope)
    return rows.map((r) => {
      const row = r as Record<string, unknown>
      return {
        cid: String(row.cid),
        memberCarPath: String(row.member_car_path),
        memberSha256: row.member_sha256 == null ? null : String(row.member_sha256),
      }
    })
  }

  // ---- direct-upload state (uploads / provider_windows) ----

  /** Built, file-backed sub-pieces with no live upload row for this provider. */
  subPiecesNeedingUpload(providerId: string): SubPieceRow[] {
    const rows = this.#db
      .prepare(
        `SELECT sp.sub_piece_cid, sp.assembled_car_length, sp.assembled_sha256,
                sp.target_size_bytes, sp.car_path, sp.status
         FROM sub_pieces sp
         WHERE sp.scope = ? AND sp.status = 'built'
           AND NOT EXISTS (
             SELECT 1 FROM uploads u
             WHERE u.scope = sp.scope
               AND u.sub_piece_cid = sp.sub_piece_cid
               AND u.provider_id = ?
               AND u.status IN ('parked', 'add_unconfirmed', 'committed', 'failed')
           )
         ORDER BY sp.created_at, sp.rowid`
      )
      .all(this.scope, providerId)
    return rows.map(toSubPieceRow)
  }

  /**
   * Built sub-pieces whose primary copy is live but that lack any row for
   * the given secondary provider. A crash between the primary store and the
   * secondary pull leaves exactly this shape; the retry pass repairs it.
   */
  subPiecesMissingSecondary(primaryProviderId: string, secondaryProviderId: string): string[] {
    const rows = this.#db
      .prepare(
        `SELECT sp.sub_piece_cid
         FROM sub_pieces sp
         WHERE sp.scope = ? AND sp.status = 'built'
           AND EXISTS (
             SELECT 1 FROM uploads u
             WHERE u.scope = sp.scope AND u.sub_piece_cid = sp.sub_piece_cid
               AND u.provider_id = ? AND u.status IN ('parked', 'add_unconfirmed', 'committed')
           )
           AND NOT EXISTS (
             SELECT 1 FROM uploads u
             WHERE u.scope = sp.scope AND u.sub_piece_cid = sp.sub_piece_cid
               AND u.provider_id = ?
           )
         ORDER BY sp.created_at, sp.rowid`
      )
      .all(this.scope, primaryProviderId, secondaryProviderId)
    return rows.map((r) => String((r as { sub_piece_cid: string }).sub_piece_cid))
  }

  /** Record a successful store(): the provider holds the bytes, GC clock starts. */
  recordUploadParked(subPieceCid: string, providerId: string, role: UploadRole, dataSetId: string | null): void {
    const now = new Date().toISOString()
    this.#db
      .prepare(
        `INSERT INTO uploads (scope, sub_piece_cid, provider_id, role, data_set_id, status, parked_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'parked', ?, ?)
         ON CONFLICT (scope, sub_piece_cid, provider_id) DO UPDATE SET
           role = excluded.role, data_set_id = excluded.data_set_id,
           status = 'parked', parked_at = excluded.parked_at,
           tx_hash = NULL, piece_id = NULL, committed_at = NULL, error = NULL,
           updated_at = excluded.updated_at`
      )
      .run(this.scope, subPieceCid, providerId, role, dataSetId, now, now)
  }

  /** Parked uploads for one provider, oldest parked first (the flush batch). */
  parkedUploads(providerId: string): UploadRow[] {
    return this.uploadsByStatus(providerId, 'parked')
  }

  /**
   * One transactional UPDATE applied to each (sub_piece_cid, provider_id) in
   * the batch. `set` is a compile-time constant fragment, never caller input.
   */
  #updateUploadsBatch(subPieceCids: string[], providerId: string, set: string, params: unknown[]): void {
    const now = new Date().toISOString()
    const stmt = this.#db.prepare(
      `UPDATE uploads SET ${set}, updated_at = ? WHERE scope = ? AND sub_piece_cid = ? AND provider_id = ?`
    )
    this.#db.exec('BEGIN')
    try {
      for (const cid of subPieceCids) stmt.run(...(params as string[]), now, this.scope, cid, providerId)
      this.#db.exec('COMMIT')
    } catch (err) {
      this.#db.exec('ROLLBACK')
      throw err
    }
  }

  /**
   * Durable breadcrumb set immediately before the addPieces attempt, so a
   * crash mid-commit is never auto-resolved into a blind re-add.
   */
  markUploadsAddUnconfirmed(subPieceCids: string[], providerId: string): void {
    this.#updateUploadsBatch(subPieceCids, providerId, `status = 'add_unconfirmed'`, [])
  }

  markUploadTxSubmitted(subPieceCids: string[], providerId: string, txHash: string): void {
    this.#updateUploadsBatch(subPieceCids, providerId, 'tx_hash = ?', [txHash])
  }

  markUploadCommitted(
    subPieceCid: string,
    providerId: string,
    info: { dataSetId: string; pieceId: string; txHash: string | null }
  ): void {
    const now = new Date().toISOString()
    this.#db
      .prepare(
        `UPDATE uploads SET status = 'committed', data_set_id = ?, piece_id = ?, tx_hash = ?,
           committed_at = ?, error = NULL, updated_at = ?
         WHERE scope = ? AND sub_piece_cid = ? AND provider_id = ?`
      )
      .run(info.dataSetId, info.pieceId, info.txHash, now, now, this.scope, subPieceCid, providerId)
  }

  /**
   * Return add_unconfirmed rows to parked after a re-verify confirmed the
   * provider still holds the bytes. Leaves parked_at untouched (the GC clock
   * started at store() time and a failed commit does not reset it) but clears
   * the stale commit coordinates: the next flush writes fresh ones, and a
   * leftover tx_hash from the failed attempt would mislead a later resume.
   */
  revertUploadsToParked(subPieceCids: string[], providerId: string): void {
    this.#updateUploadsBatch(
      subPieceCids,
      providerId,
      `status = 'parked', tx_hash = NULL, piece_id = NULL, committed_at = NULL`,
      []
    )
  }

  /** The provider garbage-collected the parked piece; the CAR must be stored again. */
  markUploadCollected(subPieceCid: string, providerId: string): void {
    this.#db
      .prepare(
        `UPDATE uploads SET status = 'collected', updated_at = ?
         WHERE scope = ? AND sub_piece_cid = ? AND provider_id = ?`
      )
      .run(new Date().toISOString(), this.scope, subPieceCid, providerId)
  }

  /**
   * Upsert, not update: a secondary whose pull fails has no uploads row yet,
   * so the failure record is the first thing written for that (piece, provider).
   */
  markUploadFailed(subPieceCid: string, providerId: string, role: UploadRole, error: string): void {
    const now = new Date().toISOString()
    this.#db
      .prepare(
        `INSERT INTO uploads (scope, sub_piece_cid, provider_id, role, status, parked_at, error, updated_at)
         VALUES (?, ?, ?, ?, 'failed', ?, ?, ?)
         ON CONFLICT (scope, sub_piece_cid, provider_id) DO UPDATE SET
           status = 'failed', error = excluded.error, updated_at = excluded.updated_at`
      )
      .run(this.scope, subPieceCid, providerId, role, now, error, now)
  }

  uploadsByStatus(providerId: string, status: UploadStatus): UploadRow[] {
    const rows = this.#db
      .prepare(
        `SELECT sub_piece_cid, provider_id, role, data_set_id, status, parked_at,
                tx_hash, piece_id, committed_at, updated_at, error
         FROM uploads WHERE scope = ? AND provider_id = ? AND status = ? ORDER BY parked_at`
      )
      .all(this.scope, providerId, status)
    return rows.map(toUploadRow)
  }

  /**
   * Sub-piece CARs safe to evict: the primary copy is committed on chain.
   * The local file exists to (re-)store the primary; secondary copies pull
   * provider-to-provider from the primary, whose possession is proven on
   * chain, so a pending or failed secondary does not hold the file hostage.
   */
  carPathsEvictable(): string[] {
    const rows = this.#db
      .prepare(
        `SELECT sp.car_path FROM sub_pieces sp
         WHERE sp.scope = ?
           AND EXISTS (
             SELECT 1 FROM uploads u
             WHERE u.scope = sp.scope AND u.sub_piece_cid = sp.sub_piece_cid
               AND u.role = 'primary' AND u.status = 'committed'
           )`
      )
      .all(this.scope)
    return rows.map((r) => (r as { car_path: string }).car_path)
  }

  /**
   * Per-provider GC-window estimate. Reads fall back to the caller's default;
   * writes only ever lower the stored value (a successful run proves nothing
   * about the window being longer).
   */
  providerWindowMs(providerId: string, defaultMs: number): number {
    const row = this.#db
      .prepare(`SELECT assumed_window_ms FROM provider_windows WHERE scope = ? AND provider_id = ?`)
      .get(this.scope, providerId) as { assumed_window_ms: number } | undefined
    return row == null ? defaultMs : Math.min(row.assumed_window_ms, defaultMs)
  }

  lowerProviderWindow(providerId: string, windowMs: number): void {
    this.#db
      .prepare(
        `INSERT INTO provider_windows (scope, provider_id, assumed_window_ms, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (scope, provider_id) DO UPDATE SET
           assumed_window_ms = MIN(provider_windows.assumed_window_ms, excluded.assumed_window_ms),
           updated_at = excluded.updated_at`
      )
      .run(this.scope, providerId, windowMs, new Date().toISOString())
  }

  close(): void {
    this.#db.close()
  }
}

function toSubPieceRow(r: unknown): SubPieceRow {
  const row = r as Record<string, unknown>
  return {
    subPieceCid: String(row.sub_piece_cid),
    assembledCarLength: Number(row.assembled_car_length),
    assembledSha256: row.assembled_sha256 == null ? null : String(row.assembled_sha256),
    targetSizeBytes: Number(row.target_size_bytes),
    carPath: row.car_path == null ? null : String(row.car_path),
    status: row.status as SubPieceStatus,
  }
}

function toUploadRow(r: unknown): UploadRow {
  const row = r as Record<string, unknown>
  return {
    subPieceCid: String(row.sub_piece_cid),
    providerId: String(row.provider_id),
    role: row.role as UploadRole,
    dataSetId: row.data_set_id == null ? null : String(row.data_set_id),
    status: row.status as UploadStatus,
    parkedAt: String(row.parked_at),
    txHash: row.tx_hash == null ? null : String(row.tx_hash),
    pieceId: row.piece_id == null ? null : String(row.piece_id),
    committedAt: row.committed_at == null ? null : String(row.committed_at),
    updatedAt: String(row.updated_at ?? row.parked_at),
    error: row.error == null ? null : String(row.error),
  }
}

function toPieceRow(r: unknown): PieceRow {
  const row = r as Record<string, unknown>
  return {
    cid: String(row.cid),
    pieceCid: row.piece_cid == null ? null : String(row.piece_cid),
    rawSize: row.raw_size == null ? null : Number(row.raw_size),
    gateway: row.gateway == null ? null : String(row.gateway),
    url: row.url == null ? null : String(row.url),
    memberCarPath: row.member_car_path == null ? null : String(row.member_car_path),
    memberSha256: row.member_sha256 == null ? null : String(row.member_sha256),
    status: row.status as PieceStatus,
    error: row.error == null ? null : String(row.error),
  }
}
