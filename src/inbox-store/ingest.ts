import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { getInboxDb } from './db.js';
import type { InboxSource } from './types.js';

export interface MessageIngestInput {
  source: InboxSource;
  account_email: string;
  thread_id: string;
  source_message_id: string;
  sender_email: string;
  sender_name: string | null;
  subject: string | null;
  body_markdown: string;
  received_at: string;
  raw_headers_json?: string | null;
}

interface PreparedIngestStmts {
  upsertAccount: Database.Statement;
  upsertSender: Database.Statement;
  upsertThread: Database.Statement;
  insertMessage: Database.Statement;
  bumpThread: Database.Statement;
}

let cached: { db: Database.Database; stmts: PreparedIngestStmts } | null = null;

function stmts(): PreparedIngestStmts {
  const db = getInboxDb();
  if (cached && cached.db === db) return cached.stmts;
  cached = {
    db,
    stmts: {
      upsertAccount: db.prepare(
        `INSERT INTO accounts (account_id, source, email_address)
         VALUES (?, ?, ?)
         ON CONFLICT DO NOTHING`,
      ),
      upsertSender: db.prepare(
        `INSERT INTO senders (sender_id, email_address, display_name)
         VALUES (?, ?, ?)
         ON CONFLICT DO NOTHING`,
      ),
      upsertThread: db.prepare(
        `INSERT INTO threads (thread_id, source, subject, last_message_at, message_count)
         VALUES (?, ?, ?, ?, 0)
         ON CONFLICT DO NOTHING`,
      ),
      insertMessage: db.prepare(
        `INSERT INTO messages
           (message_id, source, account_id, source_message_id, thread_id, sender_id,
            subject, body_markdown, received_at, raw_headers_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      ),
      bumpThread: db.prepare(
        `UPDATE threads
         SET
           last_message_at = CASE WHEN last_message_at < ? THEN ? ELSE last_message_at END,
           message_count   = message_count + 1
         WHERE thread_id = ?`,
      ),
    },
  };
  return cached.stmts;
}

function makeSenderId(email: string): string {
  return crypto
    .createHash('sha1')
    .update(email.toLowerCase())
    .digest('hex')
    .slice(0, 16);
}

/**
 * Idempotently upsert a single message into the inbox store. Caller
 * derives the `thread_id` for their source (email sources prefix with
 * their source name; chat sources use their native thread key).
 * Returns { message_id, inserted } — `inserted: false` means a row with
 * this (source, source_message_id) already existed.
 */
export function ingestMessage(input: MessageIngestInput): {
  message_id: string;
  inserted: boolean;
} {
  const account_email = input.account_email.toLowerCase();
  const sender_email = input.sender_email.toLowerCase();
  const account_id = `${input.source}:${account_email}`;
  const sender_id = makeSenderId(sender_email);
  const message_id = `${input.source}:${input.source_message_id}`;

  const s = stmts();
  return getInboxDb().transaction(() => {
    s.upsertAccount.run(account_id, input.source, account_email);
    s.upsertSender.run(sender_id, sender_email, input.sender_name);
    s.upsertThread.run(
      input.thread_id,
      input.source,
      input.subject,
      input.received_at,
    );
    const res = s.insertMessage.run(
      message_id,
      input.source,
      account_id,
      input.source_message_id,
      input.thread_id,
      sender_id,
      input.subject,
      input.body_markdown,
      input.received_at,
      input.raw_headers_json ?? null,
    );
    const inserted = res.changes === 1;
    if (inserted) {
      s.bumpThread.run(input.received_at, input.received_at, input.thread_id);
    }
    return { message_id, inserted };
  })();
}
