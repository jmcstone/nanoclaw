import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { _closeInboxDb, _initTestInboxDb } from './db.js';
import {
  DEFAULT_COLD_START_LOOKBACK_MS,
  getColdStartLookbackMs,
  getRecentMessages,
  getThread,
  searchMessages,
} from './queries.js';

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
    ).run(
      'gmail:jeff@example.com',
      '2024-01-01T15:00:00Z',
      new Date().toISOString(),
    );

    const result = getRecentMessages({ account_id: 'gmail:jeff@example.com' });
    // msg1 received_at = 2024-01-01T10:00:00Z < watermark → excluded
    // msg2 received_at = 2024-01-02T10:00:00Z > watermark → included
    expect(result.messages.map((m) => m.message_id)).toEqual(['gmail:msg2']);
  });

  it('with explicit since_watermark overrides stored watermark', () => {
    // Store an old watermark that would return both messages
    db.prepare(
      `INSERT INTO watermarks(account_id, watermark_value, updated_at) VALUES (?,?,?)`,
    ).run(
      'gmail:jeff@example.com',
      '2020-01-01T00:00:00Z',
      new Date().toISOString(),
    );

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
    expect(ids).toContain('proton:msg4'); // source_message_id = 1002 > 1001
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

  describe('cold-start (no stored watermark, no since_watermark)', () => {
    // Helpers to seed messages with received_at relative to now
    function seedRecentMessage(
      messageId: string,
      source: 'gmail' | 'protonmail',
      accountId: string,
      sourceMessageId: string,
      threadId: string,
      senderId: string,
      subject: string,
      offsetMs: number, // negative = in the past
    ) {
      const receivedAt = new Date(Date.now() + offsetMs).toISOString();
      db.prepare(
        `INSERT INTO messages(message_id,source,account_id,source_message_id,thread_id,sender_id,subject,body_markdown,received_at,raw_headers_json)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(messageId, source, accountId, sourceMessageId, threadId, senderId, subject, 'body', receivedAt, null);
      return receivedAt;
    }

    beforeEach(() => {
      // Seed a thread for recent messages
      db.prepare(
        `INSERT OR IGNORE INTO threads(thread_id, source, subject, last_message_at, message_count) VALUES (?,?,?,?,?)`,
      ).run('thread-recent', 'gmail', 'Recent thread', new Date().toISOString(), 1);
      db.prepare(
        `INSERT OR IGNORE INTO threads(thread_id, source, subject, last_message_at, message_count) VALUES (?,?,?,?,?)`,
      ).run('thread-proton-recent', 'protonmail', 'Recent proton thread', new Date().toISOString(), 1);
    });

    it('cold-start default 24h: returns only messages within the last 24h', () => {
      // 3 days old — should be excluded
      seedRecentMessage(
        'gmail:cs-old',
        'gmail',
        'gmail:jeff@example.com',
        'cs-old',
        'thread-recent',
        'sender1',
        'Old message',
        -(3 * 24 * 60 * 60 * 1000),
      );
      // 12 hours ago — should be included
      const at1 = seedRecentMessage(
        'gmail:cs-new1',
        'gmail',
        'gmail:jeff@example.com',
        'cs-new1',
        'thread-recent',
        'sender1',
        'Recent message 1',
        -(12 * 60 * 60 * 1000),
      );
      // 1 hour ago — should be included
      const at2 = seedRecentMessage(
        'gmail:cs-new2',
        'gmail',
        'gmail:jeff@example.com',
        'cs-new2',
        'thread-recent',
        'sender1',
        'Recent message 2',
        -(1 * 60 * 60 * 1000),
      );

      const result = getRecentMessages({ account_id: 'gmail:jeff@example.com' });
      const ids = result.messages.map((m) => m.message_id);
      expect(ids).not.toContain('gmail:cs-old');
      expect(ids).toContain('gmail:cs-new1');
      expect(ids).toContain('gmail:cs-new2');
      // Must not include the static seed messages from 2024 (those are 2+ years old)
      expect(ids).not.toContain('gmail:msg1');
      expect(ids).not.toContain('gmail:msg2');
    });

    it('cold-start returns correct new_watermark (Gmail = max received_at, Proton = max source_message_id)', () => {
      // Gmail: seed two recent messages; expect new_watermark = max received_at
      const at1 = seedRecentMessage(
        'gmail:cs-wm1',
        'gmail',
        'gmail:jeff@example.com',
        'cs-wm1',
        'thread-recent',
        'sender1',
        'WM test 1',
        -(12 * 60 * 60 * 1000),
      );
      const at2 = seedRecentMessage(
        'gmail:cs-wm2',
        'gmail',
        'gmail:jeff@example.com',
        'cs-wm2',
        'thread-recent',
        'sender1',
        'WM test 2',
        -(1 * 60 * 60 * 1000),
      );

      const gmailResult = getRecentMessages({ account_id: 'gmail:jeff@example.com' });
      const returnedAts = gmailResult.messages.map((m) => m.received_at);
      const expectedMax = returnedAts.reduce((a, b) => (a > b ? a : b));
      expect(gmailResult.new_watermark).toBe(expectedMax);

      // Proton: seed two recent messages; expect new_watermark = max source_message_id as string
      seedRecentMessage(
        'proton:cs-wm1',
        'protonmail',
        'proton:jeff@proton.me',
        '9001',
        'thread-proton-recent',
        'sender2',
        'Proton WM test 1',
        -(12 * 60 * 60 * 1000),
      );
      seedRecentMessage(
        'proton:cs-wm2',
        'protonmail',
        'proton:jeff@proton.me',
        '9002',
        'thread-proton-recent',
        'sender2',
        'Proton WM test 2',
        -(1 * 60 * 60 * 1000),
      );

      const protonResult = getRecentMessages({ account_id: 'proton:jeff@proton.me' });
      expect(protonResult.new_watermark).toBe('9002');
    });

    it('cold-start falls through to native semantics on second call (stored watermark self-heals)', () => {
      // Seed one recent gmail message
      const at1 = seedRecentMessage(
        'gmail:cs-heal1',
        'gmail',
        'gmail:jeff@example.com',
        'cs-heal1',
        'thread-recent',
        'sender1',
        'Heal test 1',
        -(6 * 60 * 60 * 1000),
      );

      // First cold-start call — establishes new_watermark
      const first = getRecentMessages({ account_id: 'gmail:jeff@example.com' });
      expect(first.messages.map((m) => m.message_id)).toContain('gmail:cs-heal1');

      // Simulate storing the emitted new_watermark (as the caller would do)
      db.prepare(
        `INSERT INTO watermarks(account_id, watermark_value, updated_at) VALUES (?,?,?)`,
      ).run('gmail:jeff@example.com', first.new_watermark, new Date().toISOString());

      // Seed a newer message after the watermark
      const at2 = seedRecentMessage(
        'gmail:cs-heal2',
        'gmail',
        'gmail:jeff@example.com',
        'cs-heal2',
        'thread-recent',
        'sender1',
        'Heal test 2',
        -(1 * 60 * 60 * 1000),
      );

      // Second call should use native semantics (stored watermark), not 24h cold-start
      const second = getRecentMessages({ account_id: 'gmail:jeff@example.com' });
      // Only the message newer than the stored watermark should appear
      expect(second.messages.map((m) => m.message_id)).toContain('gmail:cs-heal2');
      expect(second.messages.map((m) => m.message_id)).not.toContain('gmail:cs-heal1');
    });

    it('env override: INBOX_COLD_START_LOOKBACK_MS=3600000 limits to 1 hour', () => {
      process.env.INBOX_COLD_START_LOOKBACK_MS = '3600000';

      // 12 hours old — outside 1h window, excluded
      seedRecentMessage(
        'gmail:cs-env-old',
        'gmail',
        'gmail:jeff@example.com',
        'cs-env-old',
        'thread-recent',
        'sender1',
        'Env old message',
        -(12 * 60 * 60 * 1000),
      );
      // 30 minutes old — within 1h window, included
      seedRecentMessage(
        'gmail:cs-env-new',
        'gmail',
        'gmail:jeff@example.com',
        'cs-env-new',
        'thread-recent',
        'sender1',
        'Env new message',
        -(30 * 60 * 1000),
      );

      const result = getRecentMessages({ account_id: 'gmail:jeff@example.com' });
      const ids = result.messages.map((m) => m.message_id);
      expect(ids).not.toContain('gmail:cs-env-old');
      expect(ids).toContain('gmail:cs-env-new');
    });

    it('env override malformed: falls back to default 24h lookback', () => {
      process.env.INBOX_COLD_START_LOOKBACK_MS = 'not-a-number';

      // Verify getColdStartLookbackMs returns the default
      expect(getColdStartLookbackMs()).toBe(DEFAULT_COLD_START_LOOKBACK_MS);

      // 12 hours old — within 24h window, should be included
      seedRecentMessage(
        'gmail:cs-bad-env',
        'gmail',
        'gmail:jeff@example.com',
        'cs-bad-env',
        'thread-recent',
        'sender1',
        'Bad env message',
        -(12 * 60 * 60 * 1000),
      );

      const result = getRecentMessages({ account_id: 'gmail:jeff@example.com' });
      expect(result.messages.map((m) => m.message_id)).toContain('gmail:cs-bad-env');
    });

    afterEach(() => {
      delete process.env.INBOX_COLD_START_LOOKBACK_MS;
    });
  });
});
