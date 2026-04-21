import type Database from 'better-sqlite3';
import {
  INBOX_SOURCES,
  InboxMessage,
  InboxSource,
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

/**
 * Per-source watermark strategy: how "newer than watermark" is expressed in
 * SQL, how the next watermark is derived from the returned rows, and what
 * value to return on a cold start that finds zero rows.
 *
 * Adding a new source = add one entry to {@link buildStrategies}.
 */
interface WatermarkStrategy {
  recentStmt: Database.Statement;
  maxWatermark(messages: InboxMessage[]): string;
  coldStartEmpty(cutoff: string): string;
}

interface PreparedQueryStmts {
  searchFiltered: Database.Statement;
  searchAll: Database.Statement;
  threadRow: Database.Statement;
  threadMessages: Database.Statement;
  accountSource: Database.Statement;
  storedWatermark: Database.Statement;
  recentColdStart: Database.Statement;
  strategies: Record<InboxSource, WatermarkStrategy>;
}

function buildStrategies(
  db: Database.Database,
): Record<InboxSource, WatermarkStrategy> {
  const maxReceivedAt = (messages: InboxMessage[]): string =>
    messages.reduce(
      (max, m) => (m.received_at > max ? m.received_at : max),
      messages[0].received_at,
    );

  const maxUid = (messages: InboxMessage[]): string => {
    const n = messages.reduce(
      (max, m) => {
        const uid = parseInt(m.source_message_id, 10);
        return uid > max ? uid : max;
      },
      parseInt(messages[0].source_message_id, 10),
    );
    return String(n);
  };

  return {
    gmail: {
      recentStmt: db.prepare(
        `SELECT * FROM messages
         WHERE source = 'gmail'
           AND account_id = ?
           AND received_at > ?
         ORDER BY received_at ASC
         LIMIT ?`,
      ),
      maxWatermark: maxReceivedAt,
      coldStartEmpty: (cutoff) => cutoff,
    },
    protonmail: {
      recentStmt: db.prepare(
        `SELECT * FROM messages
         WHERE source = 'protonmail'
           AND account_id = ?
           AND CAST(source_message_id AS INTEGER) > CAST(? AS INTEGER)
         ORDER BY received_at ASC
         LIMIT ?`,
      ),
      maxWatermark: maxUid,
      coldStartEmpty: () => '0',
    },
  };
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
      strategies: buildStrategies(db),
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

function isValidSource(source: string): source is InboxSource {
  return INBOX_SOURCES.includes(source as InboxSource);
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
  if (!accountRow || !isValidSource(accountRow.source)) {
    return { messages: [], new_watermark: args.since_watermark ?? '' };
  }
  const strategy = s.strategies[accountRow.source];

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

  const rows = isColdStart
    ? s.recentColdStart.all(args.account_id, coldStartCutoff, limit)
    : strategy.recentStmt.all(args.account_id, watermark, limit);

  const messages = rows as InboxMessage[];

  let new_watermark: string;
  if (messages.length === 0) {
    new_watermark = isColdStart
      ? strategy.coldStartEmpty(coldStartCutoff!)
      : watermark;
  } else {
    new_watermark = strategy.maxWatermark(messages);
  }

  return { messages, new_watermark };
}
