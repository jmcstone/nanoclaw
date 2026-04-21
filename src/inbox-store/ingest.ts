import crypto from 'crypto';
import { getInboxDb } from './db.js';

export interface GmailIngestInput {
  account_email: string;
  source_message_id: string;
  thread_id: string;
  sender_email: string;
  sender_name: string | null;
  subject: string | null;
  body_markdown: string;
  received_at: string;
  raw_headers_json?: string | null;
}

export interface ProtonmailIngestInput {
  account_email: string;
  source_message_id: string;
  sender_email: string;
  sender_name: string | null;
  subject: string | null;
  body_markdown: string;
  received_at: string;
  in_reply_to: string | null;
  references: string[];
  raw_headers_json?: string | null;
}

function makeSenderId(email: string): string {
  return crypto.createHash('sha1').update(email.toLowerCase()).digest('hex').slice(0, 16);
}

export function ingestGmail(input: GmailIngestInput): { message_id: string; inserted: boolean } {
  const db = getInboxDb();

  const source = 'gmail';
  const account_id = `${source}:${input.account_email.toLowerCase()}`;
  const sender_id = makeSenderId(input.sender_email);
  const message_id = `${source}:${input.source_message_id}`;
  const thread_id = `gmail:${input.thread_id}`;

  const run = db.transaction(() => {
    // 1. accounts
    db.prepare(`
      INSERT INTO accounts (account_id, source, email_address)
      VALUES (?, ?, ?)
      ON CONFLICT DO NOTHING
    `).run(account_id, source, input.account_email.toLowerCase());

    // 2. senders
    db.prepare(`
      INSERT INTO senders (sender_id, email_address, display_name)
      VALUES (?, ?, ?)
      ON CONFLICT DO NOTHING
    `).run(sender_id, input.sender_email.toLowerCase(), input.sender_name ?? null);

    // 3. threads
    db.prepare(`
      INSERT INTO threads (thread_id, source, subject, last_message_at, message_count)
      VALUES (?, ?, ?, ?, 0)
      ON CONFLICT DO NOTHING
    `).run(thread_id, source, input.subject ?? null, input.received_at);

    // 4. messages — honour UNIQUE(source, source_message_id) for idempotency
    const result = db.prepare(`
      INSERT INTO messages
        (message_id, source, account_id, source_message_id, thread_id, sender_id,
         subject, body_markdown, received_at, raw_headers_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `).run(
      message_id, source, account_id, input.source_message_id,
      thread_id, sender_id, input.subject ?? null,
      input.body_markdown, input.received_at,
      input.raw_headers_json ?? null,
    );

    const inserted = result.changes === 1;

    if (inserted) {
      db.prepare(`
        UPDATE threads
        SET
          last_message_at = CASE WHEN last_message_at < ? THEN ? ELSE last_message_at END,
          message_count   = message_count + 1
        WHERE thread_id = ?
      `).run(input.received_at, input.received_at, thread_id);
    }

    return { message_id, inserted };
  });

  return run();
}

export function ingestProtonmail(input: ProtonmailIngestInput): { message_id: string; inserted: boolean } {
  const db = getInboxDb();

  const source = 'protonmail';
  const account_id = `${source}:${input.account_email.toLowerCase()}`;
  const sender_id = makeSenderId(input.sender_email);
  const message_id = `${source}:${input.source_message_id}`;

  // Derive thread root: first of references[], then in_reply_to, then own id
  let threadRoot: string;
  if (input.references.length > 0) {
    threadRoot = input.references[0];
  } else if (input.in_reply_to) {
    threadRoot = input.in_reply_to;
  } else {
    threadRoot = input.source_message_id;
  }
  const thread_id = `proton:${threadRoot}`;

  const run = db.transaction(() => {
    // 1. accounts
    db.prepare(`
      INSERT INTO accounts (account_id, source, email_address)
      VALUES (?, ?, ?)
      ON CONFLICT DO NOTHING
    `).run(account_id, source, input.account_email.toLowerCase());

    // 2. senders
    db.prepare(`
      INSERT INTO senders (sender_id, email_address, display_name)
      VALUES (?, ?, ?)
      ON CONFLICT DO NOTHING
    `).run(sender_id, input.sender_email.toLowerCase(), input.sender_name ?? null);

    // 3. threads
    db.prepare(`
      INSERT INTO threads (thread_id, source, subject, last_message_at, message_count)
      VALUES (?, ?, ?, ?, 0)
      ON CONFLICT DO NOTHING
    `).run(thread_id, source, input.subject ?? null, input.received_at);

    // 4. messages
    const result = db.prepare(`
      INSERT INTO messages
        (message_id, source, account_id, source_message_id, thread_id, sender_id,
         subject, body_markdown, received_at, raw_headers_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `).run(
      message_id, source, account_id, input.source_message_id,
      thread_id, sender_id, input.subject ?? null,
      input.body_markdown, input.received_at,
      input.raw_headers_json ?? null,
    );

    const inserted = result.changes === 1;

    if (inserted) {
      db.prepare(`
        UPDATE threads
        SET
          last_message_at = CASE WHEN last_message_at < ? THEN ? ELSE last_message_at END,
          message_count   = message_count + 1
        WHERE thread_id = ?
      `).run(input.received_at, input.received_at, thread_id);
    }

    return { message_id, inserted };
  });

  return run();
}
