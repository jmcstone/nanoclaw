/**
 * Self-improve DB schema: distiller watermark, proposal keys, and helpfulness ledger.
 *
 * Single host-side DB (DISC-6) — never mounted into containers.
 * Host distiller is the sole writer; reads happen from the nightly cron pass.
 * WAL mode matches the recall DB pattern (concurrent host readers safe).
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

/** Busy-timeout for the self-improve DB (mirrors recall DB). */
export const SELF_IMPROVE_DB_BUSY_TIMEOUT_MS = 5000;

/**
 * SQL constants for the distiller write path.
 * Exported here (single source of truth) so the online distiller and
 * nightly cron always agree on column order and conflict clauses.
 */

/** Upsert the per-session distiller watermark (advance rowid cursors). */
export const SQL_WATERMARK_UPSERT =
  'INSERT INTO distiller_watermark (session_id, last_rowid_in, last_rowid_out) VALUES (?, ?, ?)' +
  ' ON CONFLICT(session_id) DO UPDATE SET' +
  '   last_rowid_in  = excluded.last_rowid_in,' +
  '   last_rowid_out = excluded.last_rowid_out';

/** Insert or update a proposal key row (session_count accumulates). */
export const SQL_PROPOSAL_KEY_UPSERT =
  'INSERT INTO proposal_keys (key, tombstone, tombstone_reason, proposal_path, session_count, created_at, updated_at)' +
  ' VALUES (?, ?, ?, ?, ?, ?, ?)' +
  ' ON CONFLICT(key) DO UPDATE SET' +
  '   tombstone        = excluded.tombstone,' +
  '   tombstone_reason = excluded.tombstone_reason,' +
  '   proposal_path    = COALESCE(excluded.proposal_path, proposal_path),' +
  '   session_count    = session_count + excluded.session_count,' +
  '   updated_at       = excluded.updated_at';

/** Append a helpfulness event row. */
export const SQL_HELPFULNESS_INSERT = 'INSERT INTO helpfulness_events (key, event, session_id, ts) VALUES (?, ?, ?, ?)';

/** Open (or create) the self-improve DB at the given path. Sets WAL and busy_timeout. */
export function openSelfImproveDb(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma(`busy_timeout = ${SELF_IMPROVE_DB_BUSY_TIMEOUT_MS}`);
  return db;
}

/**
 * Idempotent: create the self-improve tables if absent.
 *
 * distiller_watermark — per-session read-cursor for the online distiller pass.
 *   session_id      — PK; one row per container lifetime
 *   last_rowid_in   — highest inbound msg rowid already distilled
 *   last_rowid_out  — highest outbound msg rowid already distilled
 *
 * proposal_keys — canonical kebab keys for distilled items (SI-7 dedup).
 *   key             — PK; stable slug for a fact or skill candidate
 *   tombstone       — 1 = rejected; distiller skips this key on re-discovery
 *   tombstone_reason — human note on why it was rejected
 *   proposal_path   — path to the current draft file under proposals/
 *   session_count   — number of sessions that have observed this item
 *   created_at / updated_at — ISO-8601 timestamps
 *
 * helpfulness_events — the per-item evidence ledger (SI-5).
 *   event ∈ corroborated | used | corrected | recall-hit | stale
 *   Written at session-end (warm pass) by the online distiller.
 */
export function ensureSelfImproveSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS distiller_watermark (
      session_id      TEXT    PRIMARY KEY,
      last_rowid_in   INTEGER NOT NULL DEFAULT 0,
      last_rowid_out  INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS proposal_keys (
      key              TEXT    PRIMARY KEY,
      tombstone        INTEGER NOT NULL DEFAULT 0,
      tombstone_reason TEXT,
      proposal_path    TEXT,
      session_count    INTEGER NOT NULL DEFAULT 0,
      created_at       TEXT,
      updated_at       TEXT
    );

    CREATE TABLE IF NOT EXISTS helpfulness_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      key        TEXT    NOT NULL,
      event      TEXT    NOT NULL CHECK(event IN ('corroborated','used','corrected','recall-hit','stale')),
      session_id TEXT    NOT NULL,
      ts         TEXT    NOT NULL
    );
  `);
}
