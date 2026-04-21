import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { _closeInboxDb, _initTestInboxDb } from './db.js';
import { getRecentMessages, getThread, searchMessages } from './queries.js';

let db: Database.Database;

function seed() {
  // Accounts
  db.prepare(
    `INSERT INTO accounts(account_id, source, email_address) VALUES (?,?,?)`,
  ).run('gmail:jeff@example.com', 'gmail', 'jeff@example.com');
  db.prepare(
    `INSERT INTO accounts(account_id, source, email_address) VALUES (?,?,?)`,
  ).run('proton:jeff@proton.me', 'protonmail', 'jeff@proton.me');

  // Senders
  db.prepare(
    `INSERT INTO senders(sender_id, email_address, display_name) VALUES (?,?,?)`,
  ).run('sender1', 'alice@example.com', 'Alice');
  db.prepare(
    `INSERT INTO senders(sender_id, email_address, display_name) VALUES (?,?,?)`,
  ).run('sender2', 'guardian@example.com', 'The Guardian');

  // Threads
  db.prepare(
    `INSERT INTO threads(thread_id, source, subject, last_message_at, message_count) VALUES (?,?,?,?,?)`,
  ).run('thread1', 'gmail', 'Invoice notice', '2024-01-02T00:00:00Z', 2);
  db.prepare(
    `INSERT INTO threads(thread_id, source, subject, last_message_at, message_count) VALUES (?,?,?,?,?)`,
  ).run('thread2', 'protonmail', 'Guardian weekly', '2024-01-03T00:00:00Z', 1);

  // Messages (trigger populates messages_fts automatically)
  db.prepare(
    `INSERT INTO messages(message_id,source,account_id,source_message_id,thread_id,sender_id,subject,body_markdown,received_at,raw_headers_json)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    'gmail:msg1',
    'gmail',
    'gmail:jeff@example.com',
    'msg1',
    'thread1',
    'sender1',
    'Invoice notice',
    'Please pay invoice #42.',
    '2024-01-01T10:00:00Z',
    null,
  );
  db.prepare(
    `INSERT INTO messages(message_id,source,account_id,source_message_id,thread_id,sender_id,subject,body_markdown,received_at,raw_headers_json)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    'gmail:msg2',
    'gmail',
    'gmail:jeff@example.com',
    'msg2',
    'thread1',
    'sender1',
    'Re: Invoice notice',
    'Got it, thanks.',
    '2024-01-02T10:00:00Z',
    null,
  );
  db.prepare(
    `INSERT INTO messages(message_id,source,account_id,source_message_id,thread_id,sender_id,subject,body_markdown,received_at,raw_headers_json)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    'proton:msg3',
    'protonmail',
    'proton:jeff@proton.me',
    '1001',
    'thread2',
    'sender2',
    'Guardian weekly',
    'Top stories from the Guardian.',
    '2024-01-03T08:00:00Z',
    null,
  );
  db.prepare(
    `INSERT INTO messages(message_id,source,account_id,source_message_id,thread_id,sender_id,subject,body_markdown,received_at,raw_headers_json)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    'proton:msg4',
    'protonmail',
    'proton:jeff@proton.me',
    '1002',
    'thread2',
    'sender2',
    'Guardian digest',
    'More stories from the Guardian.',
    '2024-01-04T08:00:00Z',
    null,
  );
}

beforeEach(() => {
  db = _initTestInboxDb();
  seed();
});

afterEach(() => {
  _closeInboxDb();
});

// ── searchMessages ──────────────────────────────────────────────────────────

describe('searchMessages', () => {
  it('returns matching rows for a single-token query', () => {
    const result = searchMessages({ query: 'invoice' });
    expect(result.matches.length).toBeGreaterThan(0);
    const ids = result.matches.map((m) => m.message_id);
    expect(ids).toContain('gmail:msg1');
  });

  it('filters by source', () => {
    const result = searchMessages({ query: 'Guardian', source: 'gmail' });
    expect(result.matches.every((m) => m.source === 'gmail')).toBe(true);
    // proton:msg3 must be absent
    expect(result.matches.map((m) => m.message_id)).not.toContain(
      'proton:msg3',
    );
  });

  it('respects limit', () => {
    // seed has 4 messages; searching broadly with limit 2 should cap
    const result = searchMessages({ query: 'Guardian OR invoice', limit: 2 });
    expect(result.matches.length).toBeLessThanOrEqual(2);
  });

  it('returns empty array on no-match query', () => {
    const result = searchMessages({ query: 'zzznomatch' });
    expect(result.matches).toEqual([]);
  });

  it('handles FTS5 AND operator query', () => {
    // "invoice AND guardian" should match nothing (different messages)
    const result = searchMessages({ query: 'invoice AND guardian' });
    expect(result.matches).toEqual([]);

    // "invoice" alone should match
    const r2 = searchMessages({ query: 'invoice' });
    expect(r2.matches.length).toBeGreaterThan(0);
  });
});

// ── getThread ──────────────────────────────────────────────────────────────

describe('getThread', () => {
  it('returns null for an unknown thread', () => {
    expect(getThread({ thread_id: 'does-not-exist' })).toBeNull();
  });

  it('returns thread + messages sorted by received_at ASC', () => {
    const result = getThread({ thread_id: 'thread1' });
    expect(result).not.toBeNull();
    expect(result!.thread.thread_id).toBe('thread1');
    expect(result!.messages.length).toBe(2);
    expect(result!.messages[0].message_id).toBe('gmail:msg1');
    expect(result!.messages[1].message_id).toBe('gmail:msg2');
  });
});

// ── getRecentMessages ──────────────────────────────────────────────────────

describe('getRecentMessages', () => {
  it('without since_watermark uses stored watermark from watermarks table', () => {
    db.prepare(
      `INSERT INTO watermarks(account_id, watermark_value, updated_at) VALUES (?,?,?)`,
    ).run('gmail:jeff@example.com', '2024-01-01T15:00:00Z', new Date().toISOString());

    const result = getRecentMessages({ account_id: 'gmail:jeff@example.com' });
    // msg1 received_at = 2024-01-01T10:00:00Z < watermark → excluded
    // msg2 received_at = 2024-01-02T10:00:00Z > watermark → included
    expect(result.messages.map((m) => m.message_id)).toEqual(['gmail:msg2']);
  });

  it('with explicit since_watermark overrides stored watermark', () => {
    // Store an old watermark that would return both messages
    db.prepare(
      `INSERT INTO watermarks(account_id, watermark_value, updated_at) VALUES (?,?,?)`,
    ).run('gmail:jeff@example.com', '2020-01-01T00:00:00Z', new Date().toISOString());

    // Pass a recent watermark that excludes msg1
    const result = getRecentMessages({
      account_id: 'gmail:jeff@example.com',
      since_watermark: '2024-01-01T15:00:00Z',
    });
    expect(result.messages.map((m) => m.message_id)).toEqual(['gmail:msg2']);
  });

  it('filters Gmail by timestamp', () => {
    const result = getRecentMessages({
      account_id: 'gmail:jeff@example.com',
      since_watermark: '2024-01-01T00:00:00Z',
    });
    const ids = result.messages.map((m) => m.message_id);
    expect(ids).toContain('gmail:msg1');
    expect(ids).toContain('gmail:msg2');
    expect(ids).not.toContain('proton:msg3');
  });

  it('filters Proton by integer UID', () => {
    const result = getRecentMessages({
      account_id: 'proton:jeff@proton.me',
      since_watermark: '1001',
    });
    const ids = result.messages.map((m) => m.message_id);
    expect(ids).not.toContain('proton:msg3'); // source_message_id = 1001, not > 1001
    expect(ids).toContain('proton:msg4');     // source_message_id = 1002 > 1001
  });

  it('returns new_watermark equal to max timestamp for Gmail', () => {
    const result = getRecentMessages({
      account_id: 'gmail:jeff@example.com',
      since_watermark: '2024-01-01T00:00:00Z',
    });
    expect(result.new_watermark).toBe('2024-01-02T10:00:00Z');
  });

  it('returns new_watermark equal to max UID for Proton', () => {
    const result = getRecentMessages({
      account_id: 'proton:jeff@proton.me',
      since_watermark: '1000',
    });
    expect(result.new_watermark).toBe('1002');
  });

  it('returns new_watermark = since_watermark when no messages returned', () => {
    const result = getRecentMessages({
      account_id: 'gmail:jeff@example.com',
      since_watermark: '2030-01-01T00:00:00Z',
    });
    expect(result.messages).toEqual([]);
    expect(result.new_watermark).toBe('2030-01-01T00:00:00Z');
  });

  it('returns empty result for unknown account', () => {
    const result = getRecentMessages({
      account_id: 'nonexistent:x@y.com',
      since_watermark: 'some-wm',
    });
    expect(result.messages).toEqual([]);
    expect(result.new_watermark).toBe('some-wm');
  });
});
