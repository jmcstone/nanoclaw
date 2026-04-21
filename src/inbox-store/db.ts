import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';

let db: Database.Database | undefined;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      account_id    TEXT PRIMARY KEY,
      source        TEXT NOT NULL,
      email_address TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS senders (
      sender_id     TEXT PRIMARY KEY,
      email_address TEXT NOT NULL UNIQUE,
      display_name  TEXT
    );

    CREATE TABLE IF NOT EXISTS threads (
      thread_id        TEXT PRIMARY KEY,
      source           TEXT NOT NULL,
      subject          TEXT,
      last_message_at  TEXT NOT NULL,
      message_count    INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_threads_last_message_at ON threads(last_message_at);

    CREATE TABLE IF NOT EXISTS messages (
      message_id        TEXT PRIMARY KEY,
      source            TEXT NOT NULL,
      account_id        TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      thread_id         TEXT NOT NULL,
      sender_id         TEXT NOT NULL,
      subject           TEXT,
      body_markdown     TEXT,
      received_at       TEXT NOT NULL,
      raw_headers_json  TEXT,
      UNIQUE(source, source_message_id),
      FOREIGN KEY (account_id) REFERENCES accounts(account_id),
      FOREIGN KEY (thread_id)  REFERENCES threads(thread_id),
      FOREIGN KEY (sender_id)  REFERENCES senders(sender_id)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_received_at ON messages(received_at);
    CREATE INDEX IF NOT EXISTS idx_messages_thread_id   ON messages(thread_id);

    CREATE TABLE IF NOT EXISTS watermarks (
      account_id      TEXT PRIMARY KEY,
      watermark_value TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(account_id)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      message_id UNINDEXED,
      subject,
      body_markdown,
      sender_address,
      tokenize = 'porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS trg_messages_fts_insert
    AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(message_id, subject, body_markdown, sender_address)
      VALUES (
        NEW.message_id,
        NEW.subject,
        NEW.body_markdown,
        (SELECT email_address FROM senders WHERE sender_id = NEW.sender_id)
      );
    END;

    CREATE TRIGGER IF NOT EXISTS trg_messages_fts_update
    AFTER UPDATE OF subject, body_markdown, sender_id ON messages BEGIN
      DELETE FROM messages_fts WHERE message_id = OLD.message_id;
      INSERT INTO messages_fts(message_id, subject, body_markdown, sender_address)
      VALUES (
        NEW.message_id,
        NEW.subject,
        NEW.body_markdown,
        (SELECT email_address FROM senders WHERE sender_id = NEW.sender_id)
      );
    END;

    CREATE TRIGGER IF NOT EXISTS trg_messages_fts_delete
    AFTER DELETE ON messages BEGIN
      DELETE FROM messages_fts WHERE message_id = OLD.message_id;
    END;
  `);
}

export function getInboxDb(): Database.Database {
  if (!db) {
    const dbPath = path.join(DATA_DIR, 'inbox', 'store.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  }
  return db;
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestInboxDb(): Database.Database {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  return db;
}

/** @internal - for tests only. */
export function _closeInboxDb(): void {
  if (db) {
    db.close();
    db = undefined;
  }
}
