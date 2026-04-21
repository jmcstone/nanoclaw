// Vendored from src/inbox-store/queries.ts — keep in sync until Phase 2 shared package.
// Watermark resolution is inlined here (no dependency on watermarks.ts).

import {
  InboxMessage,
  InboxThread,
  RecentArgs,
  RecentResult,
  SearchArgs,
  SearchResult,
  ThreadArgs,
  ThreadResult,
} from './types.js';
import { getInboxDb } from './db.js';

export const DEFAULT_COLD_START_LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24h

export function getColdStartLookbackMs(): number {
  const raw = process.env.INBOX_COLD_START_LOOKBACK_MS;
  if (!raw) return DEFAULT_COLD_START_LOOKBACK_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_COLD_START_LOOKBACK_MS;
  }
  return parsed;
}

function rowToMessage(row: unknown): InboxMessage {
  return row as InboxMessage;
}

function rowToThread(row: unknown): InboxThread {
  return row as InboxThread;
}

function getStoredWatermark(account_id: string): string | null {
  const row = getInboxDb()
    .prepare('SELECT watermark_value FROM watermarks WHERE account_id = ?')
    .get(account_id) as { watermark_value: string } | undefined;
  return row?.watermark_value ?? null;
}

export function searchMessages(args: SearchArgs): SearchResult {
  const db = getInboxDb();
  const limit = Math.min(args.limit ?? 20, 100);

  let rows: unknown[];
  if (args.source) {
    rows = db
      .prepare(
        `SELECT m.*
         FROM messages_fts fts
         INNER JOIN messages m ON m.message_id = fts.message_id
         WHERE messages_fts MATCH ?
           AND m.source = ?
         ORDER BY m.received_at DESC
         LIMIT ?`,
      )
      .all(args.query, args.source, limit);
  } else {
    rows = db
      .prepare(
        `SELECT m.*
         FROM messages_fts fts
         INNER JOIN messages m ON m.message_id = fts.message_id
         WHERE messages_fts MATCH ?
         ORDER BY m.received_at DESC
         LIMIT ?`,
      )
      .all(args.query, limit);
  }

  return { matches: rows.map(rowToMessage) };
}

export function getThread(args: ThreadArgs): ThreadResult | null {
  const db = getInboxDb();

  const threadRow = db
    .prepare(`SELECT * FROM threads WHERE thread_id = ?`)
    .get(args.thread_id);

  if (!threadRow) return null;

  const messageRows = db
    .prepare(
      `SELECT * FROM messages WHERE thread_id = ? ORDER BY received_at ASC`,
    )
    .all(args.thread_id);

  return {
    thread: rowToThread(threadRow),
    messages: messageRows.map(rowToMessage),
  };
}

export function getRecentMessages(args: RecentArgs): RecentResult {
  const db = getInboxDb();
  const limit = Math.min(args.limit ?? 50, 200);

  // Look up account source
  const accountRow = db
    .prepare(`SELECT source FROM accounts WHERE account_id = ?`)
    .get(args.account_id) as { source: string } | undefined;

  if (!accountRow) {
    return { messages: [], new_watermark: args.since_watermark ?? '' };
  }

  const isGmail = accountRow.source === 'gmail';

  // Resolve watermark
  let watermark: string;
  let isColdStart = false;
  let coldStartCutoff: string | undefined;
  if (args.since_watermark !== undefined) {
    watermark = args.since_watermark;
  } else {
    const stored = getStoredWatermark(args.account_id);
    if (stored !== null) {
      watermark = stored;
    } else {
      // Cold start: no stored watermark and no explicit since_watermark.
      // Return only messages within the lookback window instead of epoch.
      isColdStart = true;
      coldStartCutoff = new Date(Date.now() - getColdStartLookbackMs()).toISOString();
      watermark = coldStartCutoff;
    }
  }

  let rows: unknown[];
  if (isColdStart) {
    // Cold start: filter by received_at regardless of source (both Gmail and Proton use ISO timestamps).
    rows = db
      .prepare(
        `SELECT * FROM messages
         WHERE account_id = ?
           AND received_at > ?
         ORDER BY received_at ASC
         LIMIT ?`,
      )
      .all(args.account_id, coldStartCutoff, limit);
  } else if (isGmail) {
    rows = db
      .prepare(
        `SELECT * FROM messages
         WHERE source = 'gmail'
           AND account_id = ?
           AND received_at > ?
         ORDER BY received_at ASC
         LIMIT ?`,
      )
      .all(args.account_id, watermark, limit);
  } else {
    // Proton: compare integer UIDs stored as source_message_id
    rows = db
      .prepare(
        `SELECT * FROM messages
         WHERE source = 'protonmail'
           AND account_id = ?
           AND CAST(source_message_id AS INTEGER) > CAST(? AS INTEGER)
         ORDER BY received_at ASC
         LIMIT ?`,
      )
      .all(args.account_id, watermark, limit);
  }

  const messages = rows.map(rowToMessage);

  let new_watermark: string;
  if (messages.length === 0) {
    if (isColdStart) {
      new_watermark = isGmail ? coldStartCutoff! : '0';
    } else {
      new_watermark = watermark;
    }
  } else if (isGmail) {
    new_watermark = messages.reduce(
      (max, m) => (m.received_at > max ? m.received_at : max),
      messages[0].received_at,
    );
  } else {
    // Proton: max numeric source_message_id
    const maxUid = messages.reduce(
      (max, m) => {
        const uid = parseInt(m.source_message_id, 10);
        return uid > max ? uid : max;
      },
      parseInt(messages[0].source_message_id, 10),
    );
    new_watermark = String(maxUid);
  }

  return { messages, new_watermark };
}
