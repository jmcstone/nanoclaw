/**
 * One-shot v1 backfill — index ~/containers/data/NanoClaw/store/messages.db
 * into per-group session_fts FTS5 recall DBs (Option B).
 *
 * Each chat_jid's rows go into its group's own DB at
 * recallDbPathForGroup(folder). One DB per agent_group folder is opened,
 * written, and closed independently.
 *
 * Run: npx tsx scripts/backfill-session-fts.ts
 *
 * Idempotent (per-group): each group's DB is checked independently for the
 * 'v1-backfill' source in session_fts_state. A group already backfilled is
 * skipped; a new group still runs.
 *
 * ─── Real v1 schema (verified 2026-06-28 via PRAGMA table_info) ──────────
 *   messages(
 *     id            TEXT  PRIMARY KEY,
 *     chat_jid      TEXT,
 *     sender        TEXT,    -- Telegram numeric user ID  OR  email address
 *     sender_name   TEXT,    -- display name (not used for indexing)
 *     content       TEXT,    -- plain text (never JSON in this archive)
 *     timestamp     TEXT,    -- ISO-8601 UTC, e.g. "2026-04-20T20:00:19.000Z"
 *     is_from_me    INTEGER, -- always 0: only inbound messages stored in v1
 *     is_bot_message INTEGER DEFAULT 0
 *   )
 *   NOTE: design doc D7 listed (id,chat_jid,sender,content,timestamp) —
 *   the real schema has three additional columns (sender_name, is_from_me,
 *   is_bot_message).  is_from_me is 0 for every row, so no assistant
 *   responses are present in the v1 archive.
 *
 * ─── chat_jid → agent_group folder map ───────────────────────────────────
 *   Derived from v1 registered_groups table AND verified against v2
 *   agent_groups table (2026-06-28).  All 5 chat_jids are fully mapped;
 *   no rows are skipped due to unknown chat_jid.
 *
 *   chat_jid              folder                  message count
 *   ───────────────────────────────────────────────────────────
 *   tg:-5273779685        telegram_inbox          3 359
 *   tg:-1003800188692     telegram_avp            1 232
 *   tg:6847601234         telegram_main             353
 *   tg:-5152405016        telegram_avp_outreach     177
 *   tg:-5211322204        telegram_trading             9
 *                                         total:  5 130
 *
 * ─── Role derivation ─────────────────────────────────────────────────────
 *   All v1 rows are inbound (is_from_me = 0 for every row).
 *   sender contains '@'  →  role = 'email'
 *   otherwise            →  role = 'user'
 */

import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

import {
  openRecallDb,
  ensureRecallSchema,
  SQL_FTS_DELETE,
  SQL_FTS_INSERT,
  SQL_STATE_UPSERT,
} from '../src/recall/schema.js';
import { recallDbPathForGroup } from '../src/madison-extensions.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const V1_DB_PATH = path.join(os.homedir(), 'containers/data/NanoClaw/store/messages.db');

const BACKFILL_SOURCE = 'v1-backfill';

/**
 * Hard-coded chat_jid → agent_group folder mapping.
 * Derived from v1 registered_groups + confirmed in v2 agent_groups.
 * Any chat_jid NOT in this map is skipped with a warning.
 */
const CHAT_JID_MAP: Record<string, string> = {
  'tg:-5273779685': 'telegram_inbox',
  'tg:-1003800188692': 'telegram_avp',
  'tg:6847601234': 'telegram_main',
  'tg:-5152405016': 'telegram_avp_outreach',
  'tg:-5211322204': 'telegram_trading',
};

// ─── Types ──────────────────────────────────────────────────────────────────

interface V1Message {
  id: string;
  chat_jid: string;
  sender: string;
  content: string;
  timestamp: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Derive the session_fts role from the v1 sender field.
 * All v1 rows are inbound (is_from_me=0), so no 'assistant' role exists.
 */
function deriveRole(sender: string): 'user' | 'email' {
  return sender.includes('@') ? 'email' : 'user';
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main(): void {
  // Open v1 archive read-only and fetch all rows upfront.
  const v1Db = new Database(V1_DB_PATH, { readonly: true });
  const allRows = v1Db
    .prepare<[], V1Message>('SELECT id, chat_jid, sender, content, timestamp FROM messages ORDER BY timestamp ASC')
    .all();
  v1Db.close();

  // Partition rows by folder (per CHAT_JID_MAP).
  const rowsByFolder = new Map<string, V1Message[]>();
  const skippedByJid: Record<string, number> = {};

  for (const row of allRows) {
    const folder = CHAT_JID_MAP[row.chat_jid];
    if (!folder) {
      skippedByJid[row.chat_jid] = (skippedByJid[row.chat_jid] ?? 0) + 1;
      continue;
    }
    const existing = rowsByFolder.get(folder);
    if (existing) {
      existing.push(row);
    } else {
      rowsByFolder.set(folder, [row]);
    }
  }

  // Per-group summary accumulators.
  const insertedByFolder: Record<string, number> = {};
  const alreadyDoneByFolder: Record<string, string> = {};

  // Process each group independently — open, check, write, close.
  for (const [folder, rows] of rowsByFolder) {
    const dbPath = recallDbPathForGroup(folder);
    const recallDb = openRecallDb(dbPath);
    ensureRecallSchema(recallDb);

    // Per-group idempotency: if this group's DB already has the backfill
    // marker, skip it without touching any data.
    const existing = recallDb
      .prepare<
        [string],
        { source: string; last_indexed_ts: string }
      >('SELECT source, last_indexed_ts FROM session_fts_state WHERE source = ?')
      .get(BACKFILL_SOURCE);

    if (existing) {
      alreadyDoneByFolder[folder] = existing.last_indexed_ts;
      recallDb.close();
      continue;
    }

    // Prepared statements for this group's DB — SQL from schema.ts (single source of truth).
    const deleteFts = recallDb.prepare<[string]>(SQL_FTS_DELETE);
    const insertFts = recallDb.prepare<[string, string, string, string, string, string]>(SQL_FTS_INSERT);
    const upsertState = recallDb.prepare<[string, string]>(SQL_STATE_UPSERT);

    let inserted = 0;
    let maxTs = '';

    // Wrap all inserts in a transaction for atomicity and performance.
    const runBackfill = recallDb.transaction(() => {
      for (const row of rows) {
        const role = deriveRole(row.sender);
        const content = row.content ?? '';

        // Idempotent: remove any existing index entry for this msg_id first.
        deleteFts.run(row.id);
        insertFts.run(row.id, 'v1', folder, row.timestamp, role, content);

        inserted++;
        if (row.timestamp > maxTs) maxTs = row.timestamp;
      }

      // Record the backfill watermark in this group's DB.
      if (inserted > 0) {
        upsertState.run(BACKFILL_SOURCE, maxTs);
      }
    });

    runBackfill();
    recallDb.close();

    insertedByFolder[folder] = inserted;
  }

  // ─── Summary ────────────────────────────────────────────────────────────
  console.log('v1 backfill complete.\n');
  console.log('Per-group results:');

  for (const [folder, count] of Object.entries(insertedByFolder)) {
    console.log(`  ${folder}: ${count} rows inserted`);
  }
  for (const [folder, ts] of Object.entries(alreadyDoneByFolder)) {
    console.log(`  ${folder}: already backfilled (last_indexed_ts=${ts}) — skipped`);
  }

  const skippedJids = Object.keys(skippedByJid);
  if (skippedJids.length > 0) {
    console.log('\nSkipped (unmapped chat_jid):');
    for (const jid of skippedJids) {
      console.log(`  ${jid}: ${skippedByJid[jid]} rows`);
    }
  } else {
    console.log('\nSkipped (unmapped chat_jid): 0 (all chat_jids mapped)');
  }
}

main();
