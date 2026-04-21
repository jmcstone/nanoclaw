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
  if (args.since_watermark !== undefined) {
    watermark = args.since_watermark;
  } else {
    watermark = getStoredWatermark(args.account_id) ?? '';
  }

  let rows: unknown[];
  if (isGmail) {
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
    new_watermark = watermark;
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
