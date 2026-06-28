/**
 * Tombstone and session-count helpers for the `proposal_keys` table (SI-7).
 *
 * All functions accept an already-open Database.Database — the caller is
 * responsible for open/close (mirrors how recall schema consumers work).
 *
 * No imports from config.ts or madison-extensions; no side effects.
 */
import type Database from 'better-sqlite3';

/**
 * Returns true if a `proposal_keys` row exists with tombstone=1.
 * False if the row is absent or not tombstoned.
 */
export function checkTombstone(db: Database.Database, key: string): boolean {
  const row = db.prepare('SELECT tombstone FROM proposal_keys WHERE key = ?').get(key) as
    | { tombstone: number }
    | undefined;
  return row !== undefined && row.tombstone === 1;
}

/**
 * Mark a key as rejected: set tombstone=1 and record the reason.
 * Inserts the row if it does not exist.
 * Does not touch session_count.
 */
export function recordTombstone(db: Database.Database, key: string, reason: string): void {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO proposal_keys (key, tombstone, tombstone_reason, proposal_path, session_count, created_at, updated_at)' +
      ' VALUES (?, 1, ?, NULL, 0, ?, ?)' +
      ' ON CONFLICT(key) DO UPDATE SET' +
      '   tombstone        = 1,' +
      '   tombstone_reason = excluded.tombstone_reason,' +
      '   updated_at       = excluded.updated_at',
  ).run(key, reason, now, now);
}

/**
 * Insert-or-update a proposal key row with the given proposal_path.
 * Sets created_at on first insert; always updates proposal_path and updated_at.
 * Does NOT clobber session_count or tombstone.
 */
export function upsertProposalKey(db: Database.Database, key: string, proposalPath: string): void {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO proposal_keys (key, tombstone, tombstone_reason, proposal_path, session_count, created_at, updated_at)' +
      ' VALUES (?, 0, NULL, ?, 0, ?, ?)' +
      ' ON CONFLICT(key) DO UPDATE SET' +
      '   proposal_path = excluded.proposal_path,' +
      '   updated_at    = excluded.updated_at',
  ).run(key, proposalPath, now, now);
}

/**
 * Increment session_count by 1 for the given key.
 * Inserts the row with count=1 if it does not exist.
 * Always updates updated_at.
 */
export function incrementSessionCount(db: Database.Database, key: string): void {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO proposal_keys (key, tombstone, tombstone_reason, proposal_path, session_count, created_at, updated_at)' +
      ' VALUES (?, 0, NULL, NULL, 1, ?, ?)' +
      ' ON CONFLICT(key) DO UPDATE SET' +
      '   session_count = session_count + 1,' +
      '   updated_at    = excluded.updated_at',
  ).run(key, now, now);
}

/**
 * Return the current session_count for the given key.
 * Returns 0 if the row does not exist.
 */
export function getSessionCount(db: Database.Database, key: string): number {
  const row = db.prepare('SELECT session_count FROM proposal_keys WHERE key = ?').get(key) as
    | { session_count: number }
    | undefined;
  return row?.session_count ?? 0;
}
