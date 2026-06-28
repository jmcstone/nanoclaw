/**
 * One-shot v1 backfill — index ~/containers/data/NanoClaw/store/messages.db
 * into the session_fts FTS5 recall index.
 *
 * Run: npx tsx scripts/backfill-session-fts.ts
 *
 * Idempotent: checks session_fts_state WHERE source='v1-backfill' and exits
 * immediately if the backfill has already completed.
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

import { openRecallDb, ensureRecallSchema } from '../src/recall/schema.js';
import { RECALL_DB_PATH } from '../src/madison-extensions.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const V1_DB_PATH = path.join(
  os.homedir(),
  'containers/data/NanoClaw/store/messages.db',
);

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
  // Open recall DB and ensure schema exists.
  const recallDb = openRecallDb(RECALL_DB_PATH);
  ensureRecallSchema(recallDb);

  // Idempotency check: if the backfill source is already recorded, bail out.
  const existing = recallDb
    .prepare<[string], { source: string; last_indexed_ts: string }>(
      'SELECT source, last_indexed_ts FROM session_fts_state WHERE source = ?',
    )
    .get(BACKFILL_SOURCE);

  if (existing) {
    console.log(
      `v1 backfill already done (last_indexed_ts=${existing.last_indexed_ts}).`,
    );
    recallDb.close();
    process.exit(0);
  }

  // Open v1 archive read-only.
  const v1Db = new Database(V1_DB_PATH, { readonly: true });

  // Prepared statements for the recall DB.
  const deleteFts = recallDb.prepare<[string]>(
    'DELETE FROM session_fts WHERE msg_id = ?',
  );
  const insertFts = recallDb.prepare<
    [string, string, string, string, string, string]
  >(
    'INSERT INTO session_fts (msg_id, session_id, agent_group, ts, role, content) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const upsertState = recallDb.prepare<[string, string]>(
    'INSERT INTO session_fts_state (source, last_indexed_ts) VALUES (?, ?) ' +
      'ON CONFLICT(source) DO UPDATE SET last_indexed_ts = excluded.last_indexed_ts',
  );

  // Fetch all v1 messages ordered by timestamp.
  const allRows = v1Db
    .prepare<[], V1Message>(
      'SELECT id, chat_jid, sender, content, timestamp FROM messages ORDER BY timestamp ASC',
    )
    .all();

  v1Db.close();

  let inserted = 0;
  let maxTs = '';
  const skippedByJid: Record<string, number> = {};

  // Wrap all inserts in a transaction for atomicity and performance.
  const runBackfill = recallDb.transaction(() => {
    for (const row of allRows) {
      const agentGroup = CHAT_JID_MAP[row.chat_jid];

      if (!agentGroup) {
        // Unknown chat_jid — skip with a warning tally.
        skippedByJid[row.chat_jid] = (skippedByJid[row.chat_jid] ?? 0) + 1;
        continue;
      }

      const role = deriveRole(row.sender);
      const content = row.content ?? '';

      // Idempotent: remove any existing index entry for this msg_id first.
      deleteFts.run(row.id);
      insertFts.run(row.id, 'v1', agentGroup, row.timestamp, role, content);

      inserted++;
      if (row.timestamp > maxTs) maxTs = row.timestamp;
    }

    // Record the backfill watermark only if we actually indexed something.
    if (inserted > 0) {
      upsertState.run(BACKFILL_SOURCE, maxTs);
    }
  });

  runBackfill();

  recallDb.close();

  // ─── Summary ────────────────────────────────────────────────────────────
  console.log(`v1 backfill complete.`);
  console.log(`  rows inserted : ${inserted}`);
  console.log(`  max timestamp : ${maxTs || '(none)'}`);

  const skippedJids = Object.keys(skippedByJid);
  if (skippedJids.length > 0) {
    console.log(`  skipped (unmapped chat_jid):`);
    for (const jid of skippedJids) {
      console.log(`    ${jid}: ${skippedByJid[jid]} rows`);
    }
  } else {
    console.log(`  skipped      : 0 (all chat_jids mapped)`);
  }
}

main();
