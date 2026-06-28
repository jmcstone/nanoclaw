/**
 * Recall DB schema: FTS5 session index + watermark table.
 *
 * Separate DB file from v2.db — the index is derived (rebuildable from
 * session transcripts) and must sit at RECALL_DB_PATH on btrfs.
 * Single host writer (the indexer) + concurrent host reads (MCP handler)
 * → WAL is correct here.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

/**
 * Busy-timeout for the recall DB writer (indexer / backfill).
 * Higher than the source-DB timeout because the writer holds write locks
 * and should retry longer before giving up.
 */
export const RECALL_DB_BUSY_TIMEOUT_MS = 5000;

/**
 * Prepared-statement SQL strings for the FTS5 write path.
 * Exported from schema.ts (the single source of truth for the FTS5 schema)
 * so the indexer and backfill always stay in sync with the column order.
 */
export const SQL_FTS_DELETE = 'DELETE FROM session_fts WHERE msg_id = ?';
export const SQL_FTS_INSERT =
  'INSERT INTO session_fts (msg_id, session_id, agent_group, ts, role, content) VALUES (?, ?, ?, ?, ?, ?)';
export const SQL_STATE_UPSERT =
  'INSERT INTO session_fts_state (source, last_indexed_ts) VALUES (?, ?)' +
  ' ON CONFLICT(source) DO UPDATE SET last_indexed_ts = excluded.last_indexed_ts';

/** Open (or create) the recall DB at the given path. Sets WAL and busy_timeout. */
export function openRecallDb(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma(`busy_timeout = ${RECALL_DB_BUSY_TIMEOUT_MS}`);
  return db;
}

/**
 * Idempotent: create the FTS5 session index and watermark table if absent.
 *
 * session_fts columns (exact order — UNINDEXED flags per design D4):
 *   msg_id       — row identity, not indexed (lookup via state watermark)
 *   session_id   — not indexed (scoped via agent_group MATCH)
 *   agent_group  — indexed: primary scoping key for per-group recall
 *   ts           — not indexed (carried for display / citation)
 *   role         — indexed: 'user' | 'assistant' | 'email'
 *   content      — indexed: the full text
 *
 * session_fts_state tracks the per-source indexing watermark so the
 * indexer can advance incrementally (keyed 'inbound:<session>' /
 * 'outbound:<session>') and the v1 backfill can record its own cursor.
 */
export function ensureRecallSchema(db: Database.Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
      msg_id UNINDEXED, session_id UNINDEXED,
      agent_group,
      ts UNINDEXED, role,
      content,
      tokenize='porter unicode61'
    );

    CREATE TABLE IF NOT EXISTS session_fts_state (
      source          TEXT PRIMARY KEY,
      last_indexed_ts TEXT NOT NULL
    );
  `);
}
