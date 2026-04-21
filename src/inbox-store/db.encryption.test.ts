import { describe, it, expect, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Isolate these tests from the developer's real .env (which holds the
// production INBOX_DB_KEY). loadInboxDbKey falls back to readEnvFile if
// process.env is unset — in this suite we want process.env to be the
// sole source of truth.
vi.mock('../env.js', () => ({
  readEnvFile: () => ({}),
}));

import { loadInboxDbKey } from './db.js';

const VALID_KEY_A =
  'deadbeefcafefeeddeadbeefcafefeed' + 'deadbeefcafefeeddeadbeefcafefeed';
const VALID_KEY_B =
  '0123456789abcdef0123456789abcdef' + '0123456789abcdef0123456789abcdef';

const tempFiles: string[] = [];
function tempDbPath(): string {
  const p = path.join(
    os.tmpdir(),
    `inbox-encryption-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  tempFiles.push(p);
  return p;
}

afterEach(() => {
  for (const p of tempFiles.splice(0)) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* already gone */
    }
    // Clean up WAL / SHM siblings if they exist
    for (const ext of ['-wal', '-shm', '-journal']) {
      try {
        fs.unlinkSync(p + ext);
      } catch {
        /* ignore */
      }
    }
  }
  delete process.env.INBOX_DB_KEY;
});

describe('loadInboxDbKey', () => {
  it('throws a clear error when INBOX_DB_KEY is unset', () => {
    delete process.env.INBOX_DB_KEY;
    expect(() => loadInboxDbKey()).toThrow(/inbox-keygen/);
  });

  it('throws when key is not 64 hex chars', () => {
    process.env.INBOX_DB_KEY = 'too-short';
    expect(() => loadInboxDbKey()).toThrow(/64 hex chars/);
  });

  it('throws when key contains non-hex chars', () => {
    process.env.INBOX_DB_KEY = 'z'.repeat(64);
    expect(() => loadInboxDbKey()).toThrow(/64 hex chars/);
  });

  it('accepts a valid 64-char lowercase hex key and normalizes case', () => {
    process.env.INBOX_DB_KEY = VALID_KEY_A.toUpperCase();
    expect(loadInboxDbKey()).toBe(VALID_KEY_A);
  });
});

describe('SQLCipher round-trip on disk', () => {
  function open(dbPath: string, keyHex: string): Database.Database {
    const db = new Database(dbPath);
    db.pragma(`cipher = 'sqlcipher'`);
    db.pragma(`key = "x'${keyHex}'"`);
    return db;
  }

  it('round-trips data through close/reopen with the same key', () => {
    const p = tempDbPath();
    const a = open(p, VALID_KEY_A);
    a.exec('CREATE TABLE t (x TEXT)');
    a.prepare('INSERT INTO t VALUES (?)').run('hello');
    a.close();

    const b = open(p, VALID_KEY_A);
    expect(b.prepare('SELECT x FROM t').get()).toEqual({ x: 'hello' });
    b.close();
  });

  it('reopen without key fails with SQLITE_NOTADB', () => {
    const p = tempDbPath();
    const a = open(p, VALID_KEY_A);
    a.exec('CREATE TABLE t (x TEXT)');
    a.prepare('INSERT INTO t VALUES (?)').run('secret');
    a.close();

    expect(() => {
      const b = new Database(p);
      b.prepare('SELECT x FROM t').get();
    }).toThrow(/not a database|NOTADB/i);
  });

  it('reopen with wrong key fails with SQLITE_NOTADB', () => {
    const p = tempDbPath();
    const a = open(p, VALID_KEY_A);
    a.exec('CREATE TABLE t (x TEXT)');
    a.prepare('INSERT INTO t VALUES (?)').run('secret');
    a.close();

    expect(() => {
      const b = open(p, VALID_KEY_B);
      b.prepare('SELECT x FROM t').get();
    }).toThrow(/not a database|NOTADB/i);
  });

  it('FTS5 remains functional through the encryption layer', () => {
    const p = tempDbPath();
    const db = open(p, VALID_KEY_A);
    db.exec(`
      CREATE VIRTUAL TABLE ft USING fts5(subject, body, tokenize='porter unicode61');
    `);
    db.prepare('INSERT INTO ft VALUES (?, ?)').run(
      'Guardian invoice 9246',
      'Amount due: $42.00',
    );
    const row = db
      .prepare(`SELECT subject FROM ft WHERE ft MATCH 'invoice' LIMIT 1`)
      .get() as { subject: string } | undefined;
    expect(row?.subject).toBe('Guardian invoice 9246');
    db.close();
  });
});
