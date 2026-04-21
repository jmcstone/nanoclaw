import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { _initTestInboxDb, _closeInboxDb, getInboxDb } from './db.js';
import { ingestGmail, ingestProtonmail } from './ingest.js';
import type { GmailIngestInput, ProtonmailIngestInput } from './ingest.js';

function gmailMsg(overrides: Partial<GmailIngestInput> = {}): GmailIngestInput {
  return {
    account_email: 'jeff@americanvoxpop.com',
    source_message_id: 'msg-001',
    thread_id: 'thread-001',
    sender_email: 'alice@example.com',
    sender_name: 'Alice',
    subject: 'Hello world',
    body_markdown: 'Hello **world**',
    received_at: '2026-01-01T10:00:00Z',
    ...overrides,
  };
}

function protonMsg(overrides: Partial<ProtonmailIngestInput> = {}): ProtonmailIngestInput {
  return {
    account_email: 'jeff@pm.me',
    source_message_id: '<msg-001@proton.me>',
    sender_email: 'bob@example.com',
    sender_name: 'Bob',
    subject: 'Proton hello',
    body_markdown: 'Hello from **Proton**',
    received_at: '2026-01-01T11:00:00Z',
    in_reply_to: null,
    references: [],
    ...overrides,
  };
}

beforeEach(() => {
  _initTestInboxDb();
});

afterEach(() => {
  _closeInboxDb();
});

// 1. Gmail insert creates account, sender, thread, message rows
it('Gmail insert creates all four rows', () => {
  const { message_id, inserted } = ingestGmail(gmailMsg());
  expect(inserted).toBe(true);
  expect(message_id).toBe('gmail:msg-001');

  const db = getInboxDb();
  expect(db.prepare('SELECT * FROM accounts WHERE account_id = ?').get('gmail:jeff@americanvoxpop.com')).toBeTruthy();
  expect(db.prepare('SELECT * FROM senders WHERE email_address = ?').get('alice@example.com')).toBeTruthy();
  expect(db.prepare('SELECT * FROM threads WHERE thread_id = ?').get('gmail:thread-001')).toBeTruthy();
  expect(db.prepare('SELECT * FROM messages WHERE message_id = ?').get('gmail:msg-001')).toBeTruthy();
});

// 2. Re-ingesting same Gmail message is a no-op
it('Re-ingesting the same Gmail message returns inserted:false and same message_id', () => {
  const first = ingestGmail(gmailMsg());
  const second = ingestGmail(gmailMsg());
  expect(first.message_id).toBe(second.message_id);
  expect(first.inserted).toBe(true);
  expect(second.inserted).toBe(false);

  const db = getInboxDb();
  const count = (db.prepare('SELECT count(*) as c FROM messages').get() as { c: number }).c;
  expect(count).toBe(1);
});

// 3. Two Gmail messages in same thread end up with message_count = 2
it('Two Gmail messages in the same thread produce message_count = 2', () => {
  ingestGmail(gmailMsg({ source_message_id: 'msg-001' }));
  ingestGmail(gmailMsg({ source_message_id: 'msg-002' }));

  const db = getInboxDb();
  const thread = db.prepare('SELECT * FROM threads WHERE thread_id = ?').get('gmail:thread-001') as { message_count: number };
  expect(thread.message_count).toBe(2);
});

// 4. Protonmail with empty references and null in_reply_to uses own source_message_id as thread root
it('Protonmail with no references/in_reply_to uses own id as thread root', () => {
  const { inserted } = ingestProtonmail(protonMsg());
  expect(inserted).toBe(true);

  const db = getInboxDb();
  const msg = db.prepare('SELECT thread_id FROM messages WHERE message_id = ?').get('protonmail:<msg-001@proton.me>') as { thread_id: string };
  expect(msg.thread_id).toBe('proton:<msg-001@proton.me>');
});

// 5. Protonmail with in_reply_to but no references uses in_reply_to as thread root
it('Protonmail with in_reply_to (no references) uses in_reply_to as thread root', () => {
  ingestProtonmail(protonMsg({
    source_message_id: '<msg-002@proton.me>',
    in_reply_to: '<msg-001@proton.me>',
    references: [],
  }));

  const db = getInboxDb();
  const msg = db.prepare('SELECT thread_id FROM messages WHERE message_id = ?').get('protonmail:<msg-002@proton.me>') as { thread_id: string };
  expect(msg.thread_id).toBe('proton:<msg-001@proton.me>');
});

// 6. Protonmail with references uses first (oldest) as thread root
it('Protonmail with references uses the first entry as thread root', () => {
  ingestProtonmail(protonMsg({
    source_message_id: '<msg-003@proton.me>',
    references: ['<a>', '<b>', '<c>'],
    in_reply_to: '<b>',
  }));

  const db = getInboxDb();
  const msg = db.prepare('SELECT thread_id FROM messages WHERE message_id = ?').get('protonmail:<msg-003@proton.me>') as { thread_id: string };
  expect(msg.thread_id).toBe('proton:<a>');
});

// 7. Two Protonmail messages sharing the same references root end up on the same thread
it('Two Protonmail messages with the same references root share a thread', () => {
  ingestProtonmail(protonMsg({
    source_message_id: '<msg-002@proton.me>',
    references: ['<root@proton.me>'],
  }));
  ingestProtonmail(protonMsg({
    source_message_id: '<msg-003@proton.me>',
    references: ['<root@proton.me>', '<msg-002@proton.me>'],
  }));

  const db = getInboxDb();
  const thread = db.prepare('SELECT * FROM threads WHERE thread_id = ?').get('proton:<root@proton.me>') as { message_count: number };
  expect(thread.message_count).toBe(2);
});

// 8. Protonmail and Gmail messages NEVER share a thread even if subjects coincide
it('Gmail and Protonmail messages with same subject never share a thread', () => {
  ingestGmail(gmailMsg({ subject: 'Shared subject', thread_id: 'shared-root' }));
  ingestProtonmail(protonMsg({ subject: 'Shared subject', source_message_id: 'shared-root' }));

  const db = getInboxDb();
  const gmailThread = db.prepare('SELECT thread_id FROM messages WHERE source = ?').get('gmail') as { thread_id: string };
  const protonThread = db.prepare('SELECT thread_id FROM messages WHERE source = ?').get('protonmail') as { thread_id: string };
  expect(gmailThread.thread_id).not.toBe(protonThread.thread_id);
  expect(gmailThread.thread_id.startsWith('gmail:')).toBe(true);
  expect(protonThread.thread_id.startsWith('proton:')).toBe(true);
});

// 9. Round-trip: all fields intact + FTS match on subject token
it('Round-trip: all message fields are stored correctly and FTS finds by subject token', () => {
  const input = gmailMsg({
    subject: 'Roundtrip verification test',
    body_markdown: 'Body text here',
    raw_headers_json: '{"X-Foo":"bar"}',
  });
  ingestGmail(input);

  const db = getInboxDb();
  const msg = db.prepare('SELECT * FROM messages WHERE message_id = ?').get('gmail:msg-001') as Record<string, unknown>;
  expect(msg.source).toBe('gmail');
  expect(msg.subject).toBe('Roundtrip verification test');
  expect(msg.body_markdown).toBe('Body text here');
  expect(msg.raw_headers_json).toBe('{"X-Foo":"bar"}');
  expect(msg.received_at).toBe('2026-01-01T10:00:00Z');

  const ftsResult = db.prepare(`
    SELECT message_id FROM messages_fts WHERE messages_fts MATCH 'verification'
  `).all() as Array<{ message_id: string }>;
  expect(ftsResult.some(r => r.message_id === 'gmail:msg-001')).toBe(true);
});

// 10. last_message_at is the max of per-message received_at (out-of-order insertion)
it('last_message_at reflects the latest received_at even when messages arrive out of order', () => {
  // Insert newer message first
  ingestGmail(gmailMsg({
    source_message_id: 'msg-late',
    received_at: '2026-01-05T10:00:00Z',
  }));
  // Insert older message second
  ingestGmail(gmailMsg({
    source_message_id: 'msg-early',
    received_at: '2026-01-01T08:00:00Z',
  }));

  const db = getInboxDb();
  const thread = db.prepare('SELECT last_message_at, message_count FROM threads WHERE thread_id = ?').get('gmail:thread-001') as { last_message_at: string; message_count: number };
  expect(thread.last_message_at).toBe('2026-01-05T10:00:00Z');
  expect(thread.message_count).toBe(2);
});
