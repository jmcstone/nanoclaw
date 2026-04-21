// Vendored from src/inbox-store/queries.ts — keep in sync until Phase 2 shared package.
// Kept byte-for-byte identical to the host module below the banner.

import type Database from 'better-sqlite3';
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

interface PreparedQueryStmts {
  searchFiltered: Database.Statement;
  searchAll: Database.Statement;
  threadRow: Database.Statement;
  threadMessages: Database.Statement;
  accountSource: Database.Statement;
  storedWatermark: Database.Statement;
  recentColdStart: Database.Statement;
  recentGmail: Database.Statement;
  recentProton: Database.Statement;
}

let cached: { db: Database.Database; stmts: PreparedQueryStmts } | null = null;

function stmts(): PreparedQueryStmts {
  const db = getInboxDb();
  if (cached && cached.db === db) return cached.stmts;
  cached = {
    db,
    stmts: {
      searchFiltered: db.prepare(
        `SELECT m.*
         FROM messages_fts fts
         INNER JOIN messages m ON m.message_id = fts.message_id
         WHERE messages_fts MATCH ?
           AND m.source = ?
         ORDER BY m.received_at DESC
         LIMIT ?`,
      ),
      searchAll: db.prepare(
        `SELECT m.*
         FROM messages_fts fts
         INNER JOIN messages m ON m.message_id = fts.message_id
         WHERE messages_fts MATCH ?
         ORDER BY m.received_at DESC
         LIMIT ?`,
      ),
      threadRow: db.prepare(`SELECT * FROM threads WHERE thread_id = ?`),
      threadMessages: db.prepare(
        `SELECT * FROM messages WHERE thread_id = ? ORDER BY received_at ASC`,
      ),
      accountSource: db.prepare(
        `SELECT source FROM accounts WHERE account_id = ?`,
      ),
      storedWatermark: db.prepare(
        `SELECT watermark_value FROM watermarks WHERE account_id = ?`,
      ),
      recentColdStart: db.prepare(
        `SELECT * FROM messages
         WHERE account_id = ?
           AND received_at > ?
         ORDER BY received_at ASC
         LIMIT ?`,
      ),
      recentGmail: db.prepare(
        `SELECT * FROM messages
         WHERE source = 'gmail'
           AND account_id = ?
           AND received_at > ?
         ORDER BY received_at ASC
         LIMIT ?`,
      ),
      recentProton: db.prepare(
        `SELECT * FROM messages
         WHERE source = 'protonmail'
           AND account_id = ?
           AND CAST(source_message_id AS INTEGER) > CAST(? AS INTEGER)
         ORDER BY received_at ASC
         LIMIT ?`,
      ),
    },
  };
  return cached.stmts;
}

function getStoredWatermark(account_id: string): string | null {
  const row = stmts().storedWatermark.get(account_id) as
    | { watermark_value: string }
    | undefined;
  return row?.watermark_value ?? null;
}

export function searchMessages(args: SearchArgs): SearchResult {
  const limit = Math.min(args.limit ?? 20, 100);
  const s = stmts();
  const rows = args.source
    ? s.searchFiltered.all(args.query, args.source, limit)
    : s.searchAll.all(args.query, limit);
  return { matches: rows as InboxMessage[] };
}

export function getThread(args: ThreadArgs): ThreadResult | null {
  const s = stmts();
  const threadRow = s.threadRow.get(args.thread_id);
  if (!threadRow) return null;
  const messageRows = s.threadMessages.all(args.thread_id);
  return {
    thread: threadRow as InboxThread,
    messages: messageRows as InboxMessage[],
  };
}

export function getRecentMessages(args: RecentArgs): RecentResult {
  const limit = Math.min(args.limit ?? 50, 200);
  const s = stmts();

  const accountRow = s.accountSource.get(args.account_id) as
    | { source: string }
    | undefined;
  if (!accountRow) {
    return { messages: [], new_watermark: args.since_watermark ?? '' };
  }
  const isGmail = accountRow.source === 'gmail';

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
      isColdStart = true;
      coldStartCutoff = new Date(
        Date.now() - getColdStartLookbackMs(),
      ).toISOString();
      watermark = coldStartCutoff;
    }
  }

  let rows: unknown[];
  if (isColdStart) {
    rows = s.recentColdStart.all(args.account_id, coldStartCutoff, limit);
  } else if (isGmail) {
    rows = s.recentGmail.all(args.account_id, watermark, limit);
  } else {
    rows = s.recentProton.all(args.account_id, watermark, limit);
  }

  const messages = rows as InboxMessage[];

  let new_watermark: string;
  if (messages.length === 0) {
    if (!isColdStart) new_watermark = watermark;
    else if (isGmail) new_watermark = coldStartCutoff!;
    else new_watermark = '0';
  } else if (isGmail) {
    new_watermark = messages.reduce(
      (max, m) => (m.received_at > max ? m.received_at : max),
      messages[0].received_at,
    );
  } else {
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
