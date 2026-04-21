import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { _initTestInboxDb, _closeInboxDb, getInboxDb } from './db.js';
import { ingestMessage, type MessageIngestInput } from './ingest.js';
import { deriveProtonThreadId } from '../channels/protonmail.js';

function gmailMsg(
  overrides: Partial<MessageIngestInput> = {},
): MessageIngestInput {
  return {
    source: 'gmail',
    account_email: 'jeff@americanvoxpop.com',
    source_message_id: 'msg-001',
    thread_id: 'gmail:thread-001',
    sender_email: 'alice@example.com',
    sender_name: 'Alice',
    subject: 'Hello world',
    body_markdown: 'Hello **world**',
    received_at: '2026-01-01T10:00:00Z',
    ...overrides,
  };
}

function protonMsg(
  overrides: Partial<MessageIngestInput> & {
    references?: string[];
    in_reply_to?: string | null;
  } = {},
): MessageIngestInput {
  const {
    references = [],
    in_reply_to = null,
    thread_id,
    source_message_id = '<msg-001@proton.me>',
    ...rest
  } = overrides;
  return {
    source: 'protonmail',
    account_email: 'jeff@pm.me',
    sender_email: 'bob@example.com',
    sender_name: 'Bob',
    subject: 'Proton hello',
    body_markdown: 'Hello from **Proton**',
    received_at: '2026-01-01T11:00:00Z',
    ...rest,
    source_message_id,
    thread_id:
      thread_id ?? deriveProtonThreadId(references, in_reply_to, source_message_id),
  };
}

beforeEach(() => {
  _initTestInboxDb();
});

afterEach(() => {
  _closeInboxDb();
});

describe('ingestMessage — Gmail shape', () => {
  it('insert creates all four rows', () => {
    const { message_id, inserted } = ingestMessage(gmailMsg());
    expect(inserted).toBe(true);
    expect(message_id).toBe('gmail:msg-001');

    const db = getInboxDb();
    expect(
      db
        .prepare('SELECT * FROM accounts WHERE account_id = ?')
        .get('gmail:jeff@americanvoxpop.com'),
    ).toBeTruthy();
    expect(
      db
        .prepare('SELECT * FROM senders WHERE email_address = ?')
        .get('alice@example.com'),
    ).toBeTruthy();
    expect(
      db
        .prepare('SELECT * FROM threads WHERE thread_id = ?')
        .get('gmail:thread-001'),
    ).toBeTruthy();
    expect(
      db
        .prepare('SELECT * FROM messages WHERE message_id = ?')
        .get('gmail:msg-001'),
    ).toBeTruthy();
  });

  it('re-ingesting the same message returns inserted:false and same message_id', () => {
    const first = ingestMessage(gmailMsg());
    const second = ingestMessage(gmailMsg());
    expect(first.message_id).toBe(second.message_id);
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);

    const db = getInboxDb();
    const count = (
      db.prepare('SELECT count(*) as c FROM messages').get() as { c: number }
    ).c;
    expect(count).toBe(1);
  });

  it('two messages in the same thread produce message_count = 2', () => {
    ingestMessage(gmailMsg({ source_message_id: 'msg-001' }));
    ingestMessage(gmailMsg({ source_message_id: 'msg-002' }));

    const db = getInboxDb();
    const thread = db
      .prepare('SELECT * FROM threads WHERE thread_id = ?')
      .get('gmail:thread-001') as { message_count: number };
    expect(thread.message_count).toBe(2);
  });

  it('last_message_at reflects the latest received_at even on out-of-order insert', () => {
    ingestMessage(
      gmailMsg({
        source_message_id: 'msg-late',
        received_at: '2026-01-05T10:00:00Z',
      }),
    );
    ingestMessage(
      gmailMsg({
        source_message_id: 'msg-early',
        received_at: '2026-01-01T08:00:00Z',
      }),
    );

    const db = getInboxDb();
    const thread = db
      .prepare(
        'SELECT last_message_at, message_count FROM threads WHERE thread_id = ?',
      )
      .get('gmail:thread-001') as {
      last_message_at: string;
      message_count: number;
    };
    expect(thread.last_message_at).toBe('2026-01-05T10:00:00Z');
    expect(thread.message_count).toBe(2);
  });

  it('round-trip: all fields intact + FTS match on subject token', () => {
    ingestMessage(
      gmailMsg({
        subject: 'Roundtrip verification test',
        body_markdown: 'Body text here',
        raw_headers_json: '{"X-Foo":"bar"}',
      }),
    );

    const db = getInboxDb();
    const msg = db
      .prepare('SELECT * FROM messages WHERE message_id = ?')
      .get('gmail:msg-001') as Record<string, unknown>;
    expect(msg.source).toBe('gmail');
    expect(msg.subject).toBe('Roundtrip verification test');
    expect(msg.body_markdown).toBe('Body text here');
    expect(msg.raw_headers_json).toBe('{"X-Foo":"bar"}');
    expect(msg.received_at).toBe('2026-01-01T10:00:00Z');

    const ftsResult = db
      .prepare(
        `SELECT message_id FROM messages_fts WHERE messages_fts MATCH 'verification'`,
      )
      .all() as Array<{ message_id: string }>;
    expect(ftsResult.some((r) => r.message_id === 'gmail:msg-001')).toBe(true);
  });
});

describe('deriveProtonThreadId', () => {
  it('no references + no in_reply_to uses own id', () => {
    expect(deriveProtonThreadId([], null, '<msg-001@proton.me>')).toBe(
      'proton:<msg-001@proton.me>',
    );
  });
  it('in_reply_to (no references) uses in_reply_to', () => {
    expect(deriveProtonThreadId([], '<msg-001@proton.me>', '<msg-002@proton.me>')).toBe(
      'proton:<msg-001@proton.me>',
    );
  });
  it('references uses the first entry', () => {
    expect(
      deriveProtonThreadId(['<a>', '<b>', '<c>'], '<b>', '<msg-003@proton.me>'),
    ).toBe('proton:<a>');
  });
  it('empty-string entries in references are skipped', () => {
    expect(
      deriveProtonThreadId(['', '<real@id>'], null, '<msg@id>'),
    ).toBe('proton:<real@id>');
  });
});

describe('ingestMessage — Proton shape (threads via deriveProtonThreadId)', () => {
  it('no-references + no-in_reply_to lands on own-id thread', () => {
    ingestMessage(protonMsg());
    const db = getInboxDb();
    const msg = db
      .prepare('SELECT thread_id FROM messages WHERE message_id = ?')
      .get('protonmail:<msg-001@proton.me>') as { thread_id: string };
    expect(msg.thread_id).toBe('proton:<msg-001@proton.me>');
  });

  it('two messages with the same references root share a thread', () => {
    ingestMessage(
      protonMsg({
        source_message_id: '<msg-002@proton.me>',
        references: ['<root@proton.me>'],
      }),
    );
    ingestMessage(
      protonMsg({
        source_message_id: '<msg-003@proton.me>',
        references: ['<root@proton.me>', '<msg-002@proton.me>'],
      }),
    );

    const db = getInboxDb();
    const thread = db
      .prepare('SELECT * FROM threads WHERE thread_id = ?')
      .get('proton:<root@proton.me>') as { message_count: number };
    expect(thread.message_count).toBe(2);
  });

  it('Gmail and Protonmail messages with same subject never share a thread', () => {
    ingestMessage(
      gmailMsg({ subject: 'Shared subject', thread_id: 'gmail:shared-root' }),
    );
    ingestMessage(
      protonMsg({
        subject: 'Shared subject',
        source_message_id: 'shared-root',
      }),
    );

    const db = getInboxDb();
    const gmailThread = db
      .prepare('SELECT thread_id FROM messages WHERE source = ?')
      .get('gmail') as { thread_id: string };
    const protonThread = db
      .prepare('SELECT thread_id FROM messages WHERE source = ?')
      .get('protonmail') as { thread_id: string };
    expect(gmailThread.thread_id).not.toBe(protonThread.thread_id);
    expect(gmailThread.thread_id.startsWith('gmail:')).toBe(true);
    expect(protonThread.thread_id.startsWith('proton:')).toBe(true);
  });
});
