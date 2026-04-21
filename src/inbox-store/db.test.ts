import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { _initTestInboxDb, _closeInboxDb, getInboxDb } from './db.js';

beforeEach(() => {
  _initTestInboxDb();
});

afterEach(() => {
  _closeInboxDb();
});

// --- helpers ---

function insertFixtures() {
  const db = getInboxDb();

  db.prepare(
    `INSERT INTO accounts (account_id, source, email_address) VALUES (?, ?, ?)`,
  ).run('acct-1', 'gmail', 'jeff@example.com');

  db.prepare(
    `INSERT INTO senders (sender_id, email_address, display_name) VALUES (?, ?, ?)`,
  ).run('sender-1', 'alice@example.com', 'Alice');

  db.prepare(
    `INSERT INTO threads (thread_id, source, subject, last_message_at, message_count) VALUES (?, ?, ?, ?, ?)`,
  ).run('thread-1', 'gmail', 'Hello world', '2024-01-01T12:00:00.000Z', 1);

  return db;
}

function insertMessage(
  db: ReturnType<typeof getInboxDb>,
  overrides: Partial<{
    message_id: string;
    source: string;
    account_id: string;
    source_message_id: string;
    thread_id: string;
    sender_id: string;
    subject: string;
    body_markdown: string;
    received_at: string;
    raw_headers_json: string | null;
  }> = {},
) {
  const vals = {
    message_id: 'msg-1',
    source: 'gmail',
    account_id: 'acct-1',
    source_message_id: 'gmail-id-1',
    thread_id: 'thread-1',
    sender_id: 'sender-1',
    subject: 'Hello subject_keyword world',
    body_markdown: 'Some body text',
    received_at: '2024-01-01T12:00:00.000Z',
    raw_headers_json: null,
    ...overrides,
  };

  db.prepare(`
    INSERT INTO messages
      (message_id, source, account_id, source_message_id, thread_id, sender_id, subject, body_markdown, received_at, raw_headers_json)
    VALUES
      (@message_id, @source, @account_id, @source_message_id, @thread_id, @sender_id, @subject, @body_markdown, @received_at, @raw_headers_json)
  `).run(vals);

  return vals;
}

// --- 1. All tables exist ---

describe('schema: all tables exist', () => {
  it('creates accounts, senders, threads, messages, watermarks', () => {
    const db = getInboxDb();
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?, ?, ?)`,
      )
      .all('accounts', 'senders', 'threads', 'messages', 'watermarks') as Array<{
      name: string;
    }>;

    const names = tables.map((t) => t.name).sort();
    expect(names).toEqual(
      ['accounts', 'messages', 'senders', 'threads', 'watermarks'].sort(),
    );
  });
});

// --- 2. FTS5 virtual table exists ---

describe('schema: FTS5 virtual table exists', () => {
  it('creates messages_fts', () => {
    const db = getInboxDb();
    const row = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'`,
      )
      .get() as { name: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.name).toBe('messages_fts');
  });
});

// --- 3. FTS5 populated on insert ---

describe('FTS5: populated on insert', () => {
  it('indexes the subject token after insert', () => {
    const db = insertFixtures();
    insertMessage(db);

    const rows = db
      .prepare(
        `SELECT message_id FROM messages_fts WHERE messages_fts MATCH 'subject_keyword'`,
      )
      .all() as Array<{ message_id: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].message_id).toBe('msg-1');
  });
});

// --- 4. FTS5 synced on update ---

describe('FTS5: synced on update', () => {
  it('old token no longer matches and new token matches after subject update', () => {
    const db = insertFixtures();
    insertMessage(db);

    db.prepare(
      `UPDATE messages SET subject = 'Completely different newtopic here' WHERE message_id = 'msg-1'`,
    ).run();

    const oldMatches = db
      .prepare(
        `SELECT message_id FROM messages_fts WHERE messages_fts MATCH 'subject_keyword'`,
      )
      .all();
    expect(oldMatches).toHaveLength(0);

    const newMatches = db
      .prepare(
        `SELECT message_id FROM messages_fts WHERE messages_fts MATCH 'newtopic'`,
      )
      .all() as Array<{ message_id: string }>;
    expect(newMatches).toHaveLength(1);
    expect(newMatches[0].message_id).toBe('msg-1');
  });
});

// --- 5. FTS5 synced on delete ---

describe('FTS5: synced on delete', () => {
  it('returns nothing after message is deleted', () => {
    const db = insertFixtures();
    insertMessage(db);

    db.prepare(`DELETE FROM messages WHERE message_id = 'msg-1'`).run();

    const rows = db
      .prepare(
        `SELECT message_id FROM messages_fts WHERE messages_fts MATCH 'subject_keyword'`,
      )
      .all();
    expect(rows).toHaveLength(0);
  });
});

// --- 6. UNIQUE (source, source_message_id) constraint ---

describe('constraints: UNIQUE (source, source_message_id)', () => {
  it('throws on duplicate (source, source_message_id)', () => {
    const db = insertFixtures();
    insertMessage(db);

    expect(() =>
      insertMessage(db, { message_id: 'msg-2' }),
    ).toThrow();
  });
});

// --- 7. Round-trip insert + select ---

describe('round-trip: insert and select', () => {
  it('reads back all fields exactly as inserted', () => {
    const db = insertFixtures();
    const vals = insertMessage(db);

    const row = db
      .prepare(`SELECT * FROM messages WHERE message_id = ?`)
      .get('msg-1') as typeof vals | undefined;

    expect(row).toBeDefined();
    expect(row!.message_id).toBe(vals.message_id);
    expect(row!.source).toBe(vals.source);
    expect(row!.account_id).toBe(vals.account_id);
    expect(row!.source_message_id).toBe(vals.source_message_id);
    expect(row!.thread_id).toBe(vals.thread_id);
    expect(row!.sender_id).toBe(vals.sender_id);
    expect(row!.subject).toBe(vals.subject);
    expect(row!.body_markdown).toBe(vals.body_markdown);
    expect(row!.received_at).toBe(vals.received_at);
    expect(row!.raw_headers_json).toBeNull();
  });
});

// --- idempotent schema ---

describe('schema: idempotent', () => {
  it('calling _initTestInboxDb twice does not throw', () => {
    // afterEach closes it; calling init again inside the test is fine
    expect(() => _initTestInboxDb()).not.toThrow();
  });
});
