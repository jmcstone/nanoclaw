/**
 * Session indexer — periodic FTS5 indexing of inbound + outbound session DBs.
 *
 * Runs every 30 s and fires once immediately on start. For each agent group
 * found under sessionsBaseDir(), opens that group's own recall DB (per-group
 * sharding — Option B), advances per-source monotonic rowid cursors, and
 * writes new rows into the group's FTS5 index.
 *
 * Design decisions implemented here:
 *   D5  — host-side periodic tick; inbound messages_in → role user/email,
 *          outbound messages_out → role assistant; getAgentGroup() maps ids to
 *          folder names for scoping.
 *   D6  — idempotent on msg_id: DELETE FROM session_fts WHERE msg_id=? before
 *          each INSERT, so re-indexing the same row never duplicates. Combined
 *          with a monotonic rowid cursor so boundaries are never re-processed.
 *   D2′ — per-group recall DB sharding (Option B): each agent_group writes to
 *          its own <RECALL_DB_DIR>/<folder>.db, opened and closed per tick.
 *          The agent_group column in session_fts is now redundant (each DB is
 *          single-group) but kept harmless — folder name is still written.
 *
 * The indexer is a reader of session DBs — it never writes inbound.db or
 * outbound.db. It opens them read-only and holds the connection only for the
 * duration of one source's drain loop, then closes it.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { recallDbPathForGroup } from './madison-extensions.js';
import { openRecallDb, ensureRecallSchema, SQL_FTS_DELETE, SQL_FTS_INSERT, SQL_STATE_UPSERT } from './recall/schema.js';
import { sessionsBaseDir, inboundDbPath, outboundDbPath } from './session-manager.js';
import { getAgentGroup } from './db/agent-groups.js';
import { log } from './log.js';

const INTERVAL_MS = 30_000;
/** Maximum rows fetched per source per batch iteration. */
const BATCH_SIZE = 500;
/**
 * Busy-timeout for opening source session DBs read-only.
 * Shorter than RECALL_DB_BUSY_TIMEOUT_MS — source DBs are read-only here and
 * we prefer a fast bail-and-skip over accumulating waiting threads.
 */
const SOURCE_DB_BUSY_TIMEOUT_MS = 3000;

let intervalId: ReturnType<typeof setInterval> | null = null;

/** Start the periodic session indexer. Fires once immediately, then every 30 s. */
export function startSessionIndexer(): void {
  if (intervalId !== null) return;
  runIndexerTick();
  intervalId = setInterval(runIndexerTick, INTERVAL_MS);
  log.info('Session indexer started', { intervalMs: INTERVAL_MS });
}

/** Stop the periodic session indexer. */
export function stopSessionIndexer(): void {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
    log.info('Session indexer stopped');
  }
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

function runIndexerTick(): void {
  try {
    indexAllSessions();
  } catch (err) {
    log.error('Session indexer tick failed', { err });
  }
}

// ---------------------------------------------------------------------------
// Session walk
// ---------------------------------------------------------------------------

function indexAllSessions(): void {
  const baseDir = sessionsBaseDir();

  let agentGroupEntries: string[];
  try {
    agentGroupEntries = fs.readdirSync(baseDir);
  } catch {
    // Base dir may not exist yet on fresh installs; not an error.
    log.debug('Session indexer: sessions dir not found or unreadable', { baseDir });
    return;
  }

  for (const agentGroupId of agentGroupEntries) {
    const agentGroupPath = path.join(baseDir, agentGroupId);

    // Skip non-directories (files, symlinks, etc.)
    try {
      if (!fs.lstatSync(agentGroupPath).isDirectory()) continue;
    } catch {
      continue;
    }

    let sessionEntries: string[];
    try {
      sessionEntries = fs.readdirSync(agentGroupPath);
    } catch (err) {
      log.debug('Session indexer: could not list agent group dir', { agentGroupId, err });
      continue;
    }

    // Resolve the human-readable folder name for per-group DB sharding.
    const agentFolder = getAgentGroup(agentGroupId)?.folder ?? agentGroupId;

    // Open this group's own recall DB for the duration of the tick iteration.
    // openRecallDb creates the parent dir (RECALL_DB_DIR) if absent.
    let recallDb: Database.Database | null = null;
    try {
      recallDb = openRecallDb(recallDbPathForGroup(agentFolder));
      ensureRecallSchema(recallDb);

      for (const sessionId of sessionEntries) {
        const sessionPath = path.join(agentGroupPath, sessionId);

        // Skip non-directories inside the agent group dir.
        try {
          if (!fs.lstatSync(sessionPath).isDirectory()) continue;
        } catch {
          continue;
        }

        try {
          indexSession(recallDb, agentGroupId, sessionId, agentFolder);
        } catch (err) {
          // A single locked or corrupt session DB must not abort the whole tick.
          log.warn('Session indexer: skipping session due to error', { agentGroupId, sessionId, err });
        }
      }
    } catch (err) {
      log.error('Session indexer: error processing agent group', { agentGroupId, agentFolder, err });
    } finally {
      recallDb?.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Per-session indexing
// ---------------------------------------------------------------------------

function indexSession(recallDb: Database.Database, agentGroupId: string, sessionId: string, agentFolder: string): void {
  const inbound = inboundDbPath(agentGroupId, sessionId);
  if (fs.existsSync(inbound)) {
    indexSource(recallDb, {
      dbPath: inbound,
      watermarkKey: `inbound:${agentGroupId}:${sessionId}`,
      sessionId,
      agentFolder,
      table: 'messages_in',
      // mailroom / agentmail prefixes on the id indicate email-origin messages.
      roleForId: (id) => (id.startsWith('mailroom:') || id.startsWith('agentmail:') ? 'email' : 'user'),
    });
  }

  const outbound = outboundDbPath(agentGroupId, sessionId);
  if (fs.existsSync(outbound)) {
    indexSource(recallDb, {
      dbPath: outbound,
      watermarkKey: `outbound:${agentGroupId}:${sessionId}`,
      sessionId,
      agentFolder,
      table: 'messages_out',
      roleForId: () => 'assistant',
    });
  }
}

// ---------------------------------------------------------------------------
// Per-source drain loop
// ---------------------------------------------------------------------------

interface IndexSourceOpts {
  dbPath: string;
  /** session_fts_state primary key for this source. */
  watermarkKey: string;
  sessionId: string;
  agentFolder: string;
  table: 'messages_in' | 'messages_out';
  roleForId: (id: string) => string;
}

type SessionRow = { rowid: number; id: string; timestamp: string; content: string };

function indexSource(recallDb: Database.Database, opts: IndexSourceOpts): void {
  const { dbPath, watermarkKey, sessionId, agentFolder, table, roleForId } = opts;

  let sourceDb: Database.Database | null = null;
  try {
    sourceDb = new Database(dbPath, { readonly: true });
    sourceDb.pragma(`busy_timeout = ${SOURCE_DB_BUSY_TIMEOUT_MS}`);
  } catch (err) {
    // Guard: if new Database() succeeded but pragma() threw, sourceDb is
    // non-null — close it before returning to avoid a handle leak.
    sourceDb?.close();
    log.debug('Session indexer: could not open session DB read-only', { dbPath, err });
    return;
  }

  try {
    // Load the per-source rowid cursor (stored as TEXT in last_indexed_ts).
    const stateRow = recallDb
      .prepare('SELECT last_indexed_ts FROM session_fts_state WHERE source = ?')
      .get(watermarkKey) as { last_indexed_ts: string } | undefined;
    let cursor = stateRow ? parseInt(stateRow.last_indexed_ts, 10) : 0;
    if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;

    const selectRows = sourceDb.prepare(
      `SELECT rowid, id, timestamp, content FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ${BATCH_SIZE}`,
    );

    const deleteFromFts = recallDb.prepare(SQL_FTS_DELETE);
    const insertIntoFts = recallDb.prepare(SQL_FTS_INSERT);
    const upsertWatermark = recallDb.prepare(SQL_STATE_UPSERT);

    /**
     * Process one batch atomically: DELETE+INSERT each row and advance the
     * watermark in the same transaction so a mid-batch crash leaves the index
     * consistent (re-processed rows hit DELETE idempotently on the next tick).
     */
    const processBatch = recallDb.transaction((rows: SessionRow[], prevCursor: number): number => {
      let maxRowid = prevCursor;
      for (const row of rows) {
        const text = extractText(row.content);
        if (text) {
          // D6 idempotency: remove any prior index entry for this msg_id before
          // re-inserting so the same message is never duplicated on re-index.
          deleteFromFts.run(row.id);
          insertIntoFts.run(row.id, sessionId, agentFolder, row.timestamp, roleForId(row.id), text);
        }
        if (row.rowid > maxRowid) maxRowid = row.rowid;
      }
      if (maxRowid > prevCursor) {
        upsertWatermark.run(watermarkKey, String(maxRowid));
      }
      return maxRowid;
    });

    // Drain: keep fetching until fewer than BATCH_SIZE rows are returned.
    for (;;) {
      const rows = selectRows.all(cursor) as SessionRow[];
      if (rows.length === 0) break;

      cursor = processBatch(rows, cursor);

      if (rows.length < BATCH_SIZE) break;
    }
  } finally {
    sourceDb.close();
  }
}

// ---------------------------------------------------------------------------
// Content extraction
// ---------------------------------------------------------------------------

/**
 * Extract indexable text from a message content JSON blob.
 *
 * Both messages_in and messages_out store `content` as a JSON string.
 * The expected shape for user/email messages is `{ text: string, ... }`;
 * agent (outbound) messages may use `{ text: string }` or `{ markdown: string }`.
 * Falls back gracefully if the shape differs or JSON parse fails.
 */
function extractText(contentStr: string): string {
  try {
    const parsed = JSON.parse(contentStr) as Record<string, unknown>;
    if (typeof parsed.text === 'string' && parsed.text) return parsed.text;
    if (typeof parsed.markdown === 'string' && parsed.markdown) return parsed.markdown;
    if (typeof parsed.content === 'string' && parsed.content) return parsed.content;
  } catch {
    // Not JSON — index the raw string as-is if it's non-empty.
    const trimmed = contentStr.trim();
    if (trimmed) return trimmed;
  }
  return '';
}
