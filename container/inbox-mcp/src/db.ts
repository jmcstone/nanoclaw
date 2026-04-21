import Database from 'better-sqlite3';

let db: Database.Database | null = null;

const INBOX_DB_KEY_HEX_LENGTH = 64;

function loadInboxDbKey(): string {
  const raw = process.env.INBOX_DB_KEY;
  if (!raw) {
    throw new Error(
      'INBOX_DB_KEY env var is required for inbox store access. ' +
        'The host orchestrator should pass this through for telegram_inbox containers.',
    );
  }
  if (!/^[0-9a-f]{64}$/i.test(raw)) {
    throw new Error(
      `INBOX_DB_KEY must be exactly ${INBOX_DB_KEY_HEX_LENGTH} hex chars (256-bit key).`,
    );
  }
  return raw.toLowerCase();
}

export function getInboxDb(): Database.Database {
  if (db) return db;
  const dbPath = process.env.INBOX_DB_PATH;
  if (!dbPath) throw new Error('INBOX_DB_PATH env var is required');
  const keyHex = loadInboxDbKey();
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma(`cipher = 'sqlcipher'`);
  db.pragma(`key = "x'${keyHex}'"`);
  db.pragma('query_only = true');
  return db;
}
