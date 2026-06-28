/**
 * One-shot backfill — index the assistant side of pre-cutover v1 SDK transcripts
 * into per-group session_fts FTS5 recall DBs.
 *
 * WHY: The earlier backfill (backfill-session-fts.ts) indexed messages.db, which
 * only stores inbound messages (is_from_me=0 for every row). Madison's own
 * pre-cutover responses are recorded in the SDK transcript .jsonl files as
 * type:"assistant" events. This script fills that gap by indexing the assistant
 * side only — avoiding duplication with messages.db (which covered user/email).
 *
 * SOURCE: ~/containers/data/NanoClaw/data/sessions/<folder>/.claude/projects/-workspace-group/
 *         for each folder ∈ {telegram_avp, telegram_avp_outreach, telegram_inbox,
 *                             telegram_main, telegram_trading}
 *
 * ─── JSONL LINE SHAPE (verified 2026-06-28) ────────────────────────────────
 *   Each type:"assistant" line is one streaming event from the Claude SDK.
 *   Multiple events share the same message.id (one API response = one turn).
 *   Fields used:
 *     .type            string  — filter: only process lines where type === "assistant"
 *     .uuid            string  — per-event unique ID (not used for indexing)
 *     .timestamp       string  — ISO-8601, e.g. "2026-06-10T06:36:19.771Z"
 *     .sessionId       string  — matches the filename without .jsonl
 *     .message.id      string  — Anthropic API message ID (groups streaming events)
 *     .message.content array   — [{type:"text",text:string} | {type:"tool_use",...} |
 *                                 {type:"thinking",...}] — we collect only type:"text"
 *     .message.stop_reason  string|null — null while streaming; "end_turn" or "tool_use"
 *                                         on the final event of a turn
 *
 *   Text blocks can appear in ANY event for a message.id (including intermediate
 *   events, not just the stop_reason event). We group by message.id and collect
 *   all text blocks across all events to reconstruct the full response text.
 *
 * ─── IDEMPOTENCY ────────────────────────────────────────────────────────────
 *   msg_id = 'v1tx:<message.id>' — namespaced so it cannot collide with
 *   messages.db ids. delete-before-insert per msg_id makes re-runs safe.
 *   Per-group watermark stored in session_fts_state (source='v1-transcripts').
 *   On a re-run the delete-before-insert already handles duplicates, so the
 *   watermark check is NOT used as a skip gate — it only records progress.
 *
 * Run: npx tsx scripts/backfill-v1-transcripts.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  openRecallDb,
  ensureRecallSchema,
  SQL_FTS_DELETE,
  SQL_FTS_INSERT,
  SQL_STATE_UPSERT,
} from '../src/recall/schema.js';
import { recallDbPathForGroup } from '../src/madison-extensions.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const V1_SESSIONS_BASE = path.join(
  os.homedir(),
  'containers/data/NanoClaw/data/sessions',
);

/** Sub-path within each group's session folder where .jsonl transcripts live. */
const TRANSCRIPT_SUBDIR = path.join('.claude', 'projects', '-workspace-group');

const BACKFILL_SOURCE = 'v1-transcripts';

/** All 5 group folders that have v1 session transcripts. */
const GROUPS = [
  'telegram_avp',
  'telegram_avp_outreach',
  'telegram_inbox',
  'telegram_main',
  'telegram_trading',
] as const;

// ─── Types ──────────────────────────────────────────────────────────────────

interface ContentBlock {
  type: string;
  text?: string;
}

interface TranscriptMessage {
  id?: string;
  content?: ContentBlock[];
  stop_reason?: string | null;
}

interface TranscriptLine {
  type?: string;
  uuid?: string;
  timestamp?: string;
  message?: TranscriptMessage;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Return all *.jsonl files that are DIRECT children of `dir` (non-recursive).
 * We skip subdirectories (which contain tool-results, not session transcripts).
 * Returns [] if the directory does not exist.
 */
function listJsonlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => path.join(dir, name));
}

/**
 * Parse all type:"assistant" lines from a JSONL transcript file.
 * Groups them by message.id (Anthropic API message ID), collecting all streaming
 * events that belong to the same turn.
 *
 * Returns: Map<messageId, {texts: string[], maxTs: string}>.
 * Lines that are missing message.id or have a null/empty message are skipped.
 */
function parseTranscript(
  filePath: string,
): Map<string, { texts: string[]; maxTs: string }> {
  const byMessageId = new Map<string, { texts: string[]; maxTs: string }>();
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return byMessageId; // unreadable file — skip silently
  }

  for (const rawLine of raw.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    let obj: TranscriptLine;
    try {
      obj = JSON.parse(trimmed) as TranscriptLine;
    } catch {
      continue; // malformed JSON — skip
    }

    if (obj.type !== 'assistant') continue;

    const mid = obj.message?.id;
    if (!mid) continue;

    const ts = obj.timestamp ?? '';

    let entry = byMessageId.get(mid);
    if (!entry) {
      entry = { texts: [], maxTs: '' };
      byMessageId.set(mid, entry);
    }

    // Collect text blocks from this streaming event.
    for (const block of obj.message?.content ?? []) {
      if (block.type === 'text' && block.text?.trim()) {
        entry.texts.push(block.text.trim());
      }
    }

    // Track latest timestamp across all events for this message.id.
    if (ts > entry.maxTs) entry.maxTs = ts;
  }

  return byMessageId;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main(): void {
  for (const folder of GROUPS) {
    const transcriptDir = path.join(V1_SESSIONS_BASE, folder, TRANSCRIPT_SUBDIR);
    const jsonlFiles = listJsonlFiles(transcriptDir);

    const dbPath = recallDbPathForGroup(folder);
    const recallDb = openRecallDb(dbPath);
    ensureRecallSchema(recallDb);

    const deleteFts = recallDb.prepare<[string]>(SQL_FTS_DELETE);
    const insertFts = recallDb.prepare<
      [string, string, string, string, string, string]
    >(SQL_FTS_INSERT);
    const upsertState = recallDb.prepare<[string, string]>(SQL_STATE_UPSERT);

    let totalAssistant = 0;
    let maxTs = '';

    for (const filePath of jsonlFiles) {
      const sessionId = path.basename(filePath, '.jsonl');
      const byMessageId = parseTranscript(filePath);

      // Wrap per-file writes in a transaction for atomicity and speed.
      const runFile = recallDb.transaction(() => {
        for (const [messageId, { texts, maxTs: msgTs }] of byMessageId) {
          // Skip tool-only / thinking-only turns — no text to index.
          if (texts.length === 0) continue;
          if (!msgTs) continue;

          const content = texts.join('\n\n');
          const msgId = `v1tx:${messageId}`;

          // Idempotent: remove any existing entry for this msg_id before re-inserting.
          deleteFts.run(msgId);
          insertFts.run(msgId, sessionId, folder, msgTs, 'assistant', content);

          totalAssistant++;
          if (msgTs > maxTs) maxTs = msgTs;
        }
      });

      runFile();
    }

    // Record the v1-transcripts watermark for this group.
    if (maxTs) {
      upsertState.run(BACKFILL_SOURCE, maxTs);
    }

    recallDb.close();

    console.log(
      `${folder}: ${totalAssistant} assistant rows indexed` +
        ` from ${jsonlFiles.length} transcripts`,
    );
  }

  console.log('\nBackfill complete.');
}

main();
